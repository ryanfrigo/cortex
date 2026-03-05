import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemoryEngine } from '../src/engine.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB = join(tmpdir(), `cortex-consolidation-test-${Date.now()}`);

describe('consolidation', () => {
  let engine: MemoryEngine;

  beforeAll(async () => {
    mkdirSync(TEST_DB, { recursive: true });
    engine = new MemoryEngine(TEST_DB);
    // Save near-duplicate memories
    await engine.save({ content: 'User had oatmeal for breakfast on Monday morning', namespace: 'health' });
    await engine.save({ content: 'User ate oatmeal for breakfast on Monday', namespace: 'health' });
    await engine.save({ content: 'User had oatmeal Monday morning for breakfast', namespace: 'health' });
    // Save a different memory
    await engine.save({ content: 'MyApp uses Next.js and Convex for the backend', namespace: 'projects' });
  });

  afterAll(() => {
    engine.close();
    try { rmSync(TEST_DB, { recursive: true, force: true }); } catch {}
  });

  it('dry run finds clusters of similar memories', async () => {
    const result = await engine.consolidate({ dryRun: true, similarityThreshold: 0.85, minClusterSize: 2 });
    // The three oatmeal memories should cluster
    expect(result.clusters.length).toBeGreaterThanOrEqual(1);
    const oatmealCluster = result.clusters.find(c => c.contents.some(s => s.includes('oatmeal')));
    expect(oatmealCluster).toBeDefined();
    expect(oatmealCluster!.ids.length).toBeGreaterThanOrEqual(2);
  });

  it('does not cluster dissimilar memories', async () => {
    const result = await engine.consolidate({ dryRun: true, similarityThreshold: 0.85, minClusterSize: 2 });
    // MyApp memory should not be in the oatmeal cluster
    for (const cluster of result.clusters) {
      const hasOatmeal = cluster.contents.some(c => c.includes('oatmeal'));
      const hasMyApp = cluster.contents.some(c => c.includes('MyApp'));
      expect(hasOatmeal && hasMyApp).toBe(false);
    }
  });

  it('actual consolidation reduces memory count', async () => {
    const statsBefore = await engine.stats();
    await engine.consolidate({ dryRun: false, similarityThreshold: 0.85, minClusterSize: 2 });
    const statsAfter = await engine.stats();
    // Should have fewer memories after consolidation (merged cluster - originals + 1 consolidated)
    expect(statsAfter.totalMemories).toBeLessThan(statsBefore.totalMemories);
  });
});
