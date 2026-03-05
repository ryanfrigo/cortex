# Cortex Skill File — Agent Reference

## What is Cortex?
Local-first AI memory layer with hybrid vector + BM25 retrieval. No API keys. Stores memories in LanceDB at `~/.cortex/lance_db/`.

## CLI Commands

### Save a Memory
```bash
cortex save "content" --namespace <ns> --type <type> -i <0-1> --tags "tag1,tag2" --project <name>
```
- **namespace**: brain region (health, projects/voicecharm, personal, daily, learnings, people, general)
- **type**: semantic, episodic, procedural, decision, lesson, fact, preference, project-state, person, session
- **importance**: 0.0–1.0 (default 0.5). Use 0.8+ for decisions/lessons, 0.3 for ephemeral

### Search Memories
```bash
cortex search "query" --namespace <ns> --type <type> -n <limit> --min-importance <n> --project <name>
```
Hybrid scoring: 35% vector similarity + 30% BM25 + 15% recency + 10% importance + 5% access frequency + 5% type boost.

### Ingest Files
```bash
cortex import file.md --namespace <ns> --smart --no-dedup
cortex ingest ~/folder --recursive --namespace <ns> --smart --ext .md,.txt
```
`--smart` extracts lines prefixed with Decision:, Lesson:, Bug: etc.

### Memory Maintenance
```bash
cortex status                          # Overview with namespace distribution
cortex health                          # Brain health metrics
cortex audit                           # Find duplicates, stale memories (slow for large DBs)
cortex decay --dry-run                 # Preview importance decay
cortex decay --apply --half-life 30    # Apply decay (30-day half-life)
cortex consolidate --dry-run           # Find similar memory clusters
cortex consolidate --apply             # Merge clusters into summaries
cortex curate --auto                   # Delete low-value memories
cortex export --namespace health       # Export filtered as markdown
```

### MCP Tools (for AI agents)
- `memory_save` — save with namespace, type, importance, tags, metadata
- `memory_search` — hybrid search with namespace/type filters
- `memory_context` — stats overview
- `memory_forget` — delete by ID
- `memory_reflect` — top accessed + highest importance

## Namespace Conventions

| Namespace | What goes here | Examples |
|-----------|---------------|----------|
| `health` | Food, workouts, sleep, body metrics | "Ran 5k in 24:30", "Slept 7.5 hours" |
| `projects/<name>` | Per-project memories | "projects/voicecharm", "projects/kalshi" |
| `personal` | Relationships, reflections, plans | "Feeling burnt out this week" |
| `daily` | Raw daily logs | "2026-03-04: shipped namespace feature" |
| `learnings` | Mistakes, corrections, patterns | "Never trust sub-agent success claims" |
| `people` | Info about specific people | "Sarah prefers async communication" |
| `general` | Default / uncategorized | Anything that doesn't fit above |

## Best Practices

1. **Always specify namespace** when saving. Don't dump everything into `general`.
2. **Use importance wisely**: 0.8-1.0 for decisions/lessons, 0.5 for facts, 0.3 for ephemeral context.
3. **Search before saving** to avoid duplicates.
4. **Run maintenance weekly**:
   ```bash
   cortex decay --apply
   cortex curate --auto
   cortex health
   ```
5. **Consolidate monthly** to merge similar memories into summaries:
   ```bash
   cortex consolidate --dry-run  # review first
   cortex consolidate --apply
   ```
6. **Route incoming info** to the correct namespace based on content:
   - Health/body/fitness → `health`
   - Project-specific → `projects/<name>`
   - People info → `people`
   - Lessons/mistakes → `learnings`
   - Everything else → `general`

## Scoring Formula
```
score = 0.35×vector + 0.30×bm25 + 0.15×recency + 0.10×importance + 0.05×access_freq + 0.05×type_boost
```
Memories accessed more often score higher. Unaccessed memories decay over time.
