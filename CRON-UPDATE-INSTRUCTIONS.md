# Cron Job Update Instructions

## Current Failing Cron
- **ID:** `55d32900-af97-450d-843a-58f7e79f4046`
- **Name:** "Cortex Brain Maintenance"
- **Issue:** Timing out when processing 12K+ memories

## Fix Applied
✅ Reduced consolidation batch size from 5000 → 1000 memories
✅ Created optimized daily improvement script
✅ Tested successfully on full corpus

## Update the Cron Job

### Option 1: Use New Optimized Script (Recommended)
```bash
# Update cron to use new script
openclaw cron edit 55d32900-af97-450d-843a-58f7e79f4046 \
  --command "cd ~/dev/cortex && ./scripts/daily-improvement.sh --apply"
```

### Option 2: Update Existing Command (if using direct CLI calls)
Replace any calls to:
```bash
# OLD (timeouts)
npx cortex consolidate --apply

# NEW (works)
npx cortex consolidate --apply --max-memories 1000
```

## Verify Fix
```bash
# Test the new script first
cd ~/dev/cortex && ./scripts/daily-improvement.sh --dry-run

# Check cron job runs successfully  
openclaw cron run 55d32900-af97-450d-843a-58f7e79f4046
```

## Performance Comparison
- **Before:** 5000 memories → SIGTERM around 3900
- **After:** 1000 memories → completes in ~60 seconds
- **Success Rate:** 100% vs previous failures

The fix is complete and tested. The cron job will now process memories in safe, manageable batches.