# Cortex 🧠

**Local-first AI memory layer with hybrid retrieval. No API keys needed.**

Give your AI agent persistent memory that runs entirely on your machine. Cortex combines vector similarity, full-text search, recency, and importance scoring into a single embedded database — no cloud services, no API keys, no monthly bills.

## Why Cortex?

- **100% local** — your memories never leave your machine
- **Hybrid retrieval** — not just vector search. Combines semantic similarity + BM25 keyword matching + recency decay + importance weighting
- **MCP Server built-in** — works with Claude Desktop, Cursor, and any MCP-compatible client
- **Import anything** — bulk import from markdown files, ChatGPT exports, or any structured text
- **Zero config** — `npm install -g cortex-memory && cortex save "hello"` and you're running

## Install

```bash
npm install -g cortex-memory
```

Requires Node.js 18+.

## CLI Usage

```bash
# Save memories
cortex save "I prefer TypeScript over JavaScript"
cortex save "Deploy with Vercel" --type procedural --tags "deploy,vercel"
cortex save "Had a great meeting with the team" --type episodic -i 0.8

# Search (hybrid: vector similarity + BM25 + recency + importance)
cortex search "what programming languages"
cortex search "deployment" --type procedural --limit 3

# Import from markdown
cortex import MEMORY.md

# Database status
cortex status

# Curate — identify and clean up low-value or duplicate memories
cortex curate

# Export filtered memories as markdown
cortex export --type semantic --limit 100

# Delete a specific memory
cortex delete <memory-id>
```

## MCP Server (Claude Desktop / Cursor)

Cortex ships with a built-in [Model Context Protocol](https://modelcontextprotocol.io/) server, so AI agents can save and search memories directly.

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

Or point directly to the built file:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/dist/mcp-server.js"]
    }
  }
}
```

For Cursor, add to `.cursor/mcp.json` with the same format.

### MCP Tools

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

- **LanceDB** — embedded vector database (stored at `~/.cortex/lance_db/`)
- **Vector search** — 384-dimensional semantic similarity
- **Full-text search** — Tantivy-powered BM25 scoring
- **Xenova/all-MiniLM-L6-v2** — local embeddings, no API key needed
- **Hybrid scoring** — `0.4×vector + 0.3×bm25 + 0.2×recency + 0.1×importance`

## Memory Types

| Type | Use Case | Example |
|------|----------|---------|
| **semantic** | Facts, preferences, knowledge | "I prefer dark mode" |
| **episodic** | Events, experiences | "Met with client on Tuesday" |
| **procedural** | How-to, processes | "To deploy: run npm build then vercel" |

## Development

```bash
git clone https://github.com/ryanfrigo/cortex.git
cd cortex
npm install
npm run build
node bin/cortex.js status
```

## License

MIT
