import type { MemoryType } from './types.js';

const WEIGHTS = {
  vector: 0.35,
  bm25: 0.3,
  recency: 0.15,
  importance: 0.1,
  accessFrequency: 0.05,
  typeBoost: 0.05,
};

const TYPE_BOOSTS: Record<string, number> = {
  decision: 1.0,
  lesson: 1.0,
  belief: 0.9,
  reflection: 0.8,
  shadow: 0.8,
  fact: 0.8,
  preference: 0.7,
  episodic: 0.5,
  semantic: 0.5,
  procedural: 0.5,
  'project-state': 0.5,
  person: 0.5,
};

export function computeRecencyScore(dateStr: string): number {
  const ageMs = Date.now() - new Date(dateStr).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Exponential decay: half-life of 14 days
  return Math.exp(-0.693 * ageDays / 14);
}

export function computeAccessFrequencyScore(accessCount: number): number {
  // Logarithmic scale so it doesn't dominate
  return Math.min(1.0, Math.log2(accessCount + 1) / 5);
}

export function computeTypeBoost(type: MemoryType): number {
  return TYPE_BOOSTS[type] ?? 0.5;
}

export function computeHybridScore(
  vectorSim: number,
  bm25Score: number,
  recencyScore: number,
  importance: number,
  accessCount: number = 0,
  type: MemoryType = 'semantic',
): number {
  return (
    WEIGHTS.vector * vectorSim +
    WEIGHTS.bm25 * bm25Score +
    WEIGHTS.recency * recencyScore +
    WEIGHTS.importance * importance +
    WEIGHTS.accessFrequency * computeAccessFrequencyScore(accessCount) +
    WEIGHTS.typeBoost * computeTypeBoost(type)
  );
}

export function normalizeBm25Scores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  if (max === 0) return scores.map(() => 0);
  return scores.map(s => s / max);
}
