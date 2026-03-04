import { Command } from 'commander';
import { MemoryEngine } from './engine.js';
import { parseMarkdownFile, parseMarkdownFileSmart } from './import.js';
import { ingestSessions } from './ingest-sessions.js';
import type { MemoryType } from './types.js';
import * as readline from 'readline';
import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const program = new Command();

program
  .name('cortex')
  .description('Local-first AI memory layer')
  .version('0.2.0');

program
  .command('save')
  .description('Save a memory')
  .argument('<content>', 'Memory content')
  .option('-t, --type <type>', 'Memory type', 'semantic')
  .option('-i, --importance <n>', 'Importance 0-1', '0.5')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('-s, --source <source>', 'Source identifier', 'cli')
  .option('--project <project>', 'Project name for metadata')
  .action(async (content: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const memory = await engine.save({
        content,
        type: opts.type as MemoryType,
        importance: parseFloat(opts.importance),
        source: opts.source,
        tags: opts.tags ? opts.tags.split(',').map((t: string) => t.trim()) : [],
        metadata: opts.project ? { project: opts.project } : undefined,
      });
      console.log(`✓ Saved memory ${memory.id.slice(0, 8)}`);
      console.log(`  Type: ${memory.type} | Importance: ${memory.importance}`);
    } catch (err) {
      console.error('Error saving memory:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('search')
  .description('Search memories')
  .argument('<query>', 'Search query')
  .option('-n, --limit <n>', 'Max results', '5')
  .option('-t, --type <type>', 'Filter by type')
  .option('--min-importance <n>', 'Minimum importance')
  .option('--project <project>', 'Filter by project')
  .action(async (query: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const results = await engine.search({
        query,
        limit: parseInt(opts.limit),
        type: opts.type as MemoryType | undefined,
        minImportance: opts.minImportance ? parseFloat(opts.minImportance) : undefined,
        project: opts.project,
      });

      if (results.length === 0) {
        console.log('No memories found.');
        return;
      }

      console.log(`Found ${results.length} memories:\n`);
      for (const r of results) {
        console.log(`[${r.memory.id.slice(0, 8)}] (score: ${r.score.toFixed(3)}) ${r.memory.type}`);
        console.log(`  ${r.memory.content}`);
        if (r.memory.tags.length) console.log(`  Tags: ${r.memory.tags.join(', ')}`);
        if (r.memory.metadata?.project) console.log(`  Project: ${r.memory.metadata.project}`);
        console.log(`  Vector: ${r.vectorScore.toFixed(3)} | BM25: ${r.bm25Score.toFixed(3)} | Recency: ${r.recencyScore.toFixed(3)}`);
        console.log();
      }
    } catch (err) {
      console.error('Error searching:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('delete')
  .description('Delete a memory by ID')
  .argument('<id>', 'Memory ID (prefix match)')
  .action(async (id: string) => {
    const engine = new MemoryEngine();
    try {
      const deleted = await engine.delete(id);
      if (deleted) {
        console.log(`✓ Deleted memory ${id.slice(0, 8)}`);
      } else {
        console.log(`Memory not found: ${id}`);
      }
    } finally {
      engine.close();
    }
  });

program
  .command('status')
  .description('Show memory database status')
  .action(async () => {
    const engine = new MemoryEngine();
    try {
      const stats = await engine.stats();
      console.log('Cortex Memory Status');
      console.log('====================');
      console.log(`Total memories: ${stats.totalMemories}`);
      for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type}: ${count}`);
      }
      console.log(`DB size: ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`);
      if (stats.oldestMemory) console.log(`Oldest: ${stats.oldestMemory}`);
      if (stats.newestMemory) console.log(`Newest: ${stats.newestMemory}`);
    } finally {
      engine.close();
    }
  });

program
  .command('import')
  .description('Import memories from a markdown file')
  .argument('<file>', 'Path to markdown file')
  .option('--no-dedup', 'Disable content-hash deduplication')
  .option('--smart', 'Use high-signal extraction (looks for Decision:, Lesson:, etc.)')
  .action(async (file: string, opts: { dedup: boolean; smart?: boolean }) => {
    const engine = new MemoryEngine();
    try {
      const parsed = opts.smart ? parseMarkdownFileSmart(file) : parseMarkdownFile(file);
      console.log(`Parsed ${parsed.length} memories from ${file}${opts.smart ? ' (smart mode)' : ''}`);

      const count = await engine.saveBatch(parsed.map(p => p.input), opts.dedup);
      console.log(`\n✓ Imported ${count} memories`);
    } catch (err) {
      console.error('Error importing:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('curate')
  .description('Identify and clean up low-value memories')
  .option('--auto', 'Non-interactive mode: auto-delete low-value entries')
  .action(async (opts: { auto?: boolean }) => {
    const engine = new MemoryEngine();
    try {
      const all = await engine.getAll();
      const now = Date.now();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

      // Find low-value entries
      const lowValue = all.filter(m => {
        const age = now - new Date(m.createdAt).getTime();
        return m.importance < 0.4 && (m.accessCount ?? 0) === 0 && age > thirtyDaysMs;
      });

      console.log(`Found ${lowValue.length} low-value memories (importance < 0.4, never accessed, > 30 days old)\n`);

      if (lowValue.length > 0) {
        for (const m of lowValue.slice(0, 20)) {
          console.log(`  [${m.id.slice(0, 8)}] (imp: ${m.importance}) ${m.content.slice(0, 80)}`);
        }
        if (lowValue.length > 20) console.log(`  ... and ${lowValue.length - 20} more`);

        if (opts.auto) {
          const deleted = await engine.deleteBatch(lowValue.map(m => m.id));
          console.log(`\n✓ Deleted ${deleted} low-value memories`);
        } else {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>(resolve => {
            rl.question(`\nDelete ${lowValue.length} low-value memories? (y/N) `, resolve);
          });
          rl.close();
          if (answer.toLowerCase() === 'y') {
            const deleted = await engine.deleteBatch(lowValue.map(m => m.id));
            console.log(`✓ Deleted ${deleted} low-value memories`);
          } else {
            console.log('Skipped.');
          }
        }
      }

      // Note about duplicates - full cosine similarity check is expensive
      console.log(`\nDuplicate detection: use 'cortex import --dedup' for content-hash dedup on import.`);
      console.log(`Full cosine similarity dedup across ${all.length} memories would require O(n²) comparisons — skipping for large DBs.`);
    } finally {
      engine.close();
    }
  });

program
  .command('export')
  .description('Export filtered memories as markdown')
  .option('-t, --type <type>', 'Filter by memory type')
  .option('--project <project>', 'Filter by project')
  .option('-n, --limit <n>', 'Max memories to export', '50')
  .action(async (opts) => {
    const engine = new MemoryEngine();
    try {
      const all = await engine.getAll();
      let filtered = all;

      if (opts.type) {
        filtered = filtered.filter(m => m.type === opts.type);
      }
      if (opts.project) {
        filtered = filtered.filter(m => m.metadata?.project === opts.project);
      }

      // Sort by importance desc
      filtered.sort((a, b) => b.importance - a.importance);
      filtered = filtered.slice(0, parseInt(opts.limit));

      const typeLabel = opts.type || 'all';
      const projectLabel = opts.project || 'all';
      console.log(`# Cortex Export — type: ${typeLabel}, project: ${projectLabel}`);
      console.log(`# ${filtered.length} memories\n`);

      for (const m of filtered) {
        console.log(`## [${m.type}] (importance: ${m.importance})`);
        console.log(m.content);
        if (m.tags.length) console.log(`*Tags: ${m.tags.join(', ')}*`);
        if (m.metadata?.project) console.log(`*Project: ${m.metadata.project}*`);
        console.log();
      }
    } finally {
      engine.close();
    }
  });

program
  .command('ingest')
  .description('Ingest a folder of text/markdown files into Cortex')
  .argument('<folder>', 'Path to folder containing files to ingest')
  .option('-r, --recursive', 'Recurse into subdirectories')
  .option('--smart', 'Use high-signal extraction (Decision:, Lesson:, etc.)')
  .option('--no-dedup', 'Disable content-hash deduplication')
  .option('--ext <extensions>', 'Comma-separated file extensions to include', '.md,.txt,.markdown')
  .action(async (folder: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const extensions = new Set(opts.ext.split(',').map((e: string) => e.trim().startsWith('.') ? e.trim() : '.' + e.trim()));

      const collectFiles = (dir: string): string[] => {
        const files: string[] = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory() && opts.recursive) {
            files.push(...collectFiles(fullPath));
          } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
            files.push(fullPath);
          }
        }
        return files;
      };

      const files = collectFiles(folder);
      if (files.length === 0) {
        console.log(`No files found with extensions: ${[...extensions].join(', ')}`);
        return;
      }

      console.log(`Found ${files.length} files to ingest`);
      let totalMemories = 0;

      for (const file of files) {
        const parsed = opts.smart ? parseMarkdownFileSmart(file) : parseMarkdownFile(file);
        if (parsed.length === 0) continue;
        const count = await engine.saveBatch(parsed.map(p => p.input), opts.dedup);
        totalMemories += count;
        console.log(`  ${file}: ${count} memories`);
      }

      console.log(`\n✓ Ingested ${totalMemories} memories from ${files.length} files`);
    } catch (err) {
      console.error('Error ingesting folder:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('ingest-sessions')
  .description('Ingest OpenClaw session transcripts into Cortex')
  .option('--force', 'Re-ingest all sessions (ignore checkpoint)')
  .option('-n, --limit <n>', 'Max sessions to process')
  .option('-v, --verbose', 'Show per-session progress')
  .action(async (opts) => {
    try {
      await ingestSessions({
        force: opts.force,
        limit: opts.limit ? parseInt(opts.limit) : undefined,
        verbose: opts.verbose,
      });
    } catch (err) {
      console.error('Error ingesting sessions:', (err as Error).message);
      process.exit(1);
    }
  });

program.parse();
