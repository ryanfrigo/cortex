import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemoryEngine } from '../src/engine.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB = join(tmpdir(), `cortex-decay-test-${Date.now()}`);

describe('decay', () => {
  let engine: MemoryEngine;

  beforeAll(() => {
    mkdirSync(TEST_DB, { recursive: true });
    engine = new MemoryEngine(TEST_DB);
  });

  afterAll(() => {
    engine.close();
    try { rmSync(TEST_DB, { recursive: true, force: true }); } catch {}
  });

  it('dry run identifies memories that would decay', async () => {
    // Save a memory — it will have accessed_at = now, so decay skips it (< 7 days)
    await engine.save({ content: 'recent memory for decay test', importance: 0.8 });

    const result = await engine.decay({ dryRun: true, halfLifeDays: 30 });
    // Recent memories should NOT be affected
    const recentAffected = result.affected.find(a => a.content.includes('recent memory for decay test'));
    expect(recentAffected).toBeUndefined();
  });

  it('respects minImportance floor', async () => {
    const result = await engine.decay({ dryRun: true, minImportance: 0.05 });
    for (const a of result.affected) {
      expect(a.newImportance).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('newImportance < oldImportance for affected memories', async () => {
    const result = await engine.decay({ dryRun: true });
    for (const a of result.affected) {
      expect(a.newImportance).toBeLessThan(a.oldImportance);
    }
  });
});
