# Contributing to Cortex

Thanks for your interest in contributing! Cortex is a local-first AI memory layer, and we welcome contributions of all kinds.

## Getting Started

```bash
git clone https://github.com/ryanfrigo/cortex.git
cd cortex
npm install
npm run build
```

Test your changes:

```bash
node bin/cortex.js status
node bin/cortex.js save "test memory"
node bin/cortex.js search "test"
```

## Project Structure

```
src/
  cli.ts          — CLI commands (commander.js)
  engine.ts       — Core MemoryEngine class
  mcp-server.ts   — MCP server for Claude/Cursor/OpenClaw
  embeddings.ts   — Local embedding model (MiniLM-L6)
  scoring.ts      — Hybrid scoring algorithm
  schema.ts       — LanceDB schema and initialization
  import.ts       — Markdown file parser
  ingest-sessions.ts — OpenClaw session transcript ingestion
  types.ts        — TypeScript type definitions
bin/
  cortex.js       — CLI entry point
```

## Guidelines

- **TypeScript** — all source in `src/`, compiled to `dist/`
- **Keep it local** — no cloud dependencies, no API keys required
- **Test your changes** — run the CLI manually before submitting
- **Small PRs** — focused changes are easier to review

## Ideas for Contributions

- Better deduplication (semantic similarity, not just content hash)
- More import formats (Obsidian, Notion, Logseq)
- Performance improvements for large databases
- Better CLI output formatting
- Test suite

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
