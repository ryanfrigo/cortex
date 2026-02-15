# Cortex Dogfooding Report — 2026-02-15

## Summary
Imported 4,595 memories from 42 markdown files (MEMORY.md + memory/*.md). CLI, search, and MCP server all functional. One critical performance bug found and fixed.

## What Works ✅
- **CLI save/search/delete/status/import** — all commands work correctly
- **Hybrid search** — vector + BM25 + recency scoring produces relevant results
- **Embedding model** — Xenova/all-MiniLM-L6-v2 runs locally, no API calls needed
- **LanceDB** — handles 4.5K records well, DB is ~140MB
- **MCP server** — well-structured, exposes memory_save/search/context/forget tools
- **Import parser** — handles markdown headers, bullet points, infers type and importance

## Search Quality Test Results
| Query | Top Result | Relevant? |
|-------|-----------|-----------|
| "Kalshi trading bot" | "Building MyApp, Debate.ai, Kalshi trading bot" (0.814) | ✅ Yes |
| "MyApp" | "Project: myapp" (0.818) | ✅ Yes |
| "coaching" | "Multiple deep coaching convos with GPT..." (0.757) | ✅ Yes |

All three queries return sensible, relevant results with good score distributions.

## Bug Found & Fixed 🐛

### Critical: FTS Index Rebuilt on Every Single Save
**Problem:** `engine.save()` called `tbl.createIndex('content', { config: Index.fts(), replace: true })` after every record insert. During bulk imports, this made importing 41 files (~4,595 records) take **hours** instead of minutes.

**Fix:** 
- Added `rebuildFts` parameter to `save()` (default true for single saves)
- Added `saveBatch()` method that embeds + inserts in batches of 50, rebuilds FTS once at end
- Updated CLI `import` command to use `saveBatch()`
- Result: Full import now takes ~10 minutes instead of estimated 3+ hours

## Issues & Improvement Ideas 📋

### High Priority
1. **No deduplication** — reimporting the same file creates duplicate memories. Need content hash or upsert.
2. **All timestamps identical** — imported memories all get `created_at = now()`. Should preserve dates from filenames (e.g., `2026-02-13.md` → Feb 13 date).
3. **Recency scores all 1.0** — since all records were just created, recency scoring is useless. Related to #2.
4. **No `--db-path` CLI flag** — can't point to alternate DB locations easily.

### Medium Priority
5. **Import chunking is too granular** — each bullet point becomes a separate memory. A bullet like "Project: myapp" has no useful context without its parent section. Consider keeping section header as prefix.
6. **No batch embedding** — `embed()` is called sequentially. The Xenova model could batch encode for speed.
7. **Type inference is weak** — almost everything becomes `semantic` (4,522 of 4,595). The `inferType()` heuristic only catches "procedure/how to/workflow/event/log/history" in section names.
8. **Tags come from section headers only** — often produces unhelpful tags like `"credentials"` or `"2.-key-themes-&-patterns"`. Should clean/normalize.

### Low Priority
9. **No `import-dir` command** — have to loop `import` per file. Add a directory import.
10. **MCP server doesn't expose batch import** — only single `memory_save`.
11. **No TTL/expiry** — stale memories (old trades, outdated credentials) never age out.
12. **`update()` deletes and re-adds** — loses FTS index consistency, could lose data on crash.
13. **`access_count` update uses string coercion** — `(r.memory as any).accessCount + 1 + ''` is fragile.
14. **No `.env` or config file** — DB path, model name, scoring weights are all hardcoded.

## Architecture Notes
- Local-only, no cloud dependencies (except `@anthropic-ai/sdk` in package.json — unused?)
- ~400 lines of TypeScript total (engine + CLI + MCP + import + scoring)
- Clean separation of concerns
- MCP server follows the spec correctly

## Verdict
**MVP works.** Search quality is good enough to be useful. The batch import fix was essential. Next steps should focus on deduplication, timestamp preservation, and better chunking before wiring into daily OpenClaw use.
