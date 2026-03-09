#!/usr/bin/env bash
# smart-curate.sh — Intelligent curation for Cortex memories
# Usage: ./scripts/smart-curate.sh [--delete] [--sample N]
#
# Flags memories that are:
#   - Fragments (< 20 words of actual content)
#   - ChatGPT noise (full conversation dumps, prompt engineering)
#   - Duplicates (near-identical content)
#   - Low-signal episodic entries (code dumps, logs, table data)
#
# Run without --delete to get a report. Run with --delete to actually remove.

set -euo pipefail

CORTEX_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DELETE_MODE=false
SAMPLE_SIZE=50
REPORT_FILE="/tmp/cortex-curate-report-$(date +%Y%m%d-%H%M%S).txt"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete) DELETE_MODE=true; shift ;;
    --sample) SAMPLE_SIZE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--delete] [--sample N]"
      echo "  --delete   Actually remove flagged memories"
      echo "  --sample N Number of memories to analyze (default: 50)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

cd "$CORTEX_DIR"

echo "🧹 Cortex Smart Curation"
echo "========================"
echo "Sample size: $SAMPLE_SIZE"
echo "Mode: $([ "$DELETE_MODE" = true ] && echo 'DELETE' || echo 'REPORT ONLY')"
echo ""

# Export all memories to a temp file (JSON-like format via the export command)
# We'll use node directly for better analysis
ANALYSIS_SCRIPT="${CORTEX_DIR}/.tmp-analyze-$$.mjs"

cat > "$ANALYSIS_SCRIPT" << 'ANALYSIS_EOF'
import { MemoryEngine } from './dist/engine.js';

const deleteMode = process.argv.includes('--delete');
const sampleArg = process.argv.indexOf('--sample');
const sampleSize = sampleArg >= 0 ? parseInt(process.argv[sampleArg + 1]) : 50;

const engine = new MemoryEngine();

