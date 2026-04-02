/**
 * ContradictionDetector — local-first contradiction detection for Cortex memories.
 *
 * Uses SQLite (better-sqlite3) for persistence, zero external API calls.
 * Heuristics: negation patterns, numerical disagreement, status-word opposites,
 * and temporal supersession detection.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { Memory } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Contradiction {
  id: string;
  memory_a: string;          // memory ID
  memory_b: string;          // memory ID
  score: number;             // 0.0–1.0
  type: 'negation' | 'numerical' | 'status' | 'temporal' | 'semantic';
  description: string;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Map of status words → their opposites */
const STATUS_OPPOSITES: Record<string, string[]> = {
  working:       ['broken', 'not working', 'down', 'failed', 'failing', 'crashed', 'busted'],
  broken:        ['working', 'fixed', 'repaired', 'resolved', 'functional'],
  deployed:      ['not deployed', 'undeployed', 'down', 'offline', 'pending deployment'],
  undeployed:    ['deployed', 'live', 'running'],
  live:          ['down', 'offline', 'dead', 'not live'],
  down:          ['live', 'up', 'online', 'running', 'working'],
  active:        ['inactive', 'disabled', 'off', 'deactivated', 'paused'],
  inactive:      ['active', 'enabled', 'running'],
  enabled:       ['disabled', 'off', 'deactivated'],
  disabled:      ['enabled', 'on', 'active'],
  connected:     ['disconnected', 'offline', 'not connected'],
  disconnected:  ['connected', 'online'],
  passing:       ['failing', 'failed', 'broken'],
  failing:       ['passing', 'working', 'fixed'],
  healthy:       ['unhealthy', 'sick', 'down', 'broken'],
  success:       ['failure', 'failed', 'error', 'unsuccessful'],
  failed:        ['succeeded', 'success', 'working', 'passing'],
  open:          ['closed', 'shut', 'resolved'],
  closed:        ['open', 'active', 'unresolved'],
  available:     ['unavailable', 'down', 'offline'],
  unavailable:   ['available', 'up', 'online'],
  complete:      ['incomplete', 'in progress', 'pending', 'unfinished'],
  incomplete:    ['complete', 'done', 'finished'],
  running:       ['stopped', 'crashed', 'halted', 'terminated'],
  stopped:       ['running', 'started', 'active'],
  secure:        ['insecure', 'vulnerable', 'exposed'],
  insecure:      ['secure', 'safe', 'protected'],
  profitable:    ['unprofitable', 'losing money', 'in the red'],
  unprofitable:  ['profitable', 'making money', 'in the black'],
};

/** Negation words/patterns to check */
const NEGATION_PATTERNS: RegExp[] = [
  /\bnot\b/i,
  /\bno\b/i,
  /\bnever\b/i,
  /\bdoesn't\b/i,
  /\bdon't\b/i,
  /\bwon't\b/i,
  /\bcan't\b/i,
  /\bcannot\b/i,
  /\bisn't\b/i,
  /\baren't\b/i,
  /\bhasn't\b/i,
  /\bhaven't\b/i,
  /\bneither\b/i,
  /\bnor\b/i,
  /\bwithout\b/i,
  /\bunable\b/i,
  /\bfails?\b/i,
  /\w+n't\b/,    // contractions like doesn't, can't, etc.
];

/** English stop words to exclude from content-word comparison */
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','being','have','has','had','do',
  'does','did','will','would','could','should','may','might','shall',
  'that','this','these','those','it','its','i','we','you','he','she',
  'they','my','our','your','his','her','their','as','by','from','up',
  'about','into','through','during','before','after','then','if','when',
  'while','so','just','than','also','both','each','few','more','most',
  'other','some','such','only','own','same','very','still','yet','even',
  'already','back','over','under','again','further','once','here','there',
  'where','why','how','all','any','what','which','who','whom','whose',
  'am','now','new','old','one','two','three','four','five','six','seven',
  'eight','nine','ten','many','much','long','great','little','own',
]);

// ── ContradictionDetector ────────────────────────────────────────────────────

export class ContradictionDetector {
  private db: Database.Database;

