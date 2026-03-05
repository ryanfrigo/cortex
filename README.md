# Cortex 🧠

**Local-first AI memory layer with hybrid retrieval and brain-inspired namespaces. No API keys needed.**

[![npm version](https://img.shields.io/npm/v/cortex-memory)](https://www.npmjs.com/package/cortex-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Give your AI agent persistent memory that runs entirely on your machine. Cortex combines vector similarity, full-text search, recency, and importance scoring into a single embedded database — no cloud services, no API keys, no monthly bills.

**v0.3.0**: Namespaced collections (brain regions), memory decay, consolidation, audit & health commands.

## Quick Start (2 minutes)

```bash
# Install globally
npm install -g cortex-memory

# Save memories to brain regions
cortex save "I prefer TypeScript over JavaScript" --namespace learnings
cortex save "Ran 5k in 24:30" --namespace health
cortex save "Sarah prefers async communication" --namespace people

# Search within a namespace
cortex search "programming languages" --namespace learnings

# Search everything
cortex search "programming languages"

# Ingest a folder of notes
cortex ingest ~/notes --recursive --namespace daily

# Check brain health
cortex health
cortex status
```

That's it. Memories are stored locally at `~/.cortex/lance_db/`.

## Why Cortex?

| Feature | Cortex | Plain vector DB | Cloud memory APIs |
|---------|--------|----------------|-------------------|
| **100% local** | ✅ | ✅ | ❌ |
| **Hybrid retrieval** (vector + BM25 + recency + importance) | ✅ | ❌ | Sometimes |
| **Zero config** | ✅ | ❌ | ❌ |
| **MCP server built-in** | ✅ | ❌ | Sometimes |
| **No API keys** | ✅ | ✅ | ❌ |
| **Free forever** | ✅ | ✅ | ❌ |

## Install

```bash
npm install -g cortex-memory
```

Requires Node.js 18+. First run downloads the embedding model (~30MB) automatically.

## Namespaces (Brain Regions)

Organize memories into namespaces — like brain regions for different types of knowledge:

| Namespace | Purpose |
|-----------|---------|
| `health` | Food, workouts, sleep, body metrics |
| `projects/*` | Per-project memories (e.g. `projects/voicecharm`) |
| `personal` | Relationships, reflections, plans |
| `daily` | Raw daily logs |
| `learnings` | Mistakes, corrections, patterns |
| `people` | Info about specific people |
| `general` | Default / uncategorized |

```bash
cortex save "Ran 5k in 24:30" --namespace health
cortex search "running times" --namespace health
cortex export --namespace people
```

## Memory Maintenance

### Decay
Memories that haven't been accessed lose importance over time (configurable half-life):
```bash
cortex decay --dry-run              # Preview what would decay
cortex decay --apply --half-life 30 # Apply with 30-day half-life
```

### Consolidation
Merge similar memories into summaries (like sleep consolidating episodic → semantic memory):
```bash
cortex consolidate --dry-run        # Find clusters
cortex consolidate --apply          # Merge and summarize
```

### Audit & Health
```bash
cortex audit    # Find duplicates (cosine sim > 0.95), stale memories, namespace distribution
cortex health   # Overall brain health: namespace balance, avg importance, staleness
```

## CLI Reference

### Save Memories

```bash
cortex save "I prefer TypeScript over JavaScript" --namespace learnings
cortex save "Deploy with Vercel" --type procedural --tags "deploy,vercel"
cortex save "Had a great meeting with the team" --type episodic -i 0.8
cortex save "Use pnpm for monorepos" --project myapp --namespace projects/myapp
```

### Search (Hybrid Retrieval)

```bash
cortex search "what programming languages"
cortex search "deployment" --type procedural --limit 3
cortex search "meeting notes" --min-importance 0.7
cortex search "database setup" --project myapp --namespace projects/myapp
```

### Ingest Files & Folders

```bash
# Ingest a single markdown file
cortex import MEMORY.md

# Ingest an entire folder of notes
cortex ingest ~/notes
cortex ingest ~/notes --recursive              # include subdirectories
cortex ingest ~/notes --smart                   # extract high-signal lines (Decision:, Lesson:, etc.)
cortex ingest ~/docs --ext .md,.txt,.org        # custom file extensions

# Smart mode recognizes prefixed lines:
#   Decision: Use PostgreSQL for the main database  → type: decision, importance: 0.9
#   Lesson: Always test with real data              → type: lesson, importance: 0.85
#   Bug: Race condition in the queue worker         → type: lesson, importance: 0.75
```

### Manage & Curate

```bash
cortex status                    # Database overview
cortex curate                    # Find low-value memories to clean up
cortex curate --auto             # Auto-delete low-value entries
cortex export --type semantic    # Export as markdown
cortex delete <memory-id>        # Delete by ID
```

## MCP Server (Claude Desktop / Cursor / OpenClaw)

Cortex ships with a built-in [Model Context Protocol](https://modelcontextprotocol.io/) server, so AI agents can save and search memories directly.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["cortex-memory", "mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["cortex-memory", "mcp"]
    }
  }
}
```

### OpenClaw

Add to your OpenClaw MCP config:

```json
{
  "cortex": {
    "command": "npx",
    "args": ["cortex-memory", "mcp"]
  }
}
```

### MCP Tools Available

| Tool | Description |
|------|-------------|
| `memory_save` | Save a new memory with type, importance, and tags |
| `memory_search` | Hybrid search across all memories |
| `memory_context` | Get memory stats and overview |
| `memory_forget` | Delete a memory by ID |
| `memory_reflect` | Get AI-powered reflection on stored memories |

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   CLI/MCP   │────▶│ Memory Engine │────▶│   LanceDB   │
│   Client    │◀────│  (scoring)   │◀────│  (embedded) │
└─────────────┘     └──────────────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │  Embeddings │
                    │ (MiniLM-L6) │
                    └─────────────┘
```

