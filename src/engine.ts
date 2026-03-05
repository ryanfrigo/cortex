import { Index, type Connection, type Table } from '@lancedb/lancedb';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { initDatabase, getDefaultDbPath, getOrCreateTable } from './schema.js';
import { embed } from './embeddings.js';
import { computeRecencyScore, computeHybridScore, normalizeBm25Scores } from './scoring.js';
import type { Memory, MemoryInput, MemoryType, SearchOptions, SearchResult, MemoryStats, MemoryMetadata } from './types.js';
import { statSync, readdirSync } from 'fs';
import { join } from 'path';

/** Cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

/** SHA-256 hash of content string, used for dedup */
export function contentHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

export class MemoryEngine {
  private dbPath: string;
  private dbPromise: Promise<Connection>;
  private tablePromise: Promise<Table> | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? getDefaultDbPath();
    this.dbPromise = initDatabase(this.dbPath);
  }

  private async table(): Promise<Table> {
    if (!this.tablePromise) {
      this.tablePromise = this.dbPromise.then(db => getOrCreateTable(db));
    }
    return this.tablePromise;
  }

  async save(input: MemoryInput, rebuildFts = true): Promise<Memory> {
    const now = new Date().toISOString();
    const id = uuidv4();
    const namespace = input.namespace ?? 'general';
    const type = input.type ?? 'semantic';
    const importance = input.importance ?? 0.5;
    const source = input.source ?? 'cli';
    const tags = input.tags ?? [];
    const metadata = input.metadata ?? {};

    const embedding = await embed(input.content);
    const tbl = await this.table();

    await tbl.add([{
      id,
      namespace,
      type,
      content: input.content,
      importance,
      source,
      tags: JSON.stringify(tags),
      metadata: JSON.stringify(metadata),
      created_at: now,
      updated_at: now,
      accessed_at: now,
      access_count: 0,
      vector: Array.from(embedding),
    }]);

    if (rebuildFts) {
      try {
        await tbl.createIndex('content', { config: Index.fts(), replace: true });
      } catch { /* ignore */ }
    }

    return {
      id, namespace, type, content: input.content, embedding, importance, source, tags, metadata,
      createdAt: now, updatedAt: now, accessedAt: now, accessCount: 0,
    };
  }

  async rebuildFtsIndex(): Promise<void> {
    const tbl = await this.table();
    try {
      await tbl.createIndex('content', { config: Index.fts(), replace: true });
    } catch { /* ignore */ }
  }

  async getExistingContentHashes(): Promise<Set<string>> {
    const tbl = await this.table();
    const hashes = new Set<string>();
    try {
      const rows = await tbl.query().select(['content']).toArray();
      for (const r of rows) {
        hashes.add(contentHash(r.content));
      }
    } catch { /* empty table */ }
    return hashes;
  }

  async saveBatch(inputs: MemoryInput[], dedup = false): Promise<number> {
    const tbl = await this.table();
    const now = new Date().toISOString();
    let count = 0;
    let skipped = 0;

    const existingHashes = dedup ? await this.getExistingContentHashes() : new Set<string>();
    if (dedup) {
      console.log(`  Dedup enabled: ${existingHashes.size} existing content hashes loaded`);
    }

    const batchSize = 50;
    for (let i = 0; i < inputs.length; i += batchSize) {
      const batch = inputs.slice(i, i + batchSize);
      const rows = [];
      for (const input of batch) {
        if (dedup) {
          const hash = contentHash(input.content);
          if (existingHashes.has(hash)) { skipped++; continue; }
          existingHashes.add(hash);
        }

        const embedding = await embed(input.content);
        rows.push({
          id: uuidv4(),
          namespace: input.namespace ?? 'general',
          type: input.type ?? 'semantic',
          content: input.content,
          importance: input.importance ?? 0.5,
          source: input.source ?? 'cli',
          tags: JSON.stringify(input.tags ?? []),
          metadata: JSON.stringify(input.metadata ?? {}),
          created_at: now,
          updated_at: now,
          accessed_at: now,
          access_count: 0,
          vector: Array.from(embedding),
        });
      }
      if (rows.length > 0) await tbl.add(rows);
      count += rows.length;
      process.stdout.write(`  Saved ${count}/${inputs.length} (skipped ${skipped} dupes)\r`);
    }

    console.log();
    if (skipped > 0) console.log(`  Dedup: skipped ${skipped} duplicate memories`);
    await this.rebuildFtsIndex();
    return count;
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    const tbl = await this.table();
    const queryEmbedding = await embed(options.query);

    // When filtering by type, we need more candidates since most will be filtered out
    const searchMultiplier = options.type ? 20 : 3;
    let vecResults: any[];
    try {
      vecResults = await tbl.search(Array.from(queryEmbedding)).limit(limit * searchMultiplier).toArray();
    } catch { vecResults = []; }

    if (vecResults.length === 0) return [];

    const vecScoreMap = new Map(vecResults.map(r => [r.id, 1 / (1 + r._distance)]));

    const bm25Map = new Map<string, number>();
    try {
      const ftsResults = await tbl.search(options.query, 'fts').limit(limit * 3).toArray();
      if (ftsResults.length > 0) {
        const rawScores = ftsResults.map(r => r._score ?? 1);
        const normalized = normalizeBm25Scores(rawScores);
        ftsResults.forEach((r: any, i: number) => bm25Map.set(r.id, normalized[i]));
      }
    } catch { /* FTS might not be available */ }

    const results: SearchResult[] = vecResults
      .filter(m => {
        if (options.namespace && (m.namespace ?? 'general') !== options.namespace) return false;
        if (options.type && m.type !== options.type) return false;
        if (options.minImportance && m.importance < options.minImportance) return false;
        if (options.tags?.length) {
          const memTags = JSON.parse(m.tags) as string[];
          if (!options.tags.some(t => memTags.includes(t))) return false;
        }
        if (options.project) {
          try {
            const meta = JSON.parse(m.metadata || '{}');
            if (meta.project && meta.project !== options.project) return false;
          } catch { /* ignore */ }
        }
        return true;
      })
      .map(m => {
        const vectorScore = vecScoreMap.get(m.id) ?? 0;
        const bm25Score = bm25Map.get(m.id) ?? 0;
        const recencyScore = computeRecencyScore(m.accessed_at);
        const importanceScore = m.importance;
        const score = computeHybridScore(vectorScore, bm25Score, recencyScore, importanceScore, m.access_count ?? 0, m.type as MemoryType);

        return {
          memory: this.rowToMemory(m),
          score, vectorScore, bm25Score, recencyScore, importanceScore,
        };
      });

    results.sort((a, b) => b.score - a.score);

    const topResults = results.slice(0, limit);
    const now = new Date().toISOString();
    for (const r of topResults) {
      try {
        await tbl.update({
          where: `id = '${r.memory.id}'`,
          values: { accessed_at: now, access_count: (r.memory.accessCount + 1) + '' },
        });
      } catch { /* ignore */ }
    }

    return topResults;
  }

  async get(id: string): Promise<Memory | null> {
    const tbl = await this.table();
    try {
      const results = await tbl.query().where(`id = '${id}'`).limit(1).toArray();
      return results.length > 0 ? this.rowToMemory(results[0]) : null;
    } catch { return null; }
  }

  async getAll(): Promise<Memory[]> {
    const tbl = await this.table();
    try {
      const rows = await tbl.query().toArray();
      return rows.map(r => this.rowToMemory(r));
    } catch { return []; }
  }

  async update(id: string, updates: Partial<MemoryInput>): Promise<Memory | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const tbl = await this.table();
    const now = new Date().toISOString();
    const content = updates.content ?? existing.content;
    const namespace = updates.namespace ?? existing.namespace;
    const type = updates.type ?? existing.type;
    const importance = updates.importance ?? existing.importance;
    const tags = updates.tags ?? existing.tags;
    const metadata = updates.metadata ?? existing.metadata ?? {};

    await tbl.delete(`id = '${id}'`);
    const embedding = await embed(content);

    await tbl.add([{
      id,
      namespace,
      type,
      content,
      importance,
      source: existing.source,
      tags: JSON.stringify(tags),
      metadata: JSON.stringify(metadata),
      created_at: existing.createdAt,
      updated_at: now,
      accessed_at: existing.accessedAt,
      access_count: existing.accessCount,
      vector: Array.from(embedding),
    }]);

    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const tbl = await this.table();
    try {
      const existing = await tbl.query().where(`id = '${id}'`).limit(1).toArray();
      if (existing.length === 0) return false;
      await tbl.delete(`id = '${id}'`);
      return true;
    } catch { return false; }
  }

  async deleteBatch(ids: string[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (await this.delete(id)) deleted++;
    }
    return deleted;
  }

  async stats(): Promise<MemoryStats> {
    const tbl = await this.table();
    let rows: any[];
    try { rows = await tbl.query().toArray(); } catch { rows = []; }

    const byType: Record<string, number> = {};
    const byNamespace: Record<string, number> = {};
    let oldest: string | null = null;
    let newest: string | null = null;

    for (const r of rows) {
      const t = r.type as string;
      byType[t] = (byType[t] ?? 0) + 1;
      const ns = (r.namespace as string) || 'general';
      byNamespace[ns] = (byNamespace[ns] ?? 0) + 1;
      if (!oldest || r.created_at < oldest) oldest = r.created_at;
      if (!newest || r.created_at > newest) newest = r.created_at;
    }

    let dbSizeBytes = 0;
    try {
      const calcSize = (dir: string): number => {
        let size = 0;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) size += calcSize(p);
          else try { size += statSync(p).size; } catch { /* */ }
        }
        return size;
      };
      dbSizeBytes = calcSize(this.dbPath);
    } catch { /* */ }

    return { totalMemories: rows.length, byType, byNamespace, dbSizeBytes, oldestMemory: oldest, newestMemory: newest };
  }

  /** Get top memories by access count and importance for reflection */
  async reflect(): Promise<{ mostAccessed: Memory[]; highestImportance: Memory[] }> {
    const all = await this.getAll();
    const byAccess = [...all].sort((a, b) => b.accessCount - a.accessCount).slice(0, 10);
    const byImportance = [...all].sort((a, b) => b.importance - a.importance).slice(0, 10);
    return { mostAccessed: byAccess, highestImportance: byImportance };
  }

  /** Apply decay: reduce importance of unaccessed memories over time */
  async decay(options: { dryRun?: boolean; halfLifeDays?: number; minImportance?: number }): Promise<{ affected: Array<{ id: string; content: string; oldImportance: number; newImportance: number }> }> {
    const halfLife = options.halfLifeDays ?? 30;
    const minImp = options.minImportance ?? 0.05;
    const all = await this.getAll();
    const now = Date.now();
    const affected: Array<{ id: string; content: string; oldImportance: number; newImportance: number }> = [];

    for (const m of all) {
      const daysSinceAccess = (now - new Date(m.accessedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceAccess < 7) continue; // Skip recently accessed
      const decayFactor = Math.exp(-0.693 * daysSinceAccess / halfLife);
      const newImportance = Math.max(minImp, +(m.importance * decayFactor).toFixed(3));
      if (newImportance < m.importance - 0.01) {
        affected.push({ id: m.id, content: m.content, oldImportance: m.importance, newImportance });
      }
    }

    if (!options.dryRun) {
      const tbl = await this.table();
      for (const a of affected) {
        try {
          await tbl.update({ where: `id = '${a.id}'`, values: { importance: a.newImportance + '' } });
        } catch { /* ignore */ }
      }
    }

    return { affected };
  }

  /** Consolidate similar memories into summaries */
  async consolidate(options: { dryRun?: boolean; similarityThreshold?: number; minClusterSize?: number }): Promise<{ clusters: Array<{ ids: string[]; contents: string[] }> }> {
    const threshold = options.similarityThreshold ?? 0.85;
    const minSize = options.minClusterSize ?? 2;
    const tbl = await this.table();
    const all = await this.getAll();
    if (all.length < minSize) return { clusters: [] };

    // Get embeddings for all memories
    const rows = await tbl.query().toArray();
    const idToVector = new Map<string, number[]>();
    for (const r of rows) {
      idToVector.set(r.id, Array.from(r.vector as Float32Array));
    }

    // Find clusters using greedy approach
    const used = new Set<string>();
    const clusters: Array<{ ids: string[]; contents: string[]; namespaces: string[] }> = [];

    for (const m of all) {
      if (used.has(m.id)) continue;
      const vec = idToVector.get(m.id);
      if (!vec) continue;

      const cluster = [m];
      used.add(m.id);

      for (const other of all) {
        if (used.has(other.id)) continue;
        const otherVec = idToVector.get(other.id);
        if (!otherVec) continue;

        const sim = cosineSimilarity(vec, otherVec);
        if (sim >= threshold) {
          cluster.push(other);
          used.add(other.id);
        }
      }

      if (cluster.length >= minSize) {
        clusters.push({
          ids: cluster.map(c => c.id),
          contents: cluster.map(c => c.content),
          namespaces: cluster.map(c => c.namespace),
        });
      }
    }

    if (!options.dryRun) {
      for (const cluster of clusters) {
        // Create consolidated memory
        const combined = cluster.contents.join('\n---\n');
        const summaryContent = combined.length > 500
          ? combined.slice(0, 500) + `\n[consolidated from ${cluster.ids.length} memories]`
          : combined;
        const ns = cluster.namespaces[0] || 'general';
        await this.save({
          content: summaryContent,
          namespace: ns,
          type: 'semantic',
          importance: 0.7,
          source: 'consolidation',
          metadata: { supersededIds: cluster.ids },
        });
        // Delete originals
        await this.deleteBatch(cluster.ids);
      }
    }

    return { clusters: clusters.map(c => ({ ids: c.ids, contents: c.contents })) };
  }

  /** Audit: find duplicates, orphans, stale memories */
  async audit(): Promise<{
    duplicates: Array<{ ids: string[]; similarity: number; content: string }>;
    stale: Memory[];
    namespaceDistribution: Record<string, number>;
    totalMemories: number;
  }> {
    const tbl = await this.table();
    const all = await this.getAll();
    const rows = await tbl.query().toArray();
    const idToVector = new Map<string, number[]>();
    for (const r of rows) {
      idToVector.set(r.id, Array.from(r.vector as Float32Array));
    }

    // Find near-duplicates (cosine sim > 0.95)
    const duplicates: Array<{ ids: string[]; similarity: number; content: string }> = [];
    const dupSeen = new Set<string>();
    for (let i = 0; i < all.length; i++) {
      if (dupSeen.has(all[i].id)) continue;
      const vec = idToVector.get(all[i].id);
      if (!vec) continue;
      for (let j = i + 1; j < all.length; j++) {
        if (dupSeen.has(all[j].id)) continue;
        const otherVec = idToVector.get(all[j].id);
        if (!otherVec) continue;
        const sim = cosineSimilarity(vec, otherVec);
        if (sim > 0.95) {
          duplicates.push({ ids: [all[i].id, all[j].id], similarity: sim, content: all[i].content.slice(0, 80) });
          dupSeen.add(all[j].id);
        }
      }
    }

    // Stale: not accessed in 60+ days, low importance
    const now = Date.now();
    const stale = all.filter(m => {
      const daysSince = (now - new Date(m.accessedAt).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince > 60 && m.importance < 0.4;
    });

    const namespaceDistribution: Record<string, number> = {};
    for (const m of all) {
      const ns = m.namespace || 'general';
      namespaceDistribution[ns] = (namespaceDistribution[ns] ?? 0) + 1;
    }

    return { duplicates, stale, namespaceDistribution, totalMemories: all.length };
  }

  /** Health check: overall brain metrics */
  async health(): Promise<{
    totalMemories: number;
    dbSizeBytes: number;
    namespaceBalance: Record<string, number>;
    avgImportance: number;
    staleCount: number;
    duplicateCount: number;
    oldestAccess: string | null;
    newestAccess: string | null;
  }> {
    const stats = await this.stats();
    const all = await this.getAll();
    const now = Date.now();

    const avgImportance = all.length > 0 ? all.reduce((s, m) => s + m.importance, 0) / all.length : 0;
    const staleCount = all.filter(m => {
      const daysSince = (now - new Date(m.accessedAt).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince > 60 && m.importance < 0.4;
    }).length;

    let oldestAccess: string | null = null;
    let newestAccess: string | null = null;
    for (const m of all) {
      if (!oldestAccess || m.accessedAt < oldestAccess) oldestAccess = m.accessedAt;
      if (!newestAccess || m.accessedAt > newestAccess) newestAccess = m.accessedAt;
    }

    return {
      totalMemories: stats.totalMemories,
      dbSizeBytes: stats.dbSizeBytes,
      namespaceBalance: stats.byNamespace,
      avgImportance: +avgImportance.toFixed(3),
      staleCount,
      duplicateCount: 0, // Computed on-demand via audit
      oldestAccess,
      newestAccess,
    };
  }

  close(): void {
    // LanceDB connections don't need explicit closing
  }

  private rowToMemory(row: any): Memory {
    let metadata: MemoryMetadata | undefined;
    try {
      const parsed = JSON.parse(row.metadata || '{}');
      if (Object.keys(parsed).length > 0) metadata = parsed;
    } catch { /* ignore */ }

    return {
      id: row.id,
      namespace: row.namespace ?? 'general',
      type: row.type,
      content: row.content,
      embedding: null,
      importance: row.importance,
      source: row.source,
      tags: JSON.parse(row.tags),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accessedAt: row.accessed_at,
      accessCount: row.access_count ?? 0,
      metadata,
    };
  }
}
