# OpenClaw Cron Setup for Cortex Maintenance

Automated maintenance keeps Cortex's signal-to-noise ratio high. Set up these cron jobs via OpenClaw.

## Daily: Session Ingestion (Midnight)

Captures all OpenClaw session transcripts from the day into Cortex as searchable episodic memories.

```json
{
  "schedule": "0 0 * * *",
  "timezone": "America/Los_Angeles",
  "task": "Run Cortex daily maintenance: cd ~/dev/cortex && bash scripts/daily-maintenance.sh",
  "description": "Cortex daily session ingestion + curation report"
}
```

**OpenClaw CLI:**
```bash
openclaw cron add \
  --schedule "0 0 * * *" \
  --timezone "America/Los_Angeles" \
  --task "Run Cortex daily maintenance: cd ~/dev/cortex && bash scripts/daily-maintenance.sh"
```

## Weekly: Curation Report (Sunday 8 AM)

Runs a larger curation sample and outputs a noise report for review.

```json
{
  "schedule": "0 8 * * 0",
  "timezone": "America/Los_Angeles",
  "task": "Run Cortex weekly curation: cd ~/dev/cortex && bash scripts/smart-curate.sh --sample 500",
  "description": "Cortex weekly curation report (500 sample)"
}
```

**OpenClaw CLI:**
```bash
openclaw cron add \
  --schedule "0 8 * * 0" \
  --timezone "America/Los_Angeles" \
  --task "Run Cortex weekly curation: cd ~/dev/cortex && bash scripts/smart-curate.sh --sample 500"
```

## Weekly: Auto-Cleanup (Sunday 9 AM, optional)

If you trust the heuristics, auto-delete flagged noise. Only enable after validating reports for a few weeks.

```json
{
  "schedule": "0 9 * * 0",
  "timezone": "America/Los_Angeles",
  "task": "Run Cortex auto-cleanup: cd ~/dev/cortex && npx cortex curate --auto --chatgpt --fragments",
  "description": "Cortex weekly auto-cleanup of ChatGPT noise + fragments"
}
```

## Verifying Cron Jobs

```bash
openclaw cron list
```

## Manual Maintenance

Run anytime to check database health:

```bash
cd ~/dev/cortex
npx cortex health                        # Quick health metrics
npx cortex curate --chatgpt --fragments  # Interactive cleanup
bash scripts/smart-curate.sh --sample 200  # Detailed noise report
```
