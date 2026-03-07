#!/usr/bin/env bash
# watch-and-index.sh — Watch memory directory for changes and auto-ingest into Cortex
set -euo pipefail

WATCH_DIR="${1:-$HOME/.openclaw/workspace/memory}"
CORTEX_DIR="${2:-$HOME/dev/cortex}"
LOG_FILE="${CORTEX_DIR}/scripts/watch-and-index.log"

# Check for fswatch
if ! command -v fswatch &>/dev/null; then
  echo "❌ fswatch not found. Install with: brew install fswatch"
  exit 1
fi

echo "👁️  Watching ${WATCH_DIR} for changes..."
echo "📝 Logging to ${LOG_FILE}"
echo "Press Ctrl+C to stop."

fswatch -0 --event Created --event Updated --event Renamed \
  --exclude '\.DS_Store' --exclude '\.swp' \
  "$WATCH_DIR" | while IFS= read -r -d '' file; do
  # Only process markdown files
  if [[ "$file" == *.md ]]; then
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[${TIMESTAMP}] Indexing: ${file}" | tee -a "$LOG_FILE"
    (cd "$CORTEX_DIR" && npx cortex ingest --file "$file" 2>&1 | tee -a "$LOG_FILE") || \
      echo "[${TIMESTAMP}] ⚠️  Failed to index: ${file}" | tee -a "$LOG_FILE"
  fi
done
