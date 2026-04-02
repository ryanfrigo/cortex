/**
 * Recall Benchmark — measures search quality against ground-truth Q&A pairs
 * Uses the real ~/.cortex/lance_db with 30K+ memories
 *
 * Usage: npx tsx bench/recall-benchmark.ts
 */

import { MemoryEngine } from '../src/engine.js';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TestCase {
  query: string;
  expectedKeywords: string[];  // at least one must appear in a result's content
  namespace?: string;          // optional namespace hint
  category: string;
}

const TEST_CASES: TestCase[] = [
  // Food / Health
  { query: "What did the user eat for breakfast?", expectedKeywords: ["breakfast", "oatmeal", "eggs", "ate", "meal", "food"], namespace: "health", category: "health" },
  { query: "User's morning meal routine", expectedKeywords: ["breakfast", "oatmeal", "eggs", "morning", "meal", "ate"], namespace: "health", category: "health" },
  { query: "Any health or fitness notes?", expectedKeywords: ["health", "fitness", "gym", "workout", "exercise", "weight", "run"], namespace: "health", category: "health" },

  // Projects
  { query: "What's the MyApp tech stack?", expectedKeywords: ["myapp", "next.js", "convex", "vapi", "stripe"], namespace: "projects", category: "projects" },
  { query: "MyApp architecture and technologies", expectedKeywords: ["myapp", "next.js", "convex", "vapi", "twilio"], namespace: "projects", category: "projects" },
  { query: "What is Market?", expectedKeywords: ["market", "marketplace", "x402", "agent"], namespace: "projects", category: "projects" },
  { query: "Kalshi trading bot details", expectedKeywords: ["kalshi", "trading", "bot", "compounder", "portfolio"], namespace: "projects", category: "projects" },
  { query: "What's Debate?", expectedKeywords: ["debate", "ai", "openrouter"], namespace: "projects", category: "projects" },
  { query: "Cortex memory system", expectedKeywords: ["cortex", "memory", "lancedb", "vector", "search", "mcp"], namespace: "projects", category: "projects" },

  // Personal / Relationships
  { query: "When did the user break up?", expectedKeywords: ["breakup", "broke up", "relationship", "split"], category: "personal" },
  { query: "User's relationship history", expectedKeywords: ["relationship", "dating", "girlfriend", "broke"], category: "personal" },

  // Learnings
  { query: "What lesson did we learn about sub-agents?", expectedKeywords: ["sub-agent", "subagent", "agent", "lesson", "learn", "spawn"], category: "learnings" },
  { query: "Best practices for AI coding assistants", expectedKeywords: ["agent", "code", "assistant", "claude", "lesson", "practice"], category: "learnings" },
  { query: "Debugging tips and lessons", expectedKeywords: ["debug", "lesson", "systematic", "fix", "error", "bug"], category: "learnings" },

  // Factual
  { query: "What's the user's address?", expectedKeywords: ["address", "street", "city", "apartment", "san francisco", "sf", "live"], category: "factual" },
  { query: "User's phone number", expectedKeywords: ["phone", "number", "contact"], category: "factual" },
  { query: "What machine does the user use?", expectedKeywords: ["macbook", "m2", "mac", "laptop", "machine"], category: "factual" },

  // Semantic-only (paraphrased, no keyword overlap)
  { query: "tools for making money from prediction markets", expectedKeywords: ["kalshi", "trading", "bet", "market", "prediction"], category: "semantic" },
  { query: "automating video creation for social media", expectedKeywords: ["viral", "video", "tiktok", "remotion", "render", "videogen"], category: "semantic" },
  { query: "connecting AI assistants to external tools and APIs", expectedKeywords: ["mcp", "tool", "api", "integration", "server", "protocol"], category: "semantic" },
  { query: "managing personal knowledge over time", expectedKeywords: ["memory", "cortex", "knowledge", "note", "context", "recall"], category: "semantic" },
  { query: "earning revenue from AI voice products", expectedKeywords: ["myapp", "voice", "revenue", "stripe", "subscription", "pricing"], category: "semantic" },
];

interface BenchResult {
  date: string;
  recall_at_1: number;
  recall_at_5: number;
  recall_at_10: number;
  mrr: number;
  avg_latency_ms: number;
  namespace_precision_gain: number;
  per_query: Array<{
    query: string;
    category: string;
    found_at_rank: number | null;  // null = not found in top 10
    latency_ms: number;
    top_result_preview: string;
  }>;
  per_category: Record<string, { recall_at_5: number; mrr: number }>;
}

function matchesExpected(content: string, expectedKeywords: string[]): boolean {
  const lower = content.toLowerCase();
  return expectedKeywords.some(kw => lower.includes(kw.toLowerCase()));
}

async function runBenchmark(): Promise<BenchResult> {
  const engine = new MemoryEngine(); // uses default ~/.cortex/lance_db

  const perQuery: BenchResult['per_query'] = [];
  let hits1 = 0, hits5 = 0, hits10 = 0;
  let reciprocalRankSum = 0;
  let totalLatency = 0;

  // Namespace precision test
  let nsQueriesWithHint = 0, nsHitsWithHint = 0, nsHitsWithout = 0;

  console.log(`\nRunning ${TEST_CASES.length} benchmark queries...\n`);

  for (const tc of TEST_CASES) {
    const start = performance.now();
    const results = await engine.search({ query: tc.query, limit: 10 });
    const latency = performance.now() - start;
    totalLatency += latency;

    let foundRank: number | null = null;
    for (let i = 0; i < results.length; i++) {
      if (matchesExpected(results[i].memory.content, tc.expectedKeywords)) {
        foundRank = i + 1;
        break;
      }
    }

    if (foundRank !== null) {
      if (foundRank <= 1) hits1++;
      if (foundRank <= 5) hits5++;
      if (foundRank <= 10) hits10++;
      reciprocalRankSum += 1 / foundRank;
    }

    const icon = foundRank === null ? '❌' : foundRank <= 1 ? '✅' : foundRank <= 5 ? '🟡' : '🟠';
    console.log(`${icon} [${tc.category}] "${tc.query}" → rank ${foundRank ?? 'miss'} (${latency.toFixed(0)}ms)`);

    perQuery.push({
      query: tc.query,
      category: tc.category,
      found_at_rank: foundRank,
      latency_ms: Math.round(latency),
      top_result_preview: results[0]?.memory.content.slice(0, 100) ?? '(no results)',
    });

    // Namespace precision test
    if (tc.namespace) {
      nsQueriesWithHint++;
      const nsResults = await engine.search({ query: tc.query, namespace: tc.namespace, limit: 5 });
      const nsHit = nsResults.some(r => matchesExpected(r.memory.content, tc.expectedKeywords));
      const noNsHit = results.slice(0, 5).some(r => matchesExpected(r.memory.content, tc.expectedKeywords));
      if (nsHit) nsHitsWithHint++;
      if (noNsHit) nsHitsWithout++;
    }
  }

  const n = TEST_CASES.length;
  const recall1 = hits1 / n;
  const recall5 = hits5 / n;
  const recall10 = hits10 / n;
  const mrr = reciprocalRankSum / n;
  const avgLatency = totalLatency / n;
  const nsPrecisionGain = nsQueriesWithHint > 0
    ? (nsHitsWithHint - nsHitsWithout) / nsQueriesWithHint
    : 0;

  // Per-category breakdown
  const categories = [...new Set(TEST_CASES.map(tc => tc.category))];
  const perCategory: Record<string, { recall_at_5: number; mrr: number }> = {};
  for (const cat of categories) {
    const catQueries = perQuery.filter(q => q.category === cat);
    const catHits5 = catQueries.filter(q => q.found_at_rank !== null && q.found_at_rank <= 5).length;
    const catMrr = catQueries.reduce((s, q) => s + (q.found_at_rank ? 1 / q.found_at_rank : 0), 0) / catQueries.length;
    perCategory[cat] = { recall_at_5: catHits5 / catQueries.length, mrr: +catMrr.toFixed(3) };
  }

  const result: BenchResult = {
    date: new Date().toISOString().split('T')[0],
    recall_at_1: +recall1.toFixed(3),
    recall_at_5: +recall5.toFixed(3),
    recall_at_10: +recall10.toFixed(3),
    mrr: +mrr.toFixed(3),
    avg_latency_ms: Math.round(avgLatency),
    namespace_precision_gain: +nsPrecisionGain.toFixed(3),
    per_query: perQuery,
    per_category: perCategory,
  };

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('BENCHMARK RESULTS');
  console.log('='.repeat(60));
  console.log(`  Recall@1:   ${(recall1 * 100).toFixed(1)}%`);
  console.log(`  Recall@5:   ${(recall5 * 100).toFixed(1)}%`);
  console.log(`  Recall@10:  ${(recall10 * 100).toFixed(1)}%`);
  console.log(`  MRR:        ${mrr.toFixed(3)}`);
  console.log(`  Avg Latency: ${avgLatency.toFixed(0)}ms`);
  console.log(`  NS Precision Gain: ${(nsPrecisionGain * 100).toFixed(1)}%`);
  console.log('\nPer-Category:');
  for (const [cat, stats] of Object.entries(perCategory)) {
    console.log(`  ${cat.padEnd(12)} recall@5=${(stats.recall_at_5 * 100).toFixed(0)}%  MRR=${stats.mrr}`);
  }
  console.log('='.repeat(60));

  // Save results
  const resultsDir = join(__dirname, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `${result.date}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nResults saved to ${outPath}`);

  engine.close();
  return result;
}

runBenchmark().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
