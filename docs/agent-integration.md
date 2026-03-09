# Agent Integration Guide

How AI agents should integrate with Cortex for persistent, searchable memory.

## 1. Setup

### Prerequisites
- Node.js 18+
- npm or npx available in the agent's shell environment

### Installation

```bash
npm install -g cortex-memory
```

First run automatically downloads the embedding model (~30MB, MiniLM-L6-v2 via ONNX). No API keys needed.

### Verification

```bash
npx cortex status
```

You should see a summary with total memories, type breakdown, and DB size. If the database doesn't exist yet, it will be created at `~/.cortex/lance_db/`.

---

## 2. Search

```bash
npx cortex search "query" --limit N
```

### How Scoring Works

Cortex uses **hybrid retrieval** — not just vector similarity. Every result is scored by six signals:

| Signal | Weight | What it measures |
|--------|--------|-----------------|
| Vector similarity | 35% | Semantic closeness (embedding cosine sim) |
| BM25 | 30% | Exact keyword/term match |
| Recency | 15% | How recently the memory was created or accessed |
| Importance | 10% | Explicit importance score (0–1) set at save time |
| Access frequency | 5% | How often the memory has been retrieved |
| Type boost | 5% | Bonus for certain memory types matching the query context |

### Interpreting Scores

- **> 0.7** — Strong match, highly relevant
- **0.5–0.7** — Good match, likely useful
- **0.3–0.5** — Partial match, may contain relevant info
- **< 0.3** — Weak match, probably noise

### Options

| Flag | Description |
|------|-------------|
| `--limit N` | Max results (default: 5). Use 3 for focused recall, 10+ for broad research. |
| `--type TYPE` | Filter by memory type (semantic, episodic, belief, etc.) |
| `--min-importance N` | Only return memories with importance ≥ N |
| `--min-vector N` | Minimum vector similarity threshold (default: 0.25) |
| `--namespace NS` | Filter by brain region namespace |
| `--project NAME` | Filter by project |

### When to Use --limit

- **Quick recall** (default 5): "What's the Vapi API key?" — you want the single best match
- **Broad context** (10–20): "What do I know about deployment?" — cast a wide net
- **Exhaustive search** (50+): Running audits or looking for duplicates

---

## 3. Save

```bash
npx cortex save --type TYPE --tags "tag1,tag2" "content"
```

### Memory Types

| Type | When to use | Examples |
|------|-------------|---------|
| `semantic` | Facts, definitions, project context, preferences | "The API endpoint is /v2/users", "User prefers dark mode" |
| `episodic` | What happened — session logs, events, conversations | "Deployed v2.1 to production on March 5", "Had sync meeting with team" |
| `belief` | Lessons learned, calibration insights, self-corrections | "My time estimates are 10x too high", "Always verify sub-agent output" |
| `procedural` | How to do things — workflows, commands, processes | "To deploy: git push origin main, then vercel --prod" |
| `reflection` | Meta-observations about patterns, behavior analysis | "I tend to start many projects without finishing them" |

### Additional Built-in Types

Cortex also supports: `decision`, `lesson`, `fact`, `preference`, `project-state`, `person`, `session`.

### Options

| Flag | Description |
|------|-------------|
| `--type TYPE` | Memory type (default: "semantic") |
| `--importance N` | Importance 0–1 (default: 0.5). Use 0.8+ for critical info. |
| `--tags "t1,t2"` | Comma-separated tags for filtering and organization |
| `--source SOURCE` | Source identifier (default: "cli") |
| `--project NAME` | Associate with a project |
| `--namespace NS` | Brain region (default: "general") |

### Examples

```bash
# Save a fact
npx cortex save --type semantic --tags "api,myapp" "Vapi API Key: 8aaaf..."

# Save a lesson
npx cortex save --type belief --tags "estimation,calibration" -i 0.9 \
  "My time estimates are consistently 10x too high. A '23-day' project shipped in 30 minutes."

# Save a procedure
npx cortex save --type procedural --tags "deploy,vercel" \
  "Deploy to Vercel: git push origin main, check preview, then vercel --prod"

# Save a reflection
npx cortex save --type reflection --tags "patterns,focus" \
  "I start many projects but finish few. Need to enforce single-project focus blocks."
```

---

## 4. Ingest (Bulk Import)

### Ingest a folder

```bash
npx cortex ingest <folder> [options]
```

Scans a folder for `.md`, `.txt`, and other text files. Each file becomes one or more memories.

| Flag | Description |
|------|-------------|
| `--recursive` | Include subdirectories |
| `--smart` | Extract high-signal lines (Decision:, Lesson:, Bug:, etc.) |
| `--ext ".md,.txt"` | Custom file extensions to include |
| `--namespace NS` | Target namespace |

```bash
# Ingest all markdown notes
npx cortex ingest ~/notes --recursive --namespace daily

# Smart mode — only extract important lines
npx cortex ingest ~/project-docs --smart --namespace projects/myapp
```

### Ingest OpenClaw sessions

```bash
npx cortex ingest-sessions
```

This reads OpenClaw session transcripts from `~/.openclaw/sessions/` and imports them as episodic memories. Each session becomes searchable context.

**Run this after significant work days** to capture everything that happened.

---

## 5. Curate

```bash
npx cortex curate [options]
```

Identifies low-value memories (low importance, low access, high similarity to other entries) and suggests cleanup.

