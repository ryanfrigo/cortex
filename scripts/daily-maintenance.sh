#!/usr/bin/env bash
# daily-maintenance.sh — Daily Cortex maintenance
# Ingests new OpenClaw sessions and runs a curation report.
#
# Usage: ./scripts/daily-maintenance.sh
# Recommended: run via cron at midnight daily

set -euo pipefail

CORTEX_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CORTEX_DIR"

LOG_FILE="/tmp/cortex-maintenance-$(date +%Y%m%d).log"

echo "🧠 Cortex Daily Maintenance — $(date)" | tee "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"

# Step 1: Ingest new OpenClaw sessions
echo "" | tee -a "$LOG_FILE"
echo "📥 Step 1: Ingesting new sessions..." | tee -a "$LOG_FILE"
npx cortex ingest-sessions 2>&1 | tee -a "$LOG_FILE"

# Step 2: Run smart curation in report mode (100 sample)
echo "" | tee -a "$LOG_FILE"
echo "🧹 Step 2: Running smart curation report..." | tee -a "$LOG_FILE"
bash "$CORTEX_DIR/scripts/smart-curate.sh" --sample 100 2>&1 | tee -a "$LOG_FILE"

# Step 3: Quick health check
echo "" | tee -a "$LOG_FILE"
echo "🏥 Step 3: Health check..." | tee -a "$LOG_FILE"
npx cortex health 2>&1 | tee -a "$LOG_FILE"

# Summary
echo "" | tee -a "$LOG_FILE"
echo "✅ Daily maintenance complete" | tee -a "$LOG_FILE"
echo "📄 Full log: $LOG_FILE" | tee -a "$LOG_FILE"
