import { Command } from 'commander';
import { MemoryEngine } from './engine.js';
import { parseMarkdownFile } from './import.js';
import type { MemoryType } from './types.js';

const program = new Command();

program
  .name('cortex')
  .description('Local-first AI memory layer')
  .version('0.1.0');

program
  .command('save')
  .description('Save a memory')
  .argument('<content>', 'Memory content')
  .option('-t, --type <type>', 'Memory type (episodic|semantic|procedural)', 'semantic')
  .option('-i, --importance <n>', 'Importance 0-1', '0.5')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('-s, --source <source>', 'Source identifier', 'cli')
  .action(async (content: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const memory = await engine.save({
        content,
        type: opts.type as MemoryType,
        importance: parseFloat(opts.importance),
        source: opts.source,
        tags: opts.tags ? opts.tags.split(',').map((t: string) => t.trim()) : [],
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
  .action(async (query: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const results = await engine.search({
        query,
        limit: parseInt(opts.limit),
        type: opts.type as MemoryType | undefined,
        minImportance: opts.minImportance ? parseFloat(opts.minImportance) : undefined,
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
      console.log(`  Episodic:   ${stats.byType.episodic}`);
      console.log(`  Semantic:   ${stats.byType.semantic}`);
      console.log(`  Procedural: ${stats.byType.procedural}`);
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
  .action(async (file: string) => {
    const engine = new MemoryEngine();
    try {
      const parsed = parseMarkdownFile(file);
      console.log(`Parsed ${parsed.length} memories from ${file}`);

      const count = await engine.saveBatch(parsed.map(p => p.input));
      console.log(`\n✓ Imported ${count} memories`);
    } catch (err) {
      console.error('Error importing:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program.parse();