**Storage:** LanceDB embedded vector database at `~/.cortex/lance_db/`

**Embeddings:** [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) — 384-dimensional vectors, runs locally via ONNX Runtime. No API keys.

**Full-text search:** Tantivy-powered BM25 scoring, automatically indexed.

**Hybrid scoring formula:**
```
score = 0.35×vector + 0.30×bm25 + 0.15×recency + 0.10×importance + 0.05×access_frequency + 0.05×type_boost
```

This means Cortex doesn't just find semantically similar results — it factors in how recently something was accessed, how important it is, and whether it matches exact keywords.

## Memory Types

| Type | Use Case | Example |
|------|----------|---------|
| `semantic` | Facts, preferences, knowledge | "I prefer dark mode" |
| `episodic` | Events, experiences | "Met with client on Tuesday" |
| `procedural` | How-to, processes | "To deploy: run npm build then vercel" |
| `decision` | Choices made and why | "Chose PostgreSQL over MySQL for JSONB support" |
| `lesson` | Things learned the hard way | "Always test with real data, not mocks" |
| `fact` | Verified information | "The API rate limit is 100 req/min" |
| `preference` | Personal preferences | "Prefers tabs over spaces" |
| `project-state` | Current state of a project | "v2 API is in beta, launching next week" |
| `person` | Info about people | "Sarah is the frontend lead, prefers React" |

## Programmatic Usage

```typescript
import { MemoryEngine } from 'cortex-memory';

const engine = new MemoryEngine();

// Save
await engine.save({
  content: "Always validate user input server-side",
  type: "lesson",
  importance: 0.9,
  tags: ["security", "validation"],
});

// Search
const results = await engine.search({
  query: "input validation",
  limit: 5,
});

for (const r of results) {
  console.log(`[${r.score.toFixed(3)}] ${r.memory.content}`);
}

// Stats
const stats = await engine.stats();
console.log(`Total memories: ${stats.totalMemories}`);
```

## Development

```bash
git clone https://github.com/ryanfrigo/cortex.git
cd cortex
npm install
npm run build
node bin/cortex.js status
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
