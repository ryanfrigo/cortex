/**
 * Regression Guard — compares latest benchmark with previous run
 * Exits 1 if any metric drops more than 5%
 *
 * Usage: npx tsx bench/regression-check.ts
 */

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(__dirname, 'results');

const METRICS = ['recall_at_1', 'recall_at_5', 'recall_at_10', 'mrr'] as const;
const THRESHOLD = 0.05; // 5% drop threshold

function loadResults(): Array<{ date: string; data: any }> {
  try {
    const files = readdirSync(resultsDir)
      .filter(f => f.endsWith('.json'))
      .sort();
    return files.map(f => ({
      date: f.replace('.json', ''),
      data: JSON.parse(readFileSync(join(resultsDir, f), 'utf-8')),
    }));
  } catch {
    return [];
  }
}

function main() {
  const results = loadResults();

  if (results.length < 2) {
    console.log('Not enough benchmark results for regression check (need at least 2).');
    console.log(`Found ${results.length} result(s).`);
    process.exit(0);
  }

  const prev = results[results.length - 2];
  const curr = results[results.length - 1];

  console.log(`Comparing: ${prev.date} → ${curr.date}\n`);

  let hasRegression = false;

  for (const metric of METRICS) {
    const prevVal = prev.data[metric] ?? 0;
    const currVal = curr.data[metric] ?? 0;
    const diff = currVal - prevVal;
    const icon = diff < -THRESHOLD ? '🔴' : diff < 0 ? '🟡' : '🟢';

    console.log(`${icon} ${metric.padEnd(14)} ${prevVal.toFixed(3)} → ${currVal.toFixed(3)} (${diff >= 0 ? '+' : ''}${diff.toFixed(3)})`);

    if (diff < -THRESHOLD) {
      hasRegression = true;
    }
  }

  // Check latency regression (> 50% slower)
  const prevLatency = prev.data.avg_latency_ms ?? 0;
  const currLatency = curr.data.avg_latency_ms ?? 0;
  if (prevLatency > 0) {
    const latencyRatio = currLatency / prevLatency;
    const latencyIcon = latencyRatio > 1.5 ? '🔴' : latencyRatio > 1.2 ? '🟡' : '🟢';
    console.log(`${latencyIcon} avg_latency    ${prevLatency}ms → ${currLatency}ms (${latencyRatio.toFixed(2)}x)`);
    if (latencyRatio > 1.5) hasRegression = true;
  }

  console.log();
  if (hasRegression) {
    console.log('❌ REGRESSION DETECTED — quality dropped more than threshold');
    process.exit(1);
  } else {
    console.log('✅ No regression detected');
    process.exit(0);
  }
}

main();
