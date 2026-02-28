import { Index, type Connection, type Table } from '@lancedb/lancedb';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { initDatabase, getDefaultDbPath, getOrCreateTable } from './schema.js';
import { embed } from './embeddings.js';
import { computeRecencyScore, computeHybridScore, normalizeBm25Scores } from './scoring.js';
import type { Memory, MemoryInput, MemoryType, SearchOptions, SearchResult, MemoryStats, MemoryMetadata } from './types.js';
import { statSync, readdirSync } from 'fs';
import { join } from 'path';

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
    const type = input.type ?? 'semantic';
    const importance = input.importance ?? 0.5;
    const source = input.source ?? 'cli';
    const tags = input.tags ?? [];
    const metadata = input.metadata ?? {};

    const embedding = await embed(input.content);
    const tbl = await this.table();

    await tbl.add([{
      id,
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
      id, type, content: input.content, embedding, importance, source, tags, metadata,
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

    let vecResults: any[];
    try {
      vecResults = await tbl.search(Array.from(queryEmbedding)).limit(limit * 3).toArray();
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
    const type = updates.type ?? existing.type;
    const importance = updates.importance ?? existing.importance;
    const tags = updates.tags ?? existing.tags;
    const metadata = updates.metadata ?? existing.metadata ?? {};

    await tbl.delete(`id = '${id}'`);
    const embedding = await embed(content);

    await tbl.add([{
      id,
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
    let oldest: string | null = null;
    let newest: string | null = null;

    for (const r of rows) {
      const t = r.type as string;
      byType[t] = (byType[t] ?? 0) + 1;
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

    return { totalMemories: rows.length, byType, dbSizeBytes, oldestMemory: oldest, newestMemory: newest };
  }

  /** Get top memories by access count and importance for reflection */
  async reflect(): Promise<{ mostAccessed: Memory[]; highestImportance: Memory[] }> {
    const all = await this.getAll();
    const byAccess = [...all].sort((a, b) => b.accessCount - a.accessCount).slice(0, 10);
    const byImportance = [...all].sort((a, b) => b.importance - a.importance).slice(0, 10);
    return { mostAccessed: byAccess, highestImportance: byImportance };
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
