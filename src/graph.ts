import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, existsSync, readFileSync } from 'fs';

export interface Entity {
  id: string;
  name: string;
  type: string; // 'person' | 'project' | 'url' | 'date' | 'company' | 'term'
  aliases: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Relationship {
  id: string;
  sourceEntity: string;
  targetEntity: string;
  relation: string;
  weight: number;
  metadata: Record<string, unknown>;
  memoryId: string;
  createdAt: string;
}

// Verbs that indicate a strong directed relationship
const STRONG_VERBS = [
  'built', 'created', 'uses', 'used', 'owns', 'wrote', 'developed',
  'founded', 'leads', 'manages', 'works', 'joined', 'left', 'acquired',
  'deployed', 'launched', 'shipped', 'runs', 'implements', 'supports',
  'integrates', 'connects', 'defines', 'contains', 'depends', 'extends',
  'replaces', 'includes', 'requires', 'built', 'maintains', 'configures',
];

/**
 * User-defined known entities for higher-precision extraction.
 * Configure via ~/.cortex/known-entities.json (optional).
 * Format: [{ "pattern": "\\bMyProject\\b", "name": "MyProject", "type": "project" }, ...]
 */
function loadKnownEntities(): Array<{ pattern: RegExp; name: string; type: string }> {
  try {
    const configPath = join(homedir(), '.cortex', 'known-entities.json');
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return (raw as Array<{ pattern: string; name: string; type: string }>).map(e => ({
        pattern: new RegExp(e.pattern, 'gi'),
        name: e.name,
        type: e.type,
      }));
    }
  } catch { /* ignore malformed config */ }
  return [];
}

const KNOWN_ENTITIES = loadKnownEntities();

// Common English words to skip when extracting proper nouns
const COMMON_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'It', 'Its', 'A', 'An',
  'I', 'We', 'You', 'He', 'She', 'They', 'My', 'Our', 'Your', 'His', 'Her', 'Their',
  'In', 'On', 'At', 'To', 'For', 'Of', 'With', 'By', 'From', 'Up', 'Down',
  'Is', 'Are', 'Was', 'Were', 'Be', 'Been', 'Being', 'Have', 'Has', 'Had',
  'Do', 'Does', 'Did', 'Will', 'Would', 'Could', 'Should', 'May', 'Might',
  'Can', 'Must', 'Shall', 'And', 'Or', 'But', 'So', 'Yet', 'Nor', 'Not',
  'If', 'Then', 'When', 'Where', 'While', 'Because', 'Although', 'Since',
  'After', 'Before', 'Until', 'As', 'Just', 'Now', 'Also', 'Very',
  'New', 'Old', 'First', 'Last', 'Next', 'Other', 'Some', 'All', 'Any',
  'Each', 'Both', 'More', 'Most', 'Such', 'Than', 'How', 'What', 'Which', 'Who',
  'January', 'February', 'March', 'April', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'True', 'False', 'Null', 'None', 'Yes', 'No', 'Ok', 'Okay',
]);

export class KnowledgeGraph {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? join(homedir(), '.cortex', 'graph.db');
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL,
        aliases    TEXT NOT NULL DEFAULT '[]',
        metadata   TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

