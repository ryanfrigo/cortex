# Cortex 🧠

Local-first AI memory layer with hybrid retrieval. No API keys needed.

## Install

```bash
npm install -g cortex-memory
```

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

# Delete
cortex delete <memory-id>
```

## MCP Server (Claude Desktop / Cursor)

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

For Cursor, add to `.cursor/mcp.json`:

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

### MCP Tools

| Tool | Description |
|------|-------------|
| `memory_save` | Save a new memory with type, importance, and tags |
| `memory_search` | Hybrid search across all memories |
| `memory_context` | Get memory stats and overview |
| `memory_forget` | Delete a memory by ID |

## Architecture

- **LanceDB** embedded vector database (`~/.cortex/lance_db/`)
- **LanceDB vector search** for semantic similarity (384-dim embeddings)
- **LanceDB full-text search** (Tantivy) for BM25 scoring
- **Xenova/all-MiniLM-L6-v2** for local embeddings (no API key needed)
- **Hybrid scoring**: `0.4×vector + 0.3×bm25 + 0.2×recency + 0.1×importance`

## Memory Types

- **semantic** — Facts, preferences, knowledge ("I prefer dark mode")
- **episodic** — Events, experiences ("Met with client on Tuesday")
- **procedural** — How-to, processes ("To deploy: run npm build then vercel")

## License

MIT
