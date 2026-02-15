const WEIGHTS = {
  vector: 0.4,
  bm25: 0.3,
  recency: 0.2,
  importance: 0.1,
};

export function computeRecencyScore(dateStr: string): number {
  const ageMs = Date.now() - new Date(dateStr).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Exponential decay: half-life of 30 days
  return Math.exp(-0.693 * ageDays / 30);
}

export function computeHybridScore(
  vectorSim: number,
  bm25Score: number,
  recencyScore: number,
  importance: number,
): number {
  return (
    WEIGHTS.vector * vectorSim +
    WEIGHTS.bm25 * bm25Score +
    WEIGHTS.recency * recencyScore +
    WEIGHTS.importance * importance
  );
}

export function normalizeBm25Scores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  if (max === 0) return scores.map(() => 0);
  return scores.map(s => s / max);
}