| Flag | Description |
|------|-------------|
| `--auto` | Auto-delete low-value entries without confirmation |

**Run periodically** (weekly or biweekly) to keep the signal-to-noise ratio high. A bloated database with 30K+ low-quality entries hurts retrieval quality.

### Other Maintenance Commands

```bash
npx cortex decay --dry-run              # Preview importance decay
npx cortex decay --apply --half-life 30 # Apply 30-day decay
npx cortex consolidate --dry-run        # Find similar memories to merge
npx cortex audit                        # Find duplicates, stale entries
npx cortex health                       # Overall brain health metrics
```

---

## 6. Best Practices for Agents

### Search on EVERY recall

Don't reserve Cortex for "hard" questions. Search it for everything — API keys, deployment steps, people's preferences, past decisions. The hybrid scoring means even simple keyword queries return useful results. The cost is negligible (local DB, no API calls).

```bash
# Before answering any question about a project:
npx cortex search "myapp deployment" --limit 5
```

### Write-through learning

When you recognize a lesson, correction, or new insight, the **immediate next action** is encoding it. Not as a separate step — atomic with the realization. Talking about a lesson without saving it = not learning it.

```bash
# RIGHT after discovering something:
npx cortex save --type belief --tags "debugging" -i 0.8 \
  "Always check environment variables before assuming code bugs"
```

### Use beliefs for self-improvement

Beliefs are your calibration layer. Save them when you:
- Catch yourself making a wrong assumption
- Discover your estimates were off
- Learn a pattern about your own behavior
- Get corrected by a user

```bash
npx cortex save --type belief --tags "calibration" -i 0.9 \
  "Sub-agent success claims must be independently verified"
```

### Run ingest-sessions after significant work days

Sessions contain rich context that's lost if not ingested. After any day with meaningful work:

```bash
npx cortex ingest-sessions
```

### Run curate periodically

Keep the database clean. Low-value entries dilute search results:

```bash
npx cortex curate --chatgpt --fragments   # Review suggestions with noise detection
npx cortex curate --auto --chatgpt        # Auto-clean ChatGPT noise
```

### Tag consistently

Good tags make filtering powerful. Use consistent naming:
- Projects: `myapp`, `kalshi`, `cortex`
- Domains: `deploy`, `debugging`, `api`, `security`
- Meta: `calibration`, `estimation`, `patterns`

### Namespace for organization

Use namespaces to partition memories by domain:
```bash
npx cortex save --namespace projects/myapp "..."
npx cortex search "deployment" --namespace projects/myapp
```

---

## 7. Maintenance

A bloated Cortex with noisy data hurts retrieval quality. Regular curation keeps signal-to-noise high.

### When to Run Curation

- **Daily**: Ingest new sessions (`npx cortex ingest-sessions`)
- **Weekly**: Run a curation report to identify noise (`scripts/smart-curate.sh --sample 200`)
- **Monthly**: Review and delete flagged entries, run decay on stale memories

### Using the Smart Curate Script

```bash
# Report only (safe — doesn't delete anything)
cd ~/dev/cortex && bash scripts/smart-curate.sh --sample 200

# Delete flagged entries
bash scripts/smart-curate.sh --sample 200 --delete
```

The script flags five categories:
1. **Fragments** — memories with < 20 words (often broken imports)
2. **ChatGPT noise** — raw conversation dumps with `**User:**`/`**Assistant:**` patterns
3. **Code/data dumps** — memories that are mostly source code or table data
4. **Low-signal episodic** — very long episodic entries with no meaningful tags
5. **Duplicates** — near-identical content within the sample

### Using the Improved Curate Command

The built-in `curate` command now supports better heuristics:

```bash
# Flag ChatGPT noise + fragments (any importance, any age)
npx cortex curate --chatgpt --fragments

# Flag with custom importance threshold
npx cortex curate --importance 0.6

# Auto-delete everything flagged
npx cortex curate --auto --chatgpt --fragments --importance 0.5
```

### What to Look For When Curating

| Pattern | Example | Action |
|---------|---------|--------|
| Full ChatGPT conversations | `**User:** help me...` `**Assistant:** Here's...` | Delete — these are raw dumps, not distilled knowledge |
| Code snippets without context | Raw Python/JS code blocks | Delete — save the *lesson*, not the code |
| Markdown tables from exports | `\| Column \| Value \|` | Delete unless it contains unique data |
| One-line fragments | `"cool"`, `"yes"`, `"hmm"` | Delete |
| Duplicate entries | Same content saved multiple times | Keep one, delete rest |
| Generic observations | `"The app works well"` | Delete — too vague to be useful |

### Importance Scoring Guidelines

When saving memories, set importance thoughtfully:

| Importance | When to use |
|------------|-------------|
| 0.9–1.0 | Critical decisions, API keys, architecture choices |
| 0.7–0.8 | Lessons learned, debugging insights, user preferences |
| 0.5–0.6 | General facts, project notes, session summaries |
| 0.3–0.4 | Low-confidence observations, temporary notes |
| 0.1–0.2 | Raw data that might be useful later |

To improve scores over time:
- Run `npx cortex decay --apply --half-life 30` to naturally reduce stale memories
- Manually boost important memories by re-saving with higher importance
- Use `npx cortex audit` to find distribution issues

### Automated Maintenance

See [openclaw-cron-setup.md](./openclaw-cron-setup.md) for cron job configuration.
