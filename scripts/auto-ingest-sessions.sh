#!/usr/bin/env bash
# auto-ingest-sessions.sh — Incrementally ingest OpenClaw session transcripts into Cortex
# Run via cron or manually. Only processes new sessions since last checkpoint.
#
# Usage:
#   ./scripts/auto-ingest-sessions.sh          # incremental ingest
#   ./scripts/auto-ingest-sessions.sh --force   # re-ingest everything
#
# Cron example (every 6 hours):
#   0 */6 * * * cd ~/dev/cortex && ./scripts/auto-ingest-sessions.sh >> ~/.cortex/auto-ingest.log 2>&1

set -euo pipefail

CORTEX_DIR="${CORTEX_DIR:-$HOME/dev/cortex}"
LOG_FILE="${HOME}/.cortex/auto-ingest.log"
LOCK_FILE="${HOME}/.cortex/auto-ingest.lock"

# Ensure log dir exists
mkdir -p "$(dirname "$LOG_FILE")"

# Simple lock to prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f%m "$LOCK_FILE" 2>/dev/null || stat -c%Y "$LOCK_FILE" 2>/dev/null) ))
  if [ "$LOCK_AGE" -lt 3600 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Skipping — another ingest is running (lock age: ${LOCK_AGE}s)" | tee -a "$LOG_FILE"
    exit 0
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Stale lock found (age: ${LOCK_AGE}s), removing" | tee -a "$LOG_FILE"
  rm -f "$LOCK_FILE"
fi

trap 'rm -f "$LOCK_FILE"' EXIT
echo $$ > "$LOCK_FILE"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$TIMESTAMP] Starting session ingestion..." | tee -a "$LOG_FILE"

cd "$CORTEX_DIR"

# Parse args
FORCE_FLAG=""
if [[ "${1:-}" == "--force" ]]; then
  FORCE_FLAG="--force"
  echo "[$TIMESTAMP] Force mode — re-ingesting all sessions" | tee -a "$LOG_FILE"
fi

# Run ingestion
OUTPUT=$(npx cortex ingest-sessions $FORCE_FLAG 2>&1) || {
  echo "[$TIMESTAMP] ❌ Ingestion failed:" | tee -a "$LOG_FILE"
  echo "$OUTPUT" | tee -a "$LOG_FILE"
  exit 1
}

echo "$OUTPUT" | tee -a "$LOG_FILE"

# Extract stats
EXCHANGES=$(echo "$OUTPUT" | grep -oP '\d+ exchanges total' | grep -oP '^\d+' || echo "0")
SESSIONS=$(echo "$OUTPUT" | grep -oP 'Ingested \d+ sessions' | grep -oP '\d+' || echo "0")

if [ "$EXCHANGES" -gt 0 ]; then
  echo "[$TIMESTAMP] ✓ Ingested $SESSIONS sessions, $EXCHANGES exchanges" | tee -a "$LOG_FILE"
else
  echo "[$TIMESTAMP] ✓ No new sessions to ingest" | tee -a "$LOG_FILE"
fi