      CREATE TABLE IF NOT EXISTS relationships (
        id             TEXT PRIMARY KEY,
        source_entity  TEXT NOT NULL,
        target_entity  TEXT NOT NULL,
        relation       TEXT NOT NULL,
        weight         REAL NOT NULL DEFAULT 1.0,
        metadata       TEXT NOT NULL DEFAULT '{}',
        memory_id      TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        FOREIGN KEY (source_entity) REFERENCES entities(id),
        FOREIGN KEY (target_entity) REFERENCES entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_rel_source  ON relationships(source_entity);
      CREATE INDEX IF NOT EXISTS idx_rel_target  ON relationships(target_entity);
      CREATE INDEX IF NOT EXISTS idx_rel_memory  ON relationships(memory_id);

      CREATE TABLE IF NOT EXISTS entity_mentions (
        entity_id  TEXT NOT NULL,
        memory_id  TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, memory_id),
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_mention_entity ON entity_mentions(entity_id);
      CREATE INDEX IF NOT EXISTS idx_mention_memory  ON entity_mentions(memory_id);
    `);
  }

  // ─── Entity Extraction ───────────────────────────────────────────────────────

  /** Extract named entities from text using regex heuristics (no API calls). */
  extractEntities(text: string): Array<{ name: string; type: string }> {
    const entities: Array<{ name: string; type: string }> = [];
    const seen = new Set<string>();

    const add = (name: string, type: string): void => {
      const trimmed = name.trim();
      if (trimmed.length < 2 || trimmed.length > 120) return;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({ name: trimmed, type });
      }
    };

    // 0. Known entities (highest priority — matched first so they're not re-classified)
    for (const ke of KNOWN_ENTITIES) {
      for (const m of text.matchAll(ke.pattern)) {
        add(ke.name, ke.type);
      }
    }

    // 1. URLs
    const urlRe = /https?:\/\/[^\s,;)"'\]]+/g;
    for (const m of text.matchAll(urlRe)) add(m[0], 'url');

    // 2. ISO dates and common date patterns
    const dateRe = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/gi;
    for (const m of text.matchAll(dateRe)) add(m[0], 'date');

    // 3. Company-like patterns (Name + Inc/LLC/Corp/Ltd/Co/AI/Labs)
    const companyRe = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:Inc|LLC|Corp|Ltd|Co|AI|Labs|Technologies|Systems|Solutions|Group|Media|Studio|Studios)\.?)\b/g;
    for (const m of text.matchAll(companyRe)) add(m[1], 'company');

    // 4. Multi-word proper nouns only (First Last patterns — likely people)
    // Skip single capitalized words (too noisy) and camelCase/slug identifiers
    const sentences = text.split(/(?<=[.!?])\s+/);
    const knownNames = new Set(entities.map(e => e.name));
    for (const sentence of sentences) {
      const tokens = sentence.trim().split(/\s+/);
      let i = 1; // skip first token (sentence-initial capital)
      while (i < tokens.length) {
        const raw = tokens[i];
        const clean = raw.replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, '');
        if (clean.length >= 2 && /^[A-Z][a-z]/.test(clean) && !COMMON_WORDS.has(clean)) {
          // Only extract multi-word proper nouns (First Last = likely a person)
          const rawNext = tokens[i + 1] ?? '';
          const cleanNext = rawNext.replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, '');
          if (cleanNext && /^[A-Z][a-z]/.test(cleanNext) && !COMMON_WORDS.has(cleanNext)) {
            const fullName = `${clean} ${cleanNext}`;
            if (!knownNames.has(fullName)) add(fullName, 'person');
            i += 2;
          } else {
            i++;
          }
        } else {
          i++;
        }
      }
    }

    return entities;
  }

  // ─── Relationship Extraction ─────────────────────────────────────────────────

  /** Detect relationships between co-occurring entities using SVO patterns. */
  extractRelationships(
    text: string,
    entities: Array<{ name: string; type: string }>,
  ): Array<{ source: string; target: string; relation: string; weight: number }> {
    const results: Array<{ source: string; target: string; relation: string; weight: number }> = [];
    if (entities.length < 2) return results;

    const entityNames = entities.map(e => e.name);

    // Build escaped regex alternation once
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameAlt = entityNames.map(esc).join('|');

    // Strong SVO pattern: <entity> [has/also] <verb> <entity>
    const verbAlt = STRONG_VERBS.join('|');
    const svoRe = new RegExp(
      `(${nameAlt})\\s+(?:(?:has|also|just|now)\\s+)?(${verbAlt})(?:s|ed|ing)?\\s+(${nameAlt})`,
      'gi',
    );

    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      // Strong relationships from SVO
      const strongPairs = new Set<string>();
      let m: RegExpExecArray | null;
      svoRe.lastIndex = 0;
      while ((m = svoRe.exec(sentence)) !== null) {
        const src = m[1];
        const verb = m[2];
        const tgt = m[3];
        if (src.toLowerCase() !== tgt.toLowerCase()) {
          results.push({ source: src, target: tgt, relation: verb.toLowerCase(), weight: 0.8 });
          const pairKey = [src.toLowerCase(), tgt.toLowerCase()].sort().join('::');
          strongPairs.add(pairKey);
        }
      }

      // Co-occurrence: entities sharing the same sentence = weak relationship
      // Cap at 6 entities per sentence to avoid combinatorial explosion
      const inSentence = entityNames.filter(n =>
        sentence.toLowerCase().includes(n.toLowerCase()),
      ).slice(0, 6);
      for (let i = 0; i < inSentence.length; i++) {
        for (let j = i + 1; j < inSentence.length; j++) {
          const a = inSentence[i];
          const b = inSentence[j];
          const pairKey = [a.toLowerCase(), b.toLowerCase()].sort().join('::');
          if (!strongPairs.has(pairKey)) {
            results.push({ source: a, target: b, relation: 'co-occurs-with', weight: 0.3 });
            strongPairs.add(pairKey); // one weak edge per sentence pair
          }
        }
      }
    }

    return results;
  }

  // ─── Core DB Operations ──────────────────────────────────────────────────────

  /** Find or create an entity by name; returns its ID. */
  private upsertEntity(name: string, type: string): string {
    const now = new Date().toISOString();
    const lower = name.trim().toLowerCase();

    // Check existing by normalized name
    const row = this.db
      .prepare(`SELECT id FROM entities WHERE lower(name) = ? LIMIT 1`)
      .get(lower) as { id: string } | undefined;

    if (row) {
      this.db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(now, row.id);
      return row.id;
    }

    // Create new
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO entities (id, name, type, aliases, metadata, created_at, updated_at)
         VALUES (?, ?, ?, '[]', '{}', ?, ?)`,
      )
      .run(id, name.trim(), type, now, now);
    return id;
  }

  /**
   * Main integration hook: extract entities & relationships from `content`,
   * then link everything to `memoryId` in the graph DB.
   */
  async extractAndLink(memoryId: string, content: string): Promise<void> {
    const now = new Date().toISOString();
    const extracted = this.extractEntities(content);
    if (extracted.length === 0) return;

    // Upsert entities + create mentions in a single transaction
    const insertMention = this.db.prepare(
      `INSERT OR IGNORE INTO entity_mentions (entity_id, memory_id, created_at) VALUES (?, ?, ?)`,
    );
    const insertRel = this.db.prepare(
      `INSERT OR IGNORE INTO relationships
         (id, source_entity, target_entity, relation, weight, metadata, memory_id, created_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
    );

    const doWork = this.db.transaction(() => {
      const entityIds: Array<{ name: string; id: string }> = [];

      for (const ent of extracted) {
        const eid = this.upsertEntity(ent.name, ent.type);
        entityIds.push({ name: ent.name, id: eid });
        insertMention.run(eid, memoryId, now);
      }

      const rels = this.extractRelationships(content, extracted);
      for (const rel of rels) {
        const src = entityIds.find(e => e.name.toLowerCase() === rel.source.toLowerCase());
        const tgt = entityIds.find(e => e.name.toLowerCase() === rel.target.toLowerCase());
        if (src && tgt && src.id !== tgt.id) {
          // Check for duplicate (same triple + memory)
          const exists = this.db
            .prepare(
              `SELECT id FROM relationships
               WHERE source_entity=? AND target_entity=? AND relation=? AND memory_id=?
               LIMIT 1`,
            )
            .get(src.id, tgt.id, rel.relation, memoryId);
          if (!exists) {
            insertRel.run(uuidv4(), src.id, tgt.id, rel.relation, rel.weight, memoryId, now);
          }
        }
      }
    });

    doWork();
  }

  // ─── Query API ───────────────────────────────────────────────────────────────

  /** Look up an entity by name (case-insensitive, partial OK). */
  getEntity(name: string): Entity | null {
    const exact = this.db
      .prepare(`SELECT * FROM entities WHERE lower(name) = lower(?) LIMIT 1`)
      .get(name) as any;
    if (exact) return this.rowToEntity(exact);

    const partial = this.db
      .prepare(`SELECT * FROM entities WHERE lower(name) LIKE lower(?) ORDER BY length(name) LIMIT 1`)
      .get(`%${name}%`) as any;
    return partial ? this.rowToEntity(partial) : null;
  }

  /** Return all relationships involving `entityId`, with the other entity attached. */
  getRelationships(entityId: string): Array<{
    relationship: Relationship;
    otherEntity: Entity;
    direction: 'outgoing' | 'incoming';
  }> {
    const outRows = this.db
      .prepare(
        `SELECT r.*,
                e.id as eid, e.name as ename, e.type as etype,
                e.aliases as ealiases, e.metadata as emetadata,
                e.created_at as ecreated_at, e.updated_at as eupdated_at
         FROM relationships r JOIN entities e ON r.target_entity = e.id
         WHERE r.source_entity = ? ORDER BY r.weight DESC`,
      )
      .all(entityId) as any[];

    const inRows = this.db
      .prepare(
        `SELECT r.*,
                e.id as eid, e.name as ename, e.type as etype,
                e.aliases as ealiases, e.metadata as emetadata,
                e.created_at as ecreated_at, e.updated_at as eupdated_at
         FROM relationships r JOIN entities e ON r.source_entity = e.id
         WHERE r.target_entity = ? ORDER BY r.weight DESC`,
      )
      .all(entityId) as any[];

    const expand = (row: any, dir: 'outgoing' | 'incoming') => ({
      relationship: this.rowToRelationship(row),
      otherEntity: {
        id: row.eid, name: row.ename, type: row.etype,
        aliases: JSON.parse(row.ealiases || '[]'),
        metadata: JSON.parse(row.emetadata || '{}'),
        createdAt: row.ecreated_at, updatedAt: row.eupdated_at,
      } as Entity,
      direction: dir,
    });

    return [
      ...outRows.map(r => expand(r, 'outgoing')),
      ...inRows.map(r => expand(r, 'incoming')),
    ];
  }

  /** Memory IDs linked to a specific entity. */
  getLinkedMemoryIds(entityId: string): string[] {
    return (
      this.db
        .prepare(`SELECT memory_id FROM entity_mentions WHERE entity_id = ?`)
        .all(entityId) as { memory_id: string }[]
    ).map(r => r.memory_id);
  }

  /** Memory IDs linked to any of the provided entity IDs (for graph boost). */
  getMemoryIdsForEntities(entityIds: string[]): string[] {
    if (entityIds.length === 0) return [];
    const ph = entityIds.map(() => '?').join(',');
    return (
      this.db
        .prepare(`SELECT DISTINCT memory_id FROM entity_mentions WHERE entity_id IN (${ph})`)
        .all(...entityIds) as { memory_id: string }[]
    ).map(r => r.memory_id);
  }

  /**
   * BFS traversal of the graph from `startName` up to `maxDepth` hops.
   * Returns nodes in BFS order with depth and via-relation info.
   */
  traverse(
    startName: string,
    maxDepth = 2,
  ): Array<{ entity: Entity; depth: number; viaRelation?: string; fromEntity?: string }> {
    const start = this.getEntity(startName);
    if (!start) return [];

    const visited = new Set<string>();
    const queue: Array<{
      entityId: string;
      depth: number;
      viaRelation?: string;
      fromEntity?: string;
    }> = [{ entityId: start.id, depth: 0 }];

    const result: Array<{
      entity: Entity;
      depth: number;
      viaRelation?: string;
      fromEntity?: string;
    }> = [];

    while (queue.length > 0) {
      const { entityId, depth, viaRelation, fromEntity } = queue.shift()!;
      if (visited.has(entityId) || depth > maxDepth) continue;
      visited.add(entityId);

      const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(entityId) as any;
      if (!row) continue;

      result.push({ entity: this.rowToEntity(row), depth, viaRelation, fromEntity });

      if (depth < maxDepth) {
        for (const { relationship, otherEntity, direction } of this.getRelationships(entityId)) {
          if (!visited.has(otherEntity.id)) {
            const label =
              direction === 'outgoing'
                ? `→${relationship.relation}→`
                : `←${relationship.relation}←`;
            queue.push({
              entityId: otherEntity.id,
              depth: depth + 1,
              viaRelation: label,
              fromEntity: row.name as string,
            });
          }
        }
      }
    }

    return result;
  }

  /** Fuzzy entity search by name. */
  searchEntities(query: string): Entity[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM entities
           WHERE lower(name) LIKE lower(?) OR lower(aliases) LIKE lower(?)
           ORDER BY name LIMIT 20`,
        )
        .all(`%${query}%`, `%${query}%`) as any[]
    ).map(r => this.rowToEntity(r));
  }

  /** Aggregate stats for the graph. */
  stats(): {
    entityCount: number;
    relationshipCount: number;
    mentionCount: number;
    topEntities: Array<{ name: string; type: string; connections: number }>;
    byType: Record<string, number>;
  } {
    const entityCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM entities`).get() as { c: number }
    ).c;
    const relationshipCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM relationships`).get() as { c: number }
    ).c;
    const mentionCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM entity_mentions`).get() as { c: number }
    ).c;

    const topEntities = this.db
      .prepare(
        `SELECT e.name, e.type,
                (SELECT COUNT(*) FROM relationships WHERE source_entity=e.id OR target_entity=e.id) as connections
         FROM entities e
         ORDER BY connections DESC
         LIMIT 10`,
      )
      .all() as Array<{ name: string; type: string; connections: number }>;

    const byType: Record<string, number> = {};
    for (const row of this.db
      .prepare(`SELECT type, COUNT(*) as c FROM entities GROUP BY type`)
      .all() as Array<{ type: string; c: number }>) {
      byType[row.type] = row.c;
    }

    return { entityCount, relationshipCount, mentionCount, topEntities, byType };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private rowToEntity(row: any): Entity {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      aliases: JSON.parse(row.aliases || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToRelationship(row: any): Relationship {
    return {
      id: row.id,
      sourceEntity: row.source_entity,
      targetEntity: row.target_entity,
      relation: row.relation,
      weight: row.weight,
      metadata: JSON.parse(row.metadata || '{}'),
      memoryId: row.memory_id,
      createdAt: row.created_at,
    };
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
