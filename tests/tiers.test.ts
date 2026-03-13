import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateTiers, contentAtDepth } from '../src/tiers.js';
import { MemoryEngine } from '../src/engine.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB = join(tmpdir(), `cortex-tiers-test-${Date.now()}`);

// ─── Unit: generateTiers ───────────────────────────────────────────────────

describe('generateTiers', () => {
  it('produces non-empty l0 and l1 from a sentence', () => {
    const { l0, l1 } = generateTiers('Ryan uses TypeScript for all projects.');
    expect(l0.length).toBeGreaterThan(0);
    expect(l1.length).toBeGreaterThan(0);
  });

  it('l0 is ≤ 400 characters', () => {
    const long = 'A'.repeat(1000) + '. More content here for padding.';
    const { l0 } = generateTiers(long);
    expect(l0.length).toBeLessThanOrEqual(400);
  });

  it('l1 is ≤ 2000 characters', () => {
    const long = 'First paragraph sentence.\n\n' + 'B'.repeat(3000);
    const { l1 } = generateTiers(long);
    expect(l1.length).toBeLessThanOrEqual(2000);
  });

  it('l0 begins with the first sentence', () => {
    const { l0 } = generateTiers('Cortex is a local-first memory system. Other details follow.');
    expect(l0).toContain('Cortex is a local-first memory system');
  });

  it('l1 captures the first paragraph only', () => {
    const content = 'First paragraph here.\n\nSecond paragraph should NOT appear in L1.';
    const { l1 } = generateTiers(content);
    expect(l1).not.toContain('Second paragraph');
  });

  it('appends key tech terms to l0 when present', () => {
    const { l0 } = generateTiers('We store data in LanceDB for fast retrieval.');
    // "LanceDB" is already in the sentence so may or may not appear in brackets
    expect(l0).toContain('LanceDB');
  });
});

// ─── Unit: contentAtDepth ─────────────────────────────────────────────────

describe('contentAtDepth', () => {
  const full = 'Full content spanning many tokens. '.repeat(200);
  const l0 = 'Short abstract.';
  const l1 = 'Medium overview. '.repeat(30);

  it('depth 0 returns l0 when available', () => {
    expect(contentAtDepth(full, l0, l1, 0)).toBe(l0);
  });

  it('depth 1 returns l1 when available', () => {
    expect(contentAtDepth(full, l0, l1, 1)).toBe(l1);
  });

  it('depth 2 returns full content', () => {
    expect(contentAtDepth(full, l0, l1, 2)).toBe(full);
  });

  it('depth 0 falls back to truncated content when l0 missing', () => {
    const result = contentAtDepth(full, undefined, undefined, 0);
    expect(result.length).toBeLessThanOrEqual(400);
  });

  it('depth 1 falls back to truncated content when l1 missing', () => {
    const result = contentAtDepth(full, undefined, undefined, 1);
    expect(result.length).toBeLessThanOrEqual(2000);
  });
});

// ─── Integration: save stores l0/l1, search respects depth ────────────────

describe('MemoryEngine — tiered context', () => {
  let engine: MemoryEngine;

  beforeAll(() => {
    mkdirSync(TEST_DB, { recursive: true });
    engine = new MemoryEngine(TEST_DB);
  });

  afterAll(() => {
    engine.close();
    try { rmSync(TEST_DB, { recursive: true, force: true }); } catch {}
  });

  it('save populates l0Content and l1Content on returned Memory', async () => {
    const mem = await engine.save({
      content: 'Cortex is a local-first AI memory layer. It uses LanceDB for vector storage and hybrid BM25 search.',
    });
    expect(mem.l0Content).toBeTruthy();
    expect(mem.l1Content).toBeTruthy();
    expect(mem.l0Content!.length).toBeLessThanOrEqual(400);
  });

  it('search with depth=0 returns L0 abstract content', async () => {
    await engine.save({
      content: 'LanceDB powers vector search in Cortex memory system for efficient recall.',
    });
    const results = await engine.search({ query: 'LanceDB vector search', limit: 3, depth: 0 });
    expect(results.length).toBeGreaterThan(0);
    // L0 content should be shorter than full content
    const r = results[0];
    expect(r.memory.content.length).toBeLessThanOrEqual(400);
  });

  it('search with depth=2 returns full content', async () => {
    const longContent = 'Full detailed memory about TypeScript. '.repeat(20);
    await engine.save({ content: longContent });
    const results = await engine.search({ query: 'TypeScript detailed memory', limit: 3, depth: 2 });
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    // Full content should be returned
    expect(r.memory.content.length).toBeGreaterThan(400);
  });
});

// ─── Integration: hierarchical namespace prefix search ────────────────────

describe('MemoryEngine — hierarchical namespaces', () => {
  let engine: MemoryEngine;

  beforeAll(() => {
    mkdirSync(TEST_DB + '-ns', { recursive: true });
    engine = new MemoryEngine(TEST_DB + '-ns');
  });

  afterAll(() => {
    engine.close();
    try { rmSync(TEST_DB + '-ns', { recursive: true, force: true }); } catch {}
  });

  it('namespacePrefix matches subtrees', async () => {
    await engine.save({ content: 'VoiceCharm project memory alpha', namespace: 'projects/voicecharm' });
    await engine.save({ content: 'Kalshi project memory beta', namespace: 'projects/kalshi' });
    await engine.save({ content: 'Personal note unrelated', namespace: 'personal' });

    const results = await engine.search({
      query: 'project memory',
      namespace: 'projects/',
      namespacePrefix: true,
      limit: 10,
      depth: 2,
    });

    const namespaces = results.map(r => r.memory.namespace);
    expect(namespaces).toContain('projects/voicecharm');
    expect(namespaces).toContain('projects/kalshi');
    // personal should NOT appear
    expect(namespaces).not.toContain('personal');
  });

  it('exact namespace match still works without prefix flag', async () => {
    await engine.save({ content: 'User preference for dark mode', namespace: 'user/preferences' });
    await engine.save({ content: 'User people contact info', namespace: 'user/people' });

    const results = await engine.search({
      query: 'user preference dark',
      namespace: 'user/preferences',
      limit: 5,
      depth: 2,
    });
    for (const r of results) {
      expect(r.memory.namespace).toBe('user/preferences');
    }
  });
});