try {
  const all = await engine.getAll();
  console.log(`Total memories in DB: ${all.length}\n`);

  // Shuffle and take a sample for random analysis
  const shuffled = [...all].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, sampleSize);

  const flagged = {
    fragments: [],
    chatgptNoise: [],
    codeDumps: [],
    lowSignal: [],
    duplicates: [],
  };

  // --- Fragment detection: < 20 words of actual content ---
  for (const m of sample) {
    const words = m.content.trim().split(/\s+/).filter(w => w.length > 0);
    if (words.length < 20) {
      flagged.fragments.push({ id: m.id, content: m.content.slice(0, 120), importance: m.importance, type: m.type });
    }
  }

  // --- ChatGPT noise: conversation dumps with **User:**/**Assistant:** pattern ---
  for (const m of sample) {
    const content = m.content;
    const isChatGPT = (
      (content.includes('**User:**') && content.includes('**Assistant:**')) ||
      (content.includes('"role": "system"') && content.includes('"content":')) ||
      (content.includes('"role": "user"') && content.includes('"role": "assistant"')) ||
      (m.tags && m.tags.some(t => t.toLowerCase().startsWith('chatgpt')))
    );
    if (isChatGPT && !flagged.chatgptNoise.find(f => f.id === m.id)) {
      flagged.chatgptNoise.push({ id: m.id, content: content.slice(0, 120), importance: m.importance, type: m.type });
    }
  }

  // --- Code dumps: mostly code, tables, or raw data ---
  for (const m of sample) {
    const content = m.content;
    const lines = content.split('\n');
    const codeIndicators = [
      content.includes('```'),
      content.includes('import ') && content.includes('from '),
      content.includes('def ') && content.includes(':'),
      content.includes('function ') && content.includes('{'),
      content.includes('const ') && content.includes(' = '),
      (content.match(/\|/g) || []).length > 10, // markdown tables
    ];
    const codeScore = codeIndicators.filter(Boolean).length;
    // Flag if >60% of content looks like code/data and it's long
    if (codeScore >= 2 && content.length > 500) {
      if (!flagged.chatgptNoise.find(f => f.id === m.id)) {
        flagged.codeDumps.push({ id: m.id, content: content.slice(0, 120), importance: m.importance, type: m.type });
      }
    }
  }

  // --- Low signal: very long entries (>2000 chars) that are episodic with generic tags ---
  for (const m of sample) {
    if (m.content.length > 2000 && m.type === 'episodic') {
      const alreadyFlagged = [
        ...flagged.chatgptNoise,
        ...flagged.codeDumps,
      ].find(f => f.id === m.id);
      if (!alreadyFlagged) {
        flagged.lowSignal.push({ id: m.id, content: m.content.slice(0, 120), importance: m.importance, type: m.type });
      }
    }
  }

  // --- Duplicate detection within sample (exact content match after trimming) ---
  const contentMap = new Map();
  for (const m of sample) {
    const key = m.content.trim().slice(0, 200).toLowerCase();
    if (contentMap.has(key)) {
      flagged.duplicates.push({ id: m.id, content: m.content.slice(0, 120), importance: m.importance, duplicateOf: contentMap.get(key) });
    } else {
      contentMap.set(key, m.id.slice(0, 8));
    }
  }

  // --- Report ---
  const totalFlagged = new Set([
    ...flagged.fragments.map(f => f.id),
    ...flagged.chatgptNoise.map(f => f.id),
    ...flagged.codeDumps.map(f => f.id),
    ...flagged.lowSignal.map(f => f.id),
    ...flagged.duplicates.map(f => f.id),
  ]);

  console.log(`📊 Analysis of ${sampleSize} random memories:`);
  console.log(`   Fragments (< 20 words):  ${flagged.fragments.length}`);
  console.log(`   ChatGPT noise:           ${flagged.chatgptNoise.length}`);
  console.log(`   Code/data dumps:         ${flagged.codeDumps.length}`);
  console.log(`   Low-signal episodic:     ${flagged.lowSignal.length}`);
  console.log(`   Duplicates:              ${flagged.duplicates.length}`);
  console.log(`   ─────────────────────────────`);
  console.log(`   Total unique flagged:     ${totalFlagged.size} / ${sampleSize} (${((totalFlagged.size / sampleSize) * 100).toFixed(0)}%)`);
  console.log(`   Estimated DB noise:       ~${Math.round((totalFlagged.size / sampleSize) * all.length)} of ${all.length} memories`);
  console.log('');

  // Print details
  const categories = [
    ['🔸 Fragments', flagged.fragments],
    ['🔴 ChatGPT Noise', flagged.chatgptNoise],
    ['🟡 Code/Data Dumps', flagged.codeDumps],
    ['🟠 Low-Signal Episodic', flagged.lowSignal],
    ['🔵 Duplicates', flagged.duplicates],
  ];

  for (const [label, items] of categories) {
    if (items.length > 0) {
      console.log(`${label}:`);
      for (const item of items.slice(0, 10)) {
        console.log(`  [${item.id.slice(0, 8)}] (${item.type}, imp=${item.importance}) ${item.content.replace(/\n/g, ' ').slice(0, 100)}`);
      }
      if (items.length > 10) console.log(`  ... and ${items.length - 10} more`);
      console.log('');
    }
  }

  // Delete mode
  if (deleteMode) {
    const idsToDelete = [...totalFlagged];
    console.log(`🗑️  Deleting ${idsToDelete.length} flagged memories...`);
    let deleted = 0;
    for (const id of idsToDelete) {
      try {
        const result = await engine.delete(id);
        if (result) deleted++;
      } catch (e) {
        // skip errors
      }
    }
    console.log(`✓ Deleted ${deleted} memories`);
  } else {
    console.log('Run with --delete to remove flagged memories.');
    console.log('IDs to review:');
    for (const id of totalFlagged) {
      console.log(`  ${id.slice(0, 8)}`);
    }
  }

} finally {
  engine.close();
}
ANALYSIS_EOF

# Run the analysis
node "$ANALYSIS_SCRIPT" $([ "$DELETE_MODE" = true ] && echo "--delete") --sample "$SAMPLE_SIZE" 2>&1 | tee "$REPORT_FILE"

rm -f "$ANALYSIS_SCRIPT"

echo ""
echo "📄 Report saved to: $REPORT_FILE"
