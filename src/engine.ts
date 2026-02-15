import { Index, type Connection, type Table } from '@lancedb/lancedb';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase, getDefaultDbPath, getOrCreateTable } from './schema.js';
import { embed } from './embeddings.js';
import { computeRecencyScore, computeHybridScore, normalizeBm25Scores } from './scoring.js';
import type { Memory, MemoryInput, MemoryType, SearchOptions, SearchResult, MemoryStats } from './types.js';
import { statSync, readdirSync } from 'fs';
import { join } from 'path';

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

    const embedding = await embed(input.content);
    const tbl = await this.table();

    await tbl.add([{
      id,
      type,
      content: input.content,
      importance,
      source,
      tags: JSON.stringify(tags),
      created_at: now,
      updated_at: now,
      accessed_at: now,
      access_count: 0,
      vector: Array.from(embedding),
    }]);

    // Rebuild FTS index after adding data (skip during batch imports)
    if (rebuildFts) {
      try {
        await tbl.createIndex('content', { config: Index.fts(), replace: true });
      } catch {
        // ignore
      }
    }

    return {
      id, type, content: input.content, embedding, importance, source, tags,
      createdAt: now, updatedAt: now, accessedAt: now, accessCount: 0,
    };
  }

  async rebuildFtsIndex(): Promise<void> {
    const tbl = await this.table();
    try {
      await tbl.createIndex('content', { config: Index.fts(), replace: true });
    } catch {
      // ignore
    }
  }

  async saveBatch(inputs: MemoryInput[]): Promise<number> {
    const tbl = await this.table();
    const now = new Date().toISOString();
    let count = 0;

    // Process in batches of 50 to avoid memory issues
    const batchSize = 50;
    for (let i = 0; i < inputs.length; i += batchSize) {
      const batch = inputs.slice(i, i + batchSize);
      const rows = [];
      for (const input of batch) {
        const embedding = await embed(input.content);
        rows.push({
          id: uuidv4(),
          type: input.type ?? 'semantic',
          content: input.content,
          importance: input.importance ?? 0.5,
          source: input.source ?? 'cli',
          tags: JSON.stringify(input.tags ?? []),
          created_at: now,
          updated_at: now,
          accessed_at: now,
          access_count: 0,
          vector: Array.from(embedding),
        });
      }
      await tbl.add(rows);
      count += rows.length;
      process.stdout.write(`  Saved ${count}/${inputs.length}\r`);
    }

    // Rebuild FTS once at the end
    await this.rebuildFtsIndex();
    return count;
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    const tbl = await this.table();
    const queryEmbedding = await embed(options.query);

    // Vector search
    let vecResults: Array<{ id: string; _distance: number; type: string; content: string; importance: number; source: string; tags: string; created_at: string; updated_at: string; accessed_at: string; access_count: number }>;
    try {
      vecResults = await tbl.search(Array.from(queryEmbedding))
        .limit(limit * 3)
        .toArray();
    } catch {
      vecResults = [];
    }

    if (vecResults.length === 0) return [];

    // Convert L2 distance to similarity score [0, 1]
    // L2 distance for normalized vectors is in [0, 4] range (2*(1-cos_sim))
    // We use: similarity = 1 / (1 + distance) for a smooth conversion
    const vecScoreMap = new Map(vecResults.map(r => [r.id, 1 / (1 + r._distance)]));

    // BM25 / full-text search
    const bm25Map = new Map<string, number>();
    try {
      const ftsResults = await tbl.search(options.query, 'fts')
        .limit(limit * 3)
        .toArray();
      
      if (ftsResults.length > 0) {
        const rawScores = ftsResults.map(r => r._score ?? 1);
        const normalized = normalizeBm25Scores(rawScores);
        ftsResults.forEach((r: any, i: number) => bm25Map.set(r.id, normalized[i]));
      }
    } catch {
      // FTS might not be available or query might fail
    }

    // Score and filter
    const results: SearchResult[] = vecResults
      .filter(m => {
        if (options.type && m.type !== options.type) return false;
        if (options.minImportance && m.importance < options.minImportance) return false;
        if (options.tags?.length) {
          const memTags = JSON.parse(m.tags) as string[];
          if (!options.tags.some(t => memTags.includes(t))) return false;
        }
        return true;
      })
      .map(m => {
        const vectorScore = vecScoreMap.get(m.id) ?? 0;
        const bm25Score = bm25Map.get(m.id) ?? 0;
        const recencyScore = computeRecencyScore(m.accessed_at);
        const importanceScore = m.importance;
        const score = computeHybridScore(vectorScore, bm25Score, recencyScore, importanceScore);

        return {
          memory: this.rowToMemory(m),
          score, vectorScore, bm25Score, recencyScore, importanceScore,
        };
      });

    results.sort((a, b) => b.score - a.score);

    // Update accessed_at for top results
    const topResults = results.slice(0, limit);
    const now = new Date().toISOString();
    for (const r of topResults) {
      try {
        await tbl.update({
          where: `id = '${r.memory.id}'`,
          values: { accessed_at: now, access_count: (r.memory as any).accessCount + 1 + '' },
        });
      } catch {
        // ignore update errors
      }
    }

    return topResults;
  }

  async get(id: string): Promise<Memory | null> {
    const tbl = await this.table();
    try {
      const results = await tbl.query().where(`id = '${id}'`).limit(1).toArray();
      return results.length > 0 ? this.rowToMemory(results[0]) : null;
    } catch {
      return null;
    }
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

    // LanceDB update is limited; delete and re-add
    await tbl.delete(`id = '${id}'`);

    const embedding = updates.content ? await embed(content) : await embed(existing.content);

    await tbl.add([{
      id,
      type,
      content,
      importance,
      source: existing.source,
      tags: JSON.stringify(tags),
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
    } catch {
      return false;
    }
  }

  async stats(): Promise<MemoryStats> {
    const tbl = await this.table();
    let rows: any[];
    try {
      rows = await tbl.query().toArray();
    } catch {
      rows = [];
    }

    const byType: Record<MemoryType, number> = { episodic: 0, semantic: 0, procedural: 0 };
    let oldest: string | null = null;
    let newest: string | null = null;

    for (const r of rows) {
      const t = r.type as MemoryType;
      if (byType[t] !== undefined) byType[t]++;
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

    return {
      totalMemories: rows.length,
      byType,
      dbSizeBytes,
      oldestMemory: oldest,
      newestMemory: newest,
    };
  }

  close(): void {
    // LanceDB connections don't need explicit closing in the same way
  }

  private rowToMemory(row: any): Memory {
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
      accessCount: row.access_count,
    };
  }
}