  constructor(cortexDir?: string) {
    const dir = cortexDir ?? join(homedir(), '.cortex');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'contradictions.db');
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contradictions (
        id          TEXT PRIMARY KEY,
        memory_a    TEXT NOT NULL,
        memory_b    TEXT NOT NULL,
        score       REAL NOT NULL,
        type        TEXT NOT NULL,
        description TEXT NOT NULL,
        resolution  TEXT,
        resolved_at TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contra_a      ON contradictions(memory_a);
      CREATE INDEX IF NOT EXISTS idx_contra_b      ON contradictions(memory_b);
      CREATE INDEX IF NOT EXISTS idx_contra_resolved ON contradictions(resolved_at);
      CREATE INDEX IF NOT EXISTS idx_contra_score  ON contradictions(score DESC);
    `);
  }

  // ── Text Analysis Primitives ─────────────────────────────────────────────

  /** Split content into atomic sentence-level claims */
  private extractSentences(content: string): string[] {
    return content
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 8 && s.split(/\s+/).length >= 3);
  }

  /** Extract meaningful content words (strip stop words, normalise) */
  private contentWords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  /** Jaccard similarity between two word lists */
  private jaccard(wordsA: string[], wordsB: string[]): number {
    if (wordsA.length === 0 && wordsB.length === 0) return 1;
    if (wordsA.length === 0 || wordsB.length === 0) return 0;
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    const intersection = [...setA].filter(w => setB.has(w)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  /** Check whether a sentence contains negation */
  private hasNegation(sentence: string): boolean {
    return NEGATION_PATTERNS.some(p => p.test(sentence));
  }

  /**
   * Extract numbers with context from text.
   * Handles: $49, $1,000, $1.5M, $1k, 50%, 10 users, 3 errors, etc.
   */
  private extractNumbers(text: string): Array<{ value: number; raw: string; context: string }> {
    const results: Array<{ value: number; raw: string; context: string }> = [];

    const snippet = (idx: number, len: number) =>
      text.slice(Math.max(0, idx - 20), idx + len + 20);

    // Dollar amounts: $49, $1,000, $1.5M, $1k
    const dollarRe = /\$(\d[\d,]*(?:\.\d+)?(?:[kKmMbB])?)/g;
    let m: RegExpExecArray | null;
    while ((m = dollarRe.exec(text)) !== null) {
      const raw = m[1].replace(/,/g, '').toLowerCase();
      let val = parseFloat(raw);
      if (raw.endsWith('k')) val *= 1_000;
      else if (raw.endsWith('m')) val *= 1_000_000;
      else if (raw.endsWith('b')) val *= 1_000_000_000;
      if (!isNaN(val)) results.push({ value: val, raw: m[0], context: snippet(m.index, m[0].length) });
    }

    // Percentages: 15%, 50.5%
    const pctRe = /(\d+(?:\.\d+)?)\s*%/g;
    while ((m = pctRe.exec(text)) !== null) {
      results.push({ value: parseFloat(m[1]), raw: m[0], context: snippet(m.index, m[0].length) });
    }

    // Counts with labels: "10 users", "5 items", "0 errors"
    const countRe = /\b(\d+)\s+(users?|items?|errors?|members?|customers?|installs?|downloads?|repos?|followers?|stars?|issues?|bugs?|days?|hours?|months?|years?|weeks?|records?|rows?|entries)\b/gi;
    while ((m = countRe.exec(text)) !== null) {
      results.push({ value: parseFloat(m[1]), raw: m[0], context: snippet(m.index, m[0].length) });
    }

    return results;
  }

  // ── Contradiction Scoring ────────────────────────────────────────────────

  /**
   * Score contradiction between two memory contents.
   * Returns null if no meaningful contradiction detected (score < threshold).
   */
  scoreContradiction(contentA: string, contentB: string): {
    score: number;
    type: Contradiction['type'];
    description: string;
  } | null {
    let maxScore = 0;
    let bestType: Contradiction['type'] = 'semantic';
    let bestDescription = '';

    const wordsA = this.contentWords(contentA);
    const wordsB = this.contentWords(contentB);
    const globalOverlap = this.jaccard(wordsA, wordsB);

    // ── 1. Negation pattern detection (sentence-level) ──────────────────────
    const sentencesA = this.extractSentences(contentA);
    const sentencesB = this.extractSentences(contentB);

    for (const sA of sentencesA) {
      const wA = this.contentWords(sA);
      const negA = this.hasNegation(sA);

      for (const sB of sentencesB) {
        const wB = this.contentWords(sB);
        const negB = this.hasNegation(sB);
        const sim = this.jaccard(wA, wB);

        // High content-word overlap but one has negation and the other doesn't
        if (sim > 0.45 && negA !== negB) {
          const score = Math.min(0.95, 0.45 + sim * 0.75);
          if (score > maxScore) {
            maxScore = score;
            bestType = 'negation';
            bestDescription =
              `Negation mismatch (${(sim * 100).toFixed(0)}% word overlap): ` +
              `"${sA.slice(0, 70)}" vs "${sB.slice(0, 70)}"`;
          }
        }
      }
    }

    // ── 2. Status-word contradiction ─────────────────────────────────────────
    if (globalOverlap > 0.15) {
      const aLow = contentA.toLowerCase();
      const bLow = contentB.toLowerCase();

      for (const [word, opposites] of Object.entries(STATUS_OPPOSITES)) {
        if (aLow.includes(word) && opposites.some(o => bLow.includes(o))) {
          const score = Math.min(0.9, 0.4 + globalOverlap * 0.7);
          if (score > maxScore) {
            maxScore = score;
            bestType = 'status';
            bestDescription =
              `Status contradiction: "${word}" vs its opposite (topic overlap ${(globalOverlap * 100).toFixed(0)}%)`;
          }
        }
        if (bLow.includes(word) && opposites.some(o => aLow.includes(o))) {
          const score = Math.min(0.9, 0.4 + globalOverlap * 0.7);
          if (score > maxScore) {
            maxScore = score;
            bestType = 'status';
            bestDescription =
              `Status contradiction: "${word}" vs its opposite (topic overlap ${(globalOverlap * 100).toFixed(0)}%)`;
          }
        }
      }
    }

    // ── 3. Numerical contradiction ─────────────────────────────────────────
    if (globalOverlap > 0.25) {
      const numsA = this.extractNumbers(contentA);
      const numsB = this.extractNumbers(contentB);

      for (const nA of numsA) {
        for (const nB of numsB) {
          if (nA.value === nB.value) continue;
          const larger = Math.max(nA.value, nB.value);
          const smaller = Math.min(nA.value, nB.value);
          const ratio = smaller === 0 ? 10 : larger / smaller;
          // Flag if ratio > 1.5 OR > 1.1 with high overlap
          if (ratio > 1.5 || (ratio > 1.1 && globalOverlap > 0.5)) {
            const score = Math.min(0.92, 0.35 + globalOverlap * 0.7);
            if (score > maxScore) {
              maxScore = score;
              bestType = 'numerical';
              bestDescription =
                `Numerical disagreement: ${nA.raw} vs ${nB.raw} ` +
                `on same topic (${(globalOverlap * 100).toFixed(0)}% word overlap)`;
            }
          }
        }
      }
    }

    if (maxScore < 0.3) return null;
    return { score: maxScore, type: bestType, description: bestDescription };
  }

  /**
   * Score temporal supersession: two memories about the same topic with
   * contradictory facts, separated in time.
   */
  scoreTemporalContradiction(
    contentA: string, contentB: string,
    createdAtA: string, createdAtB: string,
  ): { score: number; type: Contradiction['type']; description: string } | null {
    const overlap = this.jaccard(
      this.contentWords(contentA),
      this.contentWords(contentB),
    );
    if (overlap < 0.35) return null;

    const base = this.scoreContradiction(contentA, contentB);
    if (!base || base.score < 0.45) return null;

    const dateA = new Date(createdAtA).getTime();
    const dateB = new Date(createdAtB).getTime();
    const daysDiff = Math.abs(dateA - dateB) / (1000 * 60 * 60 * 24);

    if (daysDiff < 0.001) return null; // same moment — not temporal

    const newerLabel = dateA > dateB ? 'A is newer' : 'B is newer';
    return {
      score: Math.min(0.98, base.score + 0.08),
      type: 'temporal',
      description:
        `Temporal supersession (${daysDiff.toFixed(1)}d apart, ${newerLabel}): ${base.description}`,
    };
  }

  // ── Database Operations ──────────────────────────────────────────────────

  /** Upsert: store new or update existing unresolved contradiction */
  private storeContradiction(
    memoryAId: string,
    memoryBId: string,
    score: number,
    type: Contradiction['type'],
    description: string,
  ): Contradiction {
    // Check if an unresolved entry already exists for this pair
    const existing = this.db.prepare(`
      SELECT * FROM contradictions
      WHERE ((memory_a = ? AND memory_b = ?) OR (memory_a = ? AND memory_b = ?))
        AND resolved_at IS NULL
      LIMIT 1
    `).get(memoryAId, memoryBId, memoryBId, memoryAId) as Contradiction | undefined;

    if (existing) {
      if (score > existing.score) {
        this.db.prepare(`
          UPDATE contradictions SET score = ?, description = ? WHERE id = ?
        `).run(score, description, existing.id);
        return { ...existing, score, description };
      }
      return existing;
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO contradictions
        (id, memory_a, memory_b, score, type, description, resolution, resolved_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(id, memoryAId, memoryBId, score, type, description, now);

    return {
      id, memory_a: memoryAId, memory_b: memoryBId,
      score, type, description,
      resolution: null, resolved_at: null, created_at: now,
    };
  }

  /** Get all unresolved contradictions, sorted by score descending */
  getUnresolved(): Contradiction[] {
    return this.db.prepare(`
      SELECT * FROM contradictions
      WHERE resolved_at IS NULL
      ORDER BY score DESC, created_at DESC
    `).all() as Contradiction[];
  }

  /** Get all contradictions (resolved and unresolved) for a specific memory */
  getForMemory(memoryId: string): Contradiction[] {
    return this.db.prepare(`
      SELECT * FROM contradictions
      WHERE memory_a = ? OR memory_b = ?
      ORDER BY score DESC
    `).all(memoryId, memoryId) as Contradiction[];
  }

  /** Resolve a contradiction by ID */
  resolveContradiction(id: string, resolution: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE contradictions
      SET resolution = ?, resolved_at = ?
      WHERE id = ?
    `).run(resolution, now, id);
    return result.changes > 0;
  }

  /** Find a contradiction by full UUID or ID prefix */
  getById(id: string): Contradiction | null {
    if (id.length === 36) {
      return this.db.prepare(`SELECT * FROM contradictions WHERE id = ?`).get(id) as Contradiction | null;
    }
    return this.db.prepare(`SELECT * FROM contradictions WHERE id LIKE ?`).get(`${id}%`) as Contradiction | null;
  }

  /** All contradictions (for debugging) */
  getAll(): Contradiction[] {
    return this.db.prepare(`SELECT * FROM contradictions ORDER BY created_at DESC`).all() as Contradiction[];
  }

  // ── Main Integration API ─────────────────────────────────────────────────

  /**
   * Check a newly saved memory against a list of similar existing memories.
   * Stores any detected contradictions. Returns the list of new contradictions found.
   */
  checkAgainstMemories(newMemory: Memory, similarMemories: Memory[]): Contradiction[] {
    const detected: Contradiction[] = [];

    for (const existing of similarMemories) {
      if (existing.id === newMemory.id) continue;

      // Try temporal supersession first (it builds on top of the base check)
      const temporal = this.scoreTemporalContradiction(
        newMemory.content, existing.content,
        newMemory.createdAt, existing.createdAt,
      );

      if (temporal) {
        const stored = this.storeContradiction(
          newMemory.id, existing.id,
          temporal.score, temporal.type, temporal.description,
        );
        detected.push(stored);
        continue; // Don't double-count as generic contradiction
      }

      // Generic contradiction check
      const result = this.scoreContradiction(newMemory.content, existing.content);
      if (result) {
        const stored = this.storeContradiction(
          newMemory.id, existing.id,
          result.score, result.type, result.description,
        );
        detected.push(stored);
      }
    }

    return detected;
  }

  /**
   * Auto-supersede logic for beliefs:
   * - If new belief contradicts old and new has >= confidence → retire old
   * - If score > 0.8 and same domain → auto-resolve the contradiction entry
   * - Otherwise leave unresolved for manual review
   *
   * `engine` is typed `any` to avoid a circular import (engine imports this file).
   */
  async autoSupersedeBelief(
    newBelief: Memory,
    oldBelief: Memory,
    contradictionScore: number,
    engine: any,
  ): Promise<void> {
    const newMeta = (newBelief.metadata ?? {}) as any;
    const oldMeta = (oldBelief.metadata ?? {}) as any;

    const newConf: number = newMeta.confidence ?? 0.5;
    const oldConf: number = oldMeta.confidence ?? 0.5;
    const sameDomain: boolean = !!newMeta.domain && newMeta.domain === oldMeta.domain;

    if (newConf >= oldConf) {
      // Retire the old belief
      const now = new Date().toISOString();
      const retiredMeta = {
        ...oldMeta,
        status: 'retired',
        supersededBy: newBelief.id,
        retired_at: now,
        history: [
          ...(oldMeta.history ?? []),
          {
            date: now,
            confidence: oldConf,
            reason: `Superseded by ${newBelief.id.slice(0, 8)} (contradiction score: ${contradictionScore.toFixed(2)})`,
          },
        ],
      };
      await engine.update(oldBelief.id, { metadata: retiredMeta });

      // Update new belief to reference what it supersedes
      const newUpdatedMeta = { ...newMeta, supersedes: oldBelief.id };
      await engine.update(newBelief.id, { metadata: newUpdatedMeta });

      // Auto-resolve contradiction if high score + same domain
      if (contradictionScore > 0.8 && sameDomain) {
        const related = this.getForMemory(newBelief.id);
        for (const c of related) {
          const isPair =
            (c.memory_a === newBelief.id && c.memory_b === oldBelief.id) ||
            (c.memory_b === newBelief.id && c.memory_a === oldBelief.id);
          if (isPair && !c.resolved_at) {
            this.resolveContradiction(
              c.id,
              `Auto-resolved: belief ${newBelief.id.slice(0, 8)} superseded ${oldBelief.id.slice(0, 8)}`,
            );
          }
        }
      }
    }
    // If new confidence < old → flag for review (leave unresolved)
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
