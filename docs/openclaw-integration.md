# OpenClaw Integration Guide

How to integrate Cortex into an OpenClaw-powered agent for persistent memory across sessions.

## 1. AGENTS.md Configuration

Add mandatory dual-search to your `AGENTS.md` so the agent always checks both memory sources:

```markdown
## Memory System
- **Daily notes:** `memory/YYYY-MM-DD.md` — raw logs of what happened
- **Long-term:** `MEMORY.md` — curated memories, decisions, lessons
- **Cortex:** `cd ~/dev/cortex && npx cortex search "query"` — 30K+ memories, hybrid vector+BM25 search.
  MANDATORY for ALL recall alongside memory_search. Not optional. Not "when it seems useful." Every. Single. Time.
- **Cortex write-back:** After significant sessions, ingest new learnings:
  `cd ~/dev/cortex && npx cortex save --type TYPE --tags "tag1,tag2" "content"`
  Types: semantic, episodic, belief, procedural, reflection.
```

The key principle: **dual-search every time**. The MCP `memory_search` tool and CLI `cortex search` should both be invoked for any recall operation. They may return different results due to different scoring/indexing.

## 2. Cortex Save Command Reference

From an OpenClaw agent shell:

```bash
# Facts and context
cd ~/dev/cortex && npx cortex save --type semantic --tags "project,api" "The endpoint is /v2/users"

# Session events
cd ~/dev/cortex && npx cortex save --type episodic --tags "deploy,voicecharm" "Deployed v2.1 to prod"

# Lessons learned
cd ~/dev/cortex && npx cortex save --type belief --tags "calibration" -i 0.9 "Always verify before claiming done"

# How-to knowledge
cd ~/dev/cortex && npx cortex save --type procedural --tags "deploy" "Deploy: git push, then vercel --prod"

# Pattern observations
cd ~/dev/cortex && npx cortex save --type reflection --tags "patterns" "I over-plan and under-execute"
```

Always `cd ~/dev/cortex` first — the CLI resolves paths relative to the project.

## 3. Session Ingestion

### Manual (after big work days)

```bash
cd ~/dev/cortex && npx cortex ingest-sessions
```

This reads session transcripts from `~/.openclaw/sessions/` and imports them as searchable episodic memories.

### Cron Setup (recommended)

Add to OpenClaw cron to run nightly:

```
# In openclaw.json or via OpenClaw cron commands:
# Schedule: daily at 11 PM
cd ~/dev/cortex && npx cortex ingest-sessions 2>&1
```

This ensures every day's sessions are captured without manual intervention.

## 4. HEARTBEAT.md Configuration

Add Cortex maintenance to your heartbeat cycle for autonomous operation:

```markdown
## Cortex Maintenance (Weekly)

Every Sunday heartbeat:
1. Run `cd ~/dev/cortex && npx cortex curate` — review and clean low-value entries
2. Run `cd ~/dev/cortex && npx cortex decay --apply --half-life 30` — apply importance decay
3. Run `cd ~/dev/cortex && npx cortex health` — check overall brain health
4. Run `cd ~/dev/cortex && npx cortex status` — log current stats

If health score drops below threshold, run `npx cortex audit` and address issues.
```

### Daily heartbeat additions

```markdown
## Memory (Every Heartbeat)
- If significant work was done today, run `cd ~/dev/cortex && npx cortex ingest-sessions`
- Save any new beliefs or lessons discovered during the session
```

## 5. MCP Server (Alternative to CLI)

Instead of shelling out, you can use Cortex as an MCP server. Add to your OpenClaw MCP config:

```json
{
  "cortex": {
    "command": "npx",
    "args": ["cortex-memory", "mcp"]
  }
}
```

This exposes tools: `memory_save`, `memory_search`, `memory_context`, `memory_forget`, `memory_reflect`.

**Note:** Even with MCP configured, the CLI provides additional commands (curate, ingest, decay, consolidate, audit, health) that aren't available via MCP. Use both.

## 6. Workflow Summary

```
┌─────────────────────────────────────────────────┐
│                Agent Session Start               │
├─────────────────────────────────────────────────┤
│ 1. Read SOUL.md, USER.md, daily notes           │
│ 2. For any recall: memory_search + cortex search│
├─────────────────────────────────────────────────┤
│              During Session                      │
├─────────────────────────────────────────────────┤
│ 3. Save beliefs/lessons immediately when found   │
│ 4. Log important events as episodic memories     │
├─────────────────────────────────────────────────┤
│              Session End                         │
├─────────────────────────────────────────────────┤
│ 5. Run ingest-sessions if significant work done  │
│ 6. Update daily memory file                      │
├─────────────────────────────────────────────────┤
│              Weekly Maintenance                   │
├─────────────────────────────────────────────────┤
│ 7. curate → decay → health → status             │
└─────────────────────────────────────────────────┘
```
