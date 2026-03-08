import { Index, type Connection, type Table } from '@lancedb/lancedb';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { initDatabase, getDefaultDbPath, getOrCreateTable } from './schema.js';
import { embed } from './embeddings.js';
import { computeRecencyScore, computeHybridScore, normalizeBm25Scores } from './scoring.js';
import type { Memory, MemoryInput, MemoryType, SearchOptions, SearchResult, MemoryStats, MemoryMetadata, BeliefMetadata, PredictionMetadata } from './types.js';
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
      let results: any[];
      if (id.length === 36) {
        // Full UUID — exact match
        results = await tbl.query().where(`id = '${id}'`).limit(1).toArray();
      } else {
        // Prefix match
        results = await tbl.query().where(`id LIKE '${id}%'`).limit(1).toArray();
      }
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
      // Support both full ID and prefix matching
      let existing: any[];
      if (id.length === 36) {
        // Full UUID, do exact match
        existing = await tbl.query().where(`id = '${id}'`).limit(1).toArray();
      } else {
        // Prefix match - use SQL LIKE for efficiency instead of loading all memories
        const pattern = `${id}%`;
        existing = await tbl.query().where(`id LIKE '${pattern}'`).toArray();
        
        if (existing.length > 1) {
          // Multiple matches found - this is ambiguous
          console.error(`Ambiguous ID prefix '${id}' matches ${existing.length} memories:`);
          for (const row of existing.slice(0, 5)) {
            console.error(`  [${row.id.slice(0, 8)}] ${row.content.slice(0, 60)}`);
          }
          if (existing.length > 5) console.error(`  ... and ${existing.length - 5} more`);
          return false;
        }
      }
      
      if (existing.length === 0) return false;
      
      const fullId = existing[0].id;
      await tbl.delete(`id = '${fullId}'`);
      return true;
    } catch (error) {
      console.error('Delete error:', error);
      return false;
    }
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
  async decay(options: { dryRun?: boolean; halfLifeDays?: number; minImportance?: number; batchSize?: number }): Promise<{ affected: Array<{ id: string; content: string; oldImportance: number; newImportance: number }> }> {
    const halfLife = options.halfLifeDays ?? 30;
    const minImp = options.minImportance ?? 0.05;
    const batchSize = options.batchSize ?? 1000; // Process in batches to avoid memory issues
    const now = Date.now();
    const affected: Array<{ id: string; content: string; oldImportance: number; newImportance: number }> = [];

    const tbl = await this.table();
    let offset = 0;
    let hasMore = true;
    
    console.log(`Processing memories in batches of ${batchSize}...`);
    
    while (hasMore) {
      try {
        // Get batch of raw rows to avoid heavy Memory object creation
        const batch = await tbl.query().offset(offset).limit(batchSize).toArray();
        hasMore = batch.length === batchSize;
        offset += batchSize;
        
        if (batch.length === 0) break;
        
        console.log(`  Processing batch ${Math.floor(offset / batchSize)} (${batch.length} memories)`);

        for (const row of batch) {
          const daysSinceAccess = (now - new Date(row.accessed_at).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceAccess < 7) continue; // Skip recently accessed
          
          const decayFactor = Math.exp(-0.693 * daysSinceAccess / halfLife);
          const newImportance = Math.max(minImp, +(row.importance * decayFactor).toFixed(3));
          
          if (newImportance < row.importance - 0.01) {
            affected.push({ 
              id: row.id, 
              content: row.content, 
              oldImportance: row.importance, 
              newImportance 
            });
          }
        }
        
        // Yield control to prevent blocking
        if (offset % (batchSize * 5) === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      } catch (err) {
        console.error(`Error processing batch at offset ${offset}:`, err);
        break;
      }
    }

    if (!options.dryRun && affected.length > 0) {
      console.log(`Updating ${affected.length} memories...`);
      // Update in smaller batches to avoid overwhelming the database
      const updateBatchSize = 100;
      for (let i = 0; i < affected.length; i += updateBatchSize) {
        const updateBatch = affected.slice(i, i + updateBatchSize);
        for (const a of updateBatch) {
          try {
            await tbl.update({ where: `id = '${a.id}'`, values: { importance: a.newImportance + '' } });
          } catch { /* ignore */ }
        }
        console.log(`  Updated ${Math.min(i + updateBatchSize, affected.length)}/${affected.length}`);
      }
    }

    return { affected };
  }

  /** Consolidate similar memories into summaries */
  async consolidate(options: { dryRun?: boolean; similarityThreshold?: number; minClusterSize?: number; maxMemories?: number }): Promise<{ clusters: Array<{ ids: string[]; contents: string[] }> }> {
    const threshold = options.similarityThreshold ?? 0.85;
    const minSize = options.minClusterSize ?? 2;
    const maxMemories = options.maxMemories ?? 5000; // Limit to prevent O(n²) explosion
    const tbl = await this.table();
    
    // Get a limited set of memories, prioritizing by importance
    console.log(`Loading memories for consolidation (limit: ${maxMemories})...`);
    const allRows = await tbl.query()
      .select(['id', 'content', 'namespace', 'importance', 'vector'])
      .toArray();
    
    // Sort by importance descending and take the top memories
    const rows = allRows
      .sort((a: any, b: any) => b.importance - a.importance)
      .slice(0, maxMemories);
      
    if (rows.length < minSize) {
      console.log(`Only ${rows.length} memories found, need at least ${minSize} for clustering`);
      return { clusters: [] };
    }
    
    console.log(`Processing ${rows.length} memories for similarity clustering...`);

    // Build vector map from limited set
    const idToVector = new Map<string, number[]>();
    const idToRow = new Map<string, any>();
    for (const r of rows) {
      idToVector.set(r.id, Array.from(r.vector as Float32Array));
      idToRow.set(r.id, r);
    }

    // Find clusters using greedy approach with progress tracking
    const used = new Set<string>();
    const clusters: Array<{ ids: string[]; contents: string[]; namespaces: string[] }> = [];
    let processed = 0;

    for (const row of rows) {
      if (used.has(row.id)) continue;
      
      processed++;
      if (processed % 100 === 0) {
        console.log(`  Processed ${processed}/${rows.length} memories...`);
      }
      
      const vec = idToVector.get(row.id);
      if (!vec) continue;

      const cluster = [row];
      used.add(row.id);

      // Only compare with remaining unused memories to avoid redundant work
      const candidates = rows.filter((r: any) => !used.has(r.id) && r.id !== row.id);
      
      for (const other of candidates) {
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
      
      // Yield control periodically
      if (processed % 50 === 0) {
        await new Promise(resolve => setImmediate(resolve));
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

  /** Save a belief with confidence tracking */
  async saveBelief(statement: string, confidence: number, domain: string, options?: { tags?: string[]; evidence?: string[]; holder?: string }): Promise<Memory> {
    const now = new Date().toISOString();
    
    // Check for similar existing beliefs (cosine sim > 0.9)
    const existing = await this.search({ query: statement, type: 'belief', limit: 5 });
    for (const result of existing) {
      if (result.vectorScore > 0.9) {
        // Update existing belief instead of creating new one
        const beliefMeta = result.memory.metadata as any;
        const updatedMetadata = {
          ...beliefMeta,
          confidence,
          domain,
          last_challenged: now,
          history: [
            ...(beliefMeta.history || []),
            { date: now, confidence, reason: 'updated via saveBelief' }
          ]
        };
        return await this.update(result.memory.id, {
          metadata: updatedMetadata
        }) || result.memory;
      }
    }

    // Create new belief
    const metadata = {
      confidence,
      domain,
      evidence_for: options?.evidence || [],
      evidence_against: [],
      last_challenged: now,
      times_confirmed: 0,
      times_refuted: 0,
      status: 'active' as const,
      history: [{ date: now, confidence, reason: 'initial belief' }],
      holder: (options?.holder || 'orion') as 'ryan' | 'orion' | 'shared',
      stated_confidence: confidence
    };

    return await this.save({
      content: statement,
      type: 'belief',
      importance: Math.max(0.6, confidence), // Beliefs have high baseline importance
      source: 'belief-system',
      tags: options?.tags || [],
      metadata
    });
  }

  /** Get all active beliefs, sorted by confidence desc */
  async getBeliefs(options?: { domain?: string; staleAfterDays?: number; holder?: string }): Promise<Array<Memory & { isStale: boolean }>> {
    const staleThreshold = options?.staleAfterDays || 7;
    const now = Date.now();
    
    // Use direct table query instead of search (search needs a non-empty query for vectors)
    const tbl = await this.table();
    let allBeliefs: Memory[];
    try {
      const rows = await tbl.query().where("type = 'belief'").toArray();
      allBeliefs = rows.map(r => this.rowToMemory(r));
    } catch { allBeliefs = []; }
    
    let filtered = allBeliefs
      .filter(m => {
        const meta = m.metadata as any;
        if (meta?.status && meta.status !== 'active') return false;
        if (options?.domain && meta?.domain !== options.domain) return false;
        if (options?.holder && meta?.holder !== options.holder) return false;
        return true;
      });

    // Check for staleness
    return filtered.map(belief => {
      const meta = belief.metadata as any;
      const lastChallenged = meta?.last_challenged ? new Date(meta.last_challenged).getTime() : new Date(belief.createdAt).getTime();
      const daysSince = (now - lastChallenged) / (1000 * 60 * 60 * 24);
      
      return {
        ...belief,
        isStale: daysSince > staleThreshold
      };
    }).sort((a, b) => {
      const aConf = (a.metadata as any)?.confidence || 0;
      const bConf = (b.metadata as any)?.confidence || 0;
      return bConf - aConf;
    });
  }

  /** Challenge a belief — find contradicting memories */
  async challengeBelief(beliefId: string, limit?: number): Promise<{ belief: Memory; contradictions: SearchResult[]; supportingEvidence: SearchResult[] }> {
    const belief = await this.get(beliefId);
    if (!belief || belief.type !== 'belief') {
      throw new Error(`Belief not found: ${beliefId}`);
    }

    const searchLimit = limit || 10;
    
    // Generate contradiction search terms by negating the key claims
    const statement = belief.content.toLowerCase();
    let contradictionQueries: string[] = [];
    
    // Basic negation patterns
    if (statement.includes('is not')) {
      contradictionQueries.push(statement.replace('is not', 'is'));
    } else if (statement.includes(' is ')) {
      contradictionQueries.push(statement.replace(' is ', ' is not '));
    }
    
    // Domain-specific contradictions
    if (statement.includes('distribution')) {
      contradictionQueries.push(statement.replace('distribution', 'product'));
    }
    if (statement.includes('product')) {
      contradictionQueries.push(statement.replace('product', 'distribution'));
    }
    
    // Extract key terms and search for problems/issues
    const words = statement.split(' ').filter(w => w.length > 3);
    if (words.length > 0) {
      contradictionQueries.push(`${words[0]} problems`);
      contradictionQueries.push(`${words[0]} issues`);
      contradictionQueries.push(`${words[0]} needs improvement`);
    }

    // Search for contradictions
    let contradictions: SearchResult[] = [];
    for (const query of contradictionQueries) {
      const results = await this.search({ 
        query, 
        limit: searchLimit,
        type: undefined // Search all types except beliefs
      });
      contradictions.push(...results.filter(r => r.memory.type !== 'belief'));
    }

    // Remove duplicates and sort by score
    const seen = new Set<string>();
    contradictions = contradictions
      .filter(r => {
        if (seen.has(r.memory.id)) return false;
        seen.add(r.memory.id);
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, searchLimit);

    // Search for supporting evidence
    const supportingEvidence = await this.search({
      query: belief.content,
      limit: searchLimit,
      type: undefined
    });
    const filtered = supportingEvidence.filter(r => r.memory.id !== belief.id && r.memory.type !== 'belief');

    // Update belief metadata
    const now = new Date().toISOString();
    const meta = belief.metadata as any;
    await this.update(belief.id, {
      metadata: {
        ...meta,
        last_challenged: now
      }
    });

    return { belief, contradictions, supportingEvidence: filtered };
  }

  /** Update belief confidence with history tracking */
  async updateBeliefConfidence(beliefId: string, newConfidence: number, reason: string): Promise<Memory | null> {
    const belief = await this.get(beliefId);
    if (!belief || belief.type !== 'belief') return null;

    const now = new Date().toISOString();
    const meta = belief.metadata as any;
    const oldConfidence = meta?.confidence || 0.5;

    const updatedMetadata = {
      ...meta,
      confidence: newConfidence,
      last_challenged: now,
      history: [
        ...(meta.history || []),
        { date: now, confidence: newConfidence, reason }
      ]
    };

    // Update times_confirmed/times_refuted
    if (newConfidence > oldConfidence) {
      updatedMetadata.times_confirmed = (meta.times_confirmed || 0) + 1;
    } else if (newConfidence < oldConfidence) {
      updatedMetadata.times_refuted = (meta.times_refuted || 0) + 1;
    }

    return await this.update(belief.id, {
      metadata: updatedMetadata,
      importance: Math.max(0.6, newConfidence) // Update importance based on confidence
    });
  }

  /** Mark belief as confirmed/refuted */
  async resolveBeliefStatus(beliefId: string, status: 'confirmed' | 'refuted', reason: string): Promise<Memory | null> {
    const belief = await this.get(beliefId);
    if (!belief || belief.type !== 'belief') return null;

    const now = new Date().toISOString();
    const meta = belief.metadata as any;

    const updatedMetadata = {
      ...meta,
      status,
      last_challenged: now,
      history: [
        ...(meta.history || []),
        { date: now, confidence: meta.confidence || 0.5, reason: `${status}: ${reason}` }
      ]
    };

    if (status === 'confirmed') {
      updatedMetadata.times_confirmed = (meta.times_confirmed || 0) + 1;
    } else {
      updatedMetadata.times_refuted = (meta.times_refuted || 0) + 1;
    }

    return await this.update(belief.id, {
      metadata: updatedMetadata
    });
  }

  /** Save a prediction with deadline */
  async savePrediction(statement: string, confidence: number, deadline: string, holder: string, domain: string): Promise<Memory> {
    const metadata: PredictionMetadata = {
      confidence,
      holder: holder as 'ryan' | 'orion' | 'shared',
      deadline,
      domain,
      status: 'open'
    };

    return await this.save({
      content: statement,
      type: 'prediction',
      importance: Math.max(0.7, confidence), // Predictions have high baseline importance
      source: 'prediction-system',
      metadata
    });
  }

  /** Get open predictions, optionally filter by expired */
  async getPredictions(options?: { holder?: string; expired?: boolean; domain?: string }): Promise<Memory[]> {
    const tbl = await this.table();
    let predictions: Memory[];
    try {
      const rows = await tbl.query().where("type = 'prediction'").toArray();
      predictions = rows.map(r => this.rowToMemory(r));
    } catch { predictions = []; }
    
    const now = new Date();
    
    return predictions
      .filter(p => {
        const meta = p.metadata as PredictionMetadata;
        if (!meta) return false;
        
        // Filter by holder
        if (options?.holder && meta.holder !== options.holder) return false;
        
        // Filter by domain
        if (options?.domain && meta.domain !== options.domain) return false;
        
        // Filter by expired status
        if (options?.expired !== undefined) {
          const deadlineDate = new Date(meta.deadline);
          const isExpired = now > deadlineDate && meta.status === 'open';
          if (options.expired !== isExpired) return false;
        }
        
        return true;
      })
      .sort((a, b) => {
        const aDeadline = new Date((a.metadata as PredictionMetadata).deadline);
        const bDeadline = new Date((b.metadata as PredictionMetadata).deadline);
        return aDeadline.getTime() - bDeadline.getTime();
      });
  }

  /** Resolve a prediction */
  async resolvePrediction(predictionId: string, outcome: 'correct' | 'wrong' | 'partial', resolution: string): Promise<Memory | null> {
    const prediction = await this.get(predictionId);
    if (!prediction || prediction.type !== 'prediction') return null;

    const now = new Date().toISOString();
    const meta = prediction.metadata as PredictionMetadata;

    const updatedMetadata: PredictionMetadata = {
      ...meta,
      status: outcome,
      resolution,
      resolved_at: now
    };

    return await this.update(prediction.id, {
      metadata: updatedMetadata
    });
  }

  /** Calculate calibration score (Brier score) across resolved predictions */
  async getCalibration(options?: { holder?: string; domain?: string }): Promise<{
    totalPredictions: number;
    resolvedCount: number;
    brierScore: number;
    byConfidenceBucket: Array<{ bucket: string; predicted: number; actual: number; count: number }>;
    byDomain: Record<string, { brierScore: number; count: number }>;
    byHolder: Record<string, { brierScore: number; count: number }>;
  }> {
    const tbl = await this.table();
    let predictions: Memory[];
    try {
      const rows = await tbl.query().where("type = 'prediction'").toArray();
      predictions = rows.map(r => this.rowToMemory(r));
    } catch { predictions = []; }

    // Filter predictions
    const filtered = predictions.filter(p => {
      const meta = p.metadata as PredictionMetadata;
      if (!meta) return false;
      if (options?.holder && meta.holder !== options.holder) return false;
      if (options?.domain && meta.domain !== options.domain) return false;
      return true;
    });

    const resolved = filtered.filter(p => {
      const meta = p.metadata as PredictionMetadata;
      return meta.status === 'correct' || meta.status === 'wrong' || meta.status === 'partial';
    });

    if (resolved.length === 0) {
      return {
        totalPredictions: filtered.length,
        resolvedCount: 0,
        brierScore: 0,
        byConfidenceBucket: [],
        byDomain: {},
        byHolder: {}
      };
    }

    // Calculate Brier score
    let brierSum = 0;
    const buckets: Record<string, { predicted: number; actual: number; count: number }> = {};
    const byDomain: Record<string, { brierScore: number; count: number; sum: number }> = {};
    const byHolder: Record<string, { brierScore: number; count: number; sum: number }> = {};

    for (const pred of resolved) {
      const meta = pred.metadata as PredictionMetadata;
      const confidence = meta.confidence;
      const actualOutcome = meta.status === 'correct' ? 1 : meta.status === 'partial' ? 0.5 : 0;
      
      // Brier score: (prediction - outcome)^2
      const brierContrib = Math.pow(confidence - actualOutcome, 2);
      brierSum += brierContrib;

      // Bucket analysis
      const bucket = confidence >= 0.9 ? '90-100%' : 
                     confidence >= 0.7 ? '70-89%' : 
                     confidence >= 0.5 ? '50-69%' : 
                     confidence >= 0.3 ? '30-49%' : '0-29%';
      
      if (!buckets[bucket]) {
        buckets[bucket] = { predicted: 0, actual: 0, count: 0 };
      }
      buckets[bucket].predicted += confidence;
      buckets[bucket].actual += actualOutcome;
      buckets[bucket].count += 1;

      // Domain breakdown
      if (!byDomain[meta.domain]) {
        byDomain[meta.domain] = { brierScore: 0, count: 0, sum: 0 };
      }
      byDomain[meta.domain].sum += brierContrib;
      byDomain[meta.domain].count += 1;

      // Holder breakdown  
      if (!byHolder[meta.holder]) {
        byHolder[meta.holder] = { brierScore: 0, count: 0, sum: 0 };
      }
      byHolder[meta.holder].sum += brierContrib;
      byHolder[meta.holder].count += 1;
    }

    const brierScore = brierSum / resolved.length;

    // Calculate averages
    const domainFinal: Record<string, { brierScore: number; count: number }> = {};
    for (const [domain, data] of Object.entries(byDomain)) {
      domainFinal[domain] = { brierScore: data.sum / data.count, count: data.count };
    }

    const holderFinal: Record<string, { brierScore: number; count: number }> = {};
    for (const [holder, data] of Object.entries(byHolder)) {
      holderFinal[holder] = { brierScore: data.sum / data.count, count: data.count };
    }

    return {
      totalPredictions: filtered.length,
      resolvedCount: resolved.length,
      brierScore,
      byConfidenceBucket: Object.entries(buckets).map(([bucket, data]) => ({
        bucket,
        predicted: data.predicted / data.count,
        actual: data.actual / data.count,
        count: data.count
      })),
      byDomain: domainFinal,
      byHolder: holderFinal
    };
  }

  /** Log a behavioral signal (what someone actually did, vs what they said) */
  async logBehavior(description: string, holder: string, relatedBeliefs?: string[]): Promise<Memory> {
    const metadata: MemoryMetadata = {
      holder: holder as 'ryan' | 'orion' | 'shared',
      relatedBeliefs: relatedBeliefs || []
    } as any;

    return await this.save({
      content: description,
      type: 'behavior',
      importance: 0.6,
      source: 'behavior-tracker',
      metadata
    });
  }

  /** Compare stated beliefs vs behavioral signals for a holder */
  async getBeliefGaps(holder: string): Promise<Array<{
    belief: Memory;
    statedConfidence: number;
    revealedSignals: Memory[];
    gap: number;
    trend: 'widening' | 'narrowing' | 'stable';
  }>> {
    const tbl = await this.table();
    
    // Get beliefs for this holder
    let beliefs: Memory[];
    let behaviors: Memory[];
    
    try {
      const beliefRows = await tbl.query().where("type = 'belief'").toArray();
      beliefs = beliefRows
        .map(r => this.rowToMemory(r))
        .filter(b => {
          const meta = b.metadata as BeliefMetadata;
          return meta?.holder === holder;
        });

      const behaviorRows = await tbl.query().where("type = 'behavior'").toArray();
      behaviors = behaviorRows
        .map(r => this.rowToMemory(r))
        .filter(b => {
          const meta = b.metadata as any;
          return meta?.holder === holder;
        });
    } catch { beliefs = []; behaviors = []; }

    const gaps = [];

    for (const belief of beliefs) {
      const beliefMeta = belief.metadata as BeliefMetadata;
      const statedConfidence = beliefMeta?.stated_confidence || beliefMeta?.confidence || 0.5;
      
      // Find related behavioral signals
      const relatedSignals = behaviors.filter(behavior => {
        const behaviorMeta = behavior.metadata as any;
        if (behaviorMeta?.relatedBeliefs?.includes(belief.id)) return true;
        
        // Simple content similarity check
        const beliefWords = belief.content.toLowerCase().split(/\W+/).filter(w => w.length > 3);
        const behaviorWords = behavior.content.toLowerCase().split(/\W+/).filter(w => w.length > 3);
        const overlap = beliefWords.filter(w => behaviorWords.includes(w)).length;
        return overlap >= 2; // At least 2 word overlap
      });

      if (relatedSignals.length > 0) {
        // Infer revealed confidence from behavior patterns
        const revealedConfidence = beliefMeta?.revealed_confidence || this.inferRevealedConfidence(belief, relatedSignals);
        const gap = Math.abs(statedConfidence - revealedConfidence);
        
        // Simple trend calculation based on recent vs older signals
        const trend = this.calculateConfidenceTrend(belief, relatedSignals);

        gaps.push({
          belief,
          statedConfidence,
          revealedSignals: relatedSignals,
          gap,
          trend
        });

        // Update belief metadata with gap information
        const updatedMeta: BeliefMetadata = {
          ...beliefMeta,
          revealed_confidence: revealedConfidence,
          gap
        };
        await this.update(belief.id, { metadata: updatedMeta });
      }
    }

    return gaps.sort((a, b) => b.gap - a.gap); // Sort by gap size descending
  }

  /** Log topic/project engagement */
  async logAttention(topics: string[], holder: string, durationMinutes?: number): Promise<void> {
    const now = new Date().toISOString();
    const metadata: MemoryMetadata = {
      holder: holder as 'ryan' | 'orion' | 'shared',
      topics,
      durationMinutes: durationMinutes || 1,
      timestamp: now
    } as any;

    await this.save({
      content: `Attention on: ${topics.join(', ')}${durationMinutes ? ` (${durationMinutes}m)` : ''}`,
      type: 'attention',
      importance: 0.3, // Lower importance, these are tracking signals
      source: 'attention-tracker',
      metadata
    });
  }

  /** Get attention distribution over time */
  async getAttention(options?: { holder?: string; periodHours?: number }): Promise<{
    topicDistribution: Record<string, number>;
    projectCount: number;
    trend: string;
    breadthScore: number;
  }> {
    const periodHours = options?.periodHours || 24;
    const since = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();
    
    const tbl = await this.table();
    let attentionRecords: Memory[];
    
    try {
      const rows = await tbl.query().where("type = 'attention'").toArray();
      attentionRecords = rows
        .map(r => this.rowToMemory(r))
        .filter(a => {
          const meta = a.metadata as any;
          if (options?.holder && meta?.holder !== options.holder) return false;
          return a.createdAt >= since;
        });
    } catch { attentionRecords = []; }

    const topicDistribution: Record<string, number> = {};
    const projects = new Set<string>();
    let totalMinutes = 0;

    for (const record of attentionRecords) {
      const meta = record.metadata as any;
      const topics = meta?.topics || [];
      const duration = meta?.durationMinutes || 1;
      
      totalMinutes += duration;
      
      for (const topic of topics) {
        topicDistribution[topic] = (topicDistribution[topic] || 0) + duration;
        projects.add(topic);
      }
    }

    // Calculate breadth score (0 = laser focused, 1 = scattered)
    const uniqueTopics = Object.keys(topicDistribution).length;
    const breadthScore = uniqueTopics === 0 ? 0 : Math.min(1, uniqueTopics / 10);

    // Simple trend analysis
    const now = Date.now();
    const halfPeriod = periodHours * 30 * 60 * 1000; // Half period in ms
    const recent = attentionRecords.filter(a => new Date(a.createdAt).getTime() > now - halfPeriod);
    const trend = recent.length > attentionRecords.length / 2 ? 'increasing' : 
                  recent.length < attentionRecords.length / 2 ? 'decreasing' : 'stable';

    return {
      topicDistribution,
      projectCount: projects.size,
      trend,
      breadthScore
    };
  }

  /** Create a follow-up from shadow/reflection findings */
  async createFollowUp(item: string, source: string, holder: string): Promise<Memory> {
    const metadata: MemoryMetadata = {
      holder: holder as 'ryan' | 'orion' | 'shared',
      source,
      status: 'open',
      created_from: source
    } as any;

    return await this.save({
      content: item,
      type: 'follow-up',
      importance: 0.8, // High importance to ensure follow-ups get attention
      source: 'follow-up-tracker',
      metadata
    });
  }

  /** Get open follow-ups */
  async getFollowUps(options?: { holder?: string; resolved?: boolean }): Promise<Memory[]> {
    const tbl = await this.table();
    let followUps: Memory[];
    
    try {
      const rows = await tbl.query().where("type = 'follow-up'").toArray();
      followUps = rows.map(r => this.rowToMemory(r));
    } catch { followUps = []; }

    return followUps
      .filter(f => {
        const meta = f.metadata as any;
        if (options?.holder && meta?.holder !== options.holder) return false;
        if (options?.resolved !== undefined) {
          const isResolved = meta?.status === 'resolved';
          if (options.resolved !== isResolved) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /** Resolve a follow-up */
  async resolveFollowUp(id: string, resolution: string): Promise<Memory | null> {
    const followUp = await this.get(id);
    if (!followUp || followUp.type !== 'follow-up') return null;

    const now = new Date().toISOString();
    const meta = followUp.metadata as any;

    const updatedMetadata = {
      ...meta,
      status: 'resolved',
      resolution,
      resolved_at: now
    };

    return await this.update(followUp.id, {
      metadata: updatedMetadata
    });
  }

  private inferRevealedConfidence(belief: Memory, behaviorSignals: Memory[]): number {
    // Simple heuristic: analyze behavior signals to infer actual confidence
    // This is a basic implementation - could be much more sophisticated
    
    let supportingSignals = 0;
    let contradictingSignals = 0;
    
    const beliefWords = belief.content.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    
    for (const signal of behaviorSignals) {
      const signalContent = signal.content.toLowerCase();
      
      // Check if behavior aligns with stated belief
      const alignmentWords = ['committed', 'followed', 'maintained', 'consistent', 'delivered'];
      const contradictionWords = ['avoided', 'skipped', 'ignored', 'inconsistent', 'failed'];
      
      if (alignmentWords.some(w => signalContent.includes(w))) {
        supportingSignals++;
      } else if (contradictionWords.some(w => signalContent.includes(w))) {
        contradictingSignals++;
      }
    }

    const totalSignals = supportingSignals + contradictingSignals;
    if (totalSignals === 0) return 0.5; // No clear signals
    
    return supportingSignals / totalSignals;
  }

  private calculateConfidenceTrend(belief: Memory, signals: Memory[]): 'widening' | 'narrowing' | 'stable' {
    if (signals.length < 2) return 'stable';
    
    // Sort signals by date
    const sorted = signals.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const recent = sorted.slice(-3); // Last 3 signals
    const older = sorted.slice(0, -3); // Earlier signals
    
    if (older.length === 0) return 'stable';
    
    // Simple trend: are recent signals more or less aligned with stated belief?
    const recentAlignment = this.calculateSignalAlignment(belief, recent);
    const olderAlignment = this.calculateSignalAlignment(belief, older);
    
    if (Math.abs(recentAlignment - olderAlignment) < 0.1) return 'stable';
    return recentAlignment > olderAlignment ? 'narrowing' : 'widening';
  }

  private calculateSignalAlignment(belief: Memory, signals: Memory[]): number {
    // Return alignment score 0-1
    if (signals.length === 0) return 0.5;
    
    let alignedCount = 0;
    for (const signal of signals) {
      const content = signal.content.toLowerCase();
      if (content.includes('consistent') || content.includes('delivered') || content.includes('committed')) {
        alignedCount++;
      }
    }
    
    return alignedCount / signals.length;
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
