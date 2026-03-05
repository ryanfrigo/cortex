import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemoryEngine, contentHash } from '../src/engine.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB = join(tmpdir(), `cortex-test-${Date.now()}`);

describe('MemoryEngine', () => {
  let engine: MemoryEngine;

  beforeAll(() => {
    mkdirSync(TEST_DB, { recursive: true });
    engine = new MemoryEngine(TEST_DB);
  });

  afterAll(() => {
    engine.close();
    try { rmSync(TEST_DB, { recursive: true, force: true }); } catch {}
  });

  describe('save & get', () => {
    it('saves a memory and retrieves it by id', async () => {
      const mem = await engine.save({
        content: 'Ryan loves building AI tools',
        namespace: 'personal',
        type: 'fact',
        importance: 0.8,
        tags: ['identity'],
      });
      expect(mem.id).toBeTruthy();
      expect(mem.content).toBe('Ryan loves building AI tools');
      expect(mem.namespace).toBe('personal');

      const retrieved = await engine.get(mem.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe('Ryan loves building AI tools');
    });

    it('returns null for non-existent id', async () => {
      const result = await engine.get('non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('search', () => {
    it('finds saved memories by semantic search', async () => {
      await engine.save({ content: 'The weather in San Francisco is foggy today', namespace: 'daily' });
      const results = await engine.search({ query: 'SF weather', limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      const found = results.some(r => r.memory.content.includes('foggy'));
      expect(found).toBe(true);
    });

    it('filters by namespace', async () => {
      await engine.save({ content: 'test namespace filtering alpha', namespace: 'alpha-ns' });
      await engine.save({ content: 'test namespace filtering beta', namespace: 'beta-ns' });

      const alphaResults = await engine.search({ query: 'namespace filtering', namespace: 'alpha-ns', limit: 10 });
      for (const r of alphaResults) {
        expect(r.memory.namespace).toBe('alpha-ns');
      }
    });

    it('filters by type', async () => {
      await engine.save({ content: 'a decision about architecture', type: 'decision' });
      await engine.save({ content: 'a lesson about testing', type: 'lesson' });

      const results = await engine.search({ query: 'architecture', type: 'decision', limit: 10 });
      for (const r of results) {
        expect(r.memory.type).toBe('decision');
      }
    });

    it('returns scores with results', async () => {
      const results = await engine.search({ query: 'AI tools', limit: 3 });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
        expect(typeof r.vectorScore).toBe('number');
        expect(typeof r.bm25Score).toBe('number');
      }
    });
  });

  describe('update', () => {
    it('updates content of existing memory', async () => {
      const mem = await engine.save({ content: 'original content here', namespace: 'test' });
      const updated = await engine.update(mem.id, { content: 'updated content here' });
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe('updated content here');
    });

    it('returns null for non-existent id', async () => {
      const result = await engine.update('non-existent', { content: 'x' });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes a memory', async () => {
      const mem = await engine.save({ content: 'to be deleted' });
      expect(await engine.delete(mem.id)).toBe(true);
      expect(await engine.get(mem.id)).toBeNull();
    });

    it('returns false for non-existent id', async () => {
      expect(await engine.delete('non-existent')).toBe(false);
    });
  });

  describe('deleteBatch', () => {
    it('deletes multiple memories', async () => {
      const m1 = await engine.save({ content: 'batch delete 1' });
      const m2 = await engine.save({ content: 'batch delete 2' });
      const count = await engine.deleteBatch([m1.id, m2.id]);
      expect(count).toBe(2);
    });
  });

  describe('saveBatch', () => {
    it('saves multiple memories', async () => {
      const count = await engine.saveBatch([
        { content: 'batch item 1' },
        { content: 'batch item 2' },
        { content: 'batch item 3' },
      ]);
      expect(count).toBe(3);
    });
  });

  describe('stats', () => {
    it('returns memory statistics', async () => {
      const stats = await engine.stats();
      expect(stats.totalMemories).toBeGreaterThan(0);
      expect(typeof stats.dbSizeBytes).toBe('number');
    });
  });
});

describe('contentHash', () => {
  it('produces consistent hashes', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
  });

  it('trims whitespace', () => {
    expect(contentHash('  hello  ')).toBe(contentHash('hello'));
  });

  it('different content → different hash', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});
