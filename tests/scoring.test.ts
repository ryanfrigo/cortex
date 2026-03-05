import { describe, it, expect } from 'vitest';
import {
  computeRecencyScore,
  computeAccessFrequencyScore,
  computeTypeBoost,
  computeHybridScore,
  normalizeBm25Scores,
} from '../src/scoring.js';

describe('computeRecencyScore', () => {
  it('returns ~1.0 for now', () => {
    const score = computeRecencyScore(new Date().toISOString());
    expect(score).toBeGreaterThan(0.99);
  });

  it('returns ~0.5 after 14 days (half-life)', () => {
    const d = new Date(Date.now() - 14 * 86400000).toISOString();
    const score = computeRecencyScore(d);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it('decays toward 0 over time', () => {
    const d = new Date(Date.now() - 365 * 86400000).toISOString();
    const score = computeRecencyScore(d);
    expect(score).toBeLessThan(0.01);
  });

  it('more recent > less recent', () => {
    const recent = computeRecencyScore(new Date(Date.now() - 86400000).toISOString());
    const old = computeRecencyScore(new Date(Date.now() - 30 * 86400000).toISOString());
    expect(recent).toBeGreaterThan(old);
  });
});

describe('computeAccessFrequencyScore', () => {
  it('returns 0 for zero accesses', () => {
    expect(computeAccessFrequencyScore(0)).toBe(0); // log2(1)/5 = 0
  });

  it('caps at 1.0', () => {
    expect(computeAccessFrequencyScore(1000)).toBe(1.0);
  });

  it('increases with access count', () => {
    expect(computeAccessFrequencyScore(10)).toBeGreaterThan(computeAccessFrequencyScore(1));
  });
});

describe('computeTypeBoost', () => {
  it('decision and lesson get 1.0', () => {
    expect(computeTypeBoost('decision')).toBe(1.0);
    expect(computeTypeBoost('lesson')).toBe(1.0);
  });

  it('fact gets 0.8', () => {
    expect(computeTypeBoost('fact')).toBe(0.8);
  });

  it('semantic defaults to 0.5', () => {
    expect(computeTypeBoost('semantic')).toBe(0.5);
  });
});

describe('computeHybridScore', () => {
  it('returns a number between 0 and 1', () => {
    const score = computeHybridScore(0.8, 0.5, 0.9, 0.7, 5, 'semantic');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('higher vector sim → higher score', () => {
    const low = computeHybridScore(0.2, 0.5, 0.5, 0.5, 0, 'semantic');
    const high = computeHybridScore(0.9, 0.5, 0.5, 0.5, 0, 'semantic');
    expect(high).toBeGreaterThan(low);
  });

  it('higher bm25 → higher score', () => {
    const low = computeHybridScore(0.5, 0.1, 0.5, 0.5, 0, 'semantic');
    const high = computeHybridScore(0.5, 0.9, 0.5, 0.5, 0, 'semantic');
    expect(high).toBeGreaterThan(low);
  });

  it('all zeros gives near-zero score', () => {
    const score = computeHybridScore(0, 0, 0, 0, 0, 'semantic');
    // typeBoost still adds 0.05 * 0.5 = 0.025
    expect(score).toBeLessThan(0.05);
  });
});

describe('normalizeBm25Scores', () => {
  it('normalizes to [0,1] range', () => {
    const scores = normalizeBm25Scores([10, 5, 2]);
    expect(scores[0]).toBe(1.0);
    expect(scores[1]).toBe(0.5);
    expect(scores[2]).toBe(0.2);
  });

  it('handles empty array', () => {
    expect(normalizeBm25Scores([])).toEqual([]);
  });

  it('handles all zeros', () => {
    expect(normalizeBm25Scores([0, 0])).toEqual([0, 0]);
  });

  it('single element normalizes to 1', () => {
    expect(normalizeBm25Scores([42])).toEqual([1]);
  });
});
