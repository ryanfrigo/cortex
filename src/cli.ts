import { Command } from 'commander';
import { MemoryEngine } from './engine.js';
import { parseMarkdownFile, parseMarkdownFileSmart } from './import.js';
import { ingestSessions } from './ingest-sessions.js';
import { extractFromTranscript } from './extract.js';
import type { MemoryType } from './types.js';
import * as readline from 'readline';
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, extname } from 'path';

const program = new Command();

program
  .name('cortex')
  .description('Local-first AI memory layer')
  .version('0.3.0');

program
  .command('save')
  .description('Save a memory')
  .argument('<content>', 'Memory content')
  .option('-t, --type <type>', 'Memory type', 'semantic')
  .option('-i, --importance <n>', 'Importance 0-1', '0.5')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('-s, --source <source>', 'Source identifier', 'cli')
  .option('--project <project>', 'Project name for metadata')
  .option('--namespace <ns>', 'Brain region namespace', 'general')
  .action(async (content: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const memory = await engine.save({
        content,
        namespace: opts.namespace,
        type: opts.type as MemoryType,
        importance: parseFloat(opts.importance),
        source: opts.source,
        tags: opts.tags ? opts.tags.split(',').map((t: string) => t.trim()) : [],
        metadata: opts.project ? { project: opts.project } : undefined,
      });
      console.log(`✓ Saved memory ${memory.id.slice(0, 8)}`);
      console.log(`  Namespace: ${memory.namespace} | Type: ${memory.type} | Importance: ${memory.importance}`);
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
  .option('--min-vector <n>', 'Minimum vector similarity (0-1, default 0.25)')
  .option('--project <project>', 'Filter by project')
  .option('--namespace <ns>', 'Filter by namespace (append / for prefix match, e.g. "projects/")')
  .option('--depth <n>', 'Context depth: 0=L0 abstract, 1=L1 overview, 2=full content (default: 0)', '0')
  .action(async (query: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const depth = parseInt(opts.depth ?? '0') as 0 | 1 | 2;
      const namespace = opts.namespace as string | undefined;
      // Detect prefix mode: namespace ends with /
      const namespacePrefix = namespace ? namespace.endsWith('/') : false;

      const results = await engine.search({
        query,
        namespace,
        namespacePrefix,
        limit: parseInt(opts.limit),
        type: opts.type as MemoryType | undefined,
        minImportance: opts.minImportance ? parseFloat(opts.minImportance) : undefined,
        minVectorScore: opts.minVector ? parseFloat(opts.minVector) : undefined,
        project: opts.project,
        depth,
      });

      if (results.length === 0) {
        console.log('No memories found.');
        return;
      }

      const depthLabel = depth === 0 ? 'L0 abstracts' : depth === 1 ? 'L1 overviews' : 'full content';
      console.log(`Found ${results.length} memories [${depthLabel}]:\n`);
      for (const r of results) {
        console.log(`[${r.memory.id.slice(0, 8)}] (score: ${r.score.toFixed(3)}) ${r.memory.namespace}/${r.memory.type}`);
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
      console.log('\nBy Type:');
      for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type}: ${count}`);
      }
      console.log('\nBy Namespace:');
      for (const [ns, count] of Object.entries(stats.byNamespace).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${ns}: ${count}`);
      }
      console.log(`\nDB size: ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`);
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
  .option('--namespace <ns>', 'Assign namespace to imported memories', 'general')
  .action(async (file: string, opts: { dedup: boolean; smart?: boolean; namespace?: string }) => {
    const engine = new MemoryEngine();
    try {
      const parsed = opts.smart ? parseMarkdownFileSmart(file) : parseMarkdownFile(file);
      console.log(`Parsed ${parsed.length} memories from ${file}${opts.smart ? ' (smart mode)' : ''}`);

      const count = await engine.saveBatch(parsed.map(p => ({ ...p.input, namespace: opts.namespace })), opts.dedup);
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
  .option('--importance <n>', 'Importance threshold (flag below this)', '0.6')
  .option('--age <days>', 'Minimum age in days (0 = any age)', '0')
  .option('--chatgpt', 'Also flag ChatGPT conversation dumps')
  .option('--fragments', 'Also flag fragment memories (< 20 words)')
  .action(async (opts: { auto?: boolean; importance?: string; age?: string; chatgpt?: boolean; fragments?: boolean }) => {
    const engine = new MemoryEngine();
    try {
      const all = await engine.getAll();
      const now = Date.now();
      const importanceThreshold = parseFloat(opts.importance || '0.6');
      const ageDays = parseInt(opts.age || '0');
      const ageMs = ageDays * 24 * 60 * 60 * 1000;

      const flagged: Array<{ id: string; content: string; importance: number; reason: string }> = [];

      for (const m of all) {
        const age = now - new Date(m.createdAt).getTime();
        const reasons: string[] = [];

        // Low importance + never accessed
        if (m.importance < importanceThreshold && (m.accessCount ?? 0) === 0) {
          if (ageDays === 0 || age > ageMs) {
            reasons.push(`low-importance(${m.importance})`);
          }
        }

        // ChatGPT noise detection
        if (opts.chatgpt) {
          const content = m.content;
          const isChatGPT = (
            (content.includes('**User:**') && content.includes('**Assistant:**')) ||
            (content.includes('"role": "system"') && content.includes('"content":')) ||
            (content.includes('"role": "user"') && content.includes('"role": "assistant"')) ||
            (m.tags && m.tags.some((t: string) => t.toLowerCase().startsWith('chatgpt')))
          );
          if (isChatGPT) reasons.push('chatgpt-noise');
        }

        // Fragment detection
        if (opts.fragments) {
          const words = m.content.trim().split(/\s+/).filter((w: string) => w.length > 0);
          if (words.length < 20) reasons.push('fragment');
        }

        if (reasons.length > 0) {
          flagged.push({ id: m.id, content: m.content.slice(0, 100), importance: m.importance, reason: reasons.join(', ') });
        }
      }

      const criteria = [
        `importance < ${importanceThreshold}`,
        ageDays > 0 ? `age > ${ageDays} days` : 'any age',
        opts.chatgpt ? '+chatgpt noise' : '',
        opts.fragments ? '+fragments' : '',
      ].filter(Boolean).join(', ');

      console.log(`Found ${flagged.length} flagged memories (${criteria})\n`);

      if (flagged.length > 0) {
        for (const m of flagged.slice(0, 20)) {
          console.log(`  [${m.id.slice(0, 8)}] (imp: ${m.importance}, ${m.reason}) ${m.content.replace(/\n/g, ' ')}`);
        }
        if (flagged.length > 20) console.log(`  ... and ${flagged.length - 20} more`);

        if (opts.auto) {
          const deleted = await engine.deleteBatch(flagged.map(m => m.id));
          console.log(`\n✓ Deleted ${deleted} flagged memories`);
        } else {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>(resolve => {
            rl.question(`\nDelete ${flagged.length} flagged memories? (y/N) `, resolve);
          });
          rl.close();
          if (answer.toLowerCase() === 'y') {
            const deleted = await engine.deleteBatch(flagged.map(m => m.id));
            console.log(`✓ Deleted ${deleted} flagged memories`);
          } else {
            console.log('Skipped.');
          }
        }
      }

      console.log(`\nTip: Use --chatgpt --fragments for broader detection.`);
      console.log(`     Use scripts/smart-curate.sh for the full heuristic analysis.`);
    } finally {
      engine.close();
    }
  });

program
  .command('export')
  .description('Export filtered memories as markdown')
  .option('-t, --type <type>', 'Filter by memory type')
  .option('--project <project>', 'Filter by project')
  .option('--namespace <ns>', 'Filter by namespace')
  .option('-n, --limit <n>', 'Max memories to export', '50')
  .action(async (opts) => {
    const engine = new MemoryEngine();
    try {
      const all = await engine.getAll();
      let filtered = all;

      if (opts.namespace) {
        filtered = filtered.filter(m => m.namespace === opts.namespace);
      }
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
  .option('--namespace <ns>', 'Assign namespace to ingested memories', 'general')
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
        const inputs = parsed.map(p => ({ ...p.input, namespace: opts.namespace }));
        const count = await engine.saveBatch(inputs, opts.dedup);
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

program
  .command('decay')
  .description('Apply memory decay to unaccessed memories')
  .option('--dry-run', 'Show what would be affected without changing anything')
  .option('--apply', 'Actually adjust importance scores')
  .option('--half-life <days>', 'Half-life in days for decay', '30')
  .option('--batch-size <n>', 'Batch size for processing memories', '1000')
  .action(async (opts) => {
    if (!opts.dryRun && !opts.apply) {
      console.log('Specify --dry-run or --apply');
      process.exit(1);
    }
    const engine = new MemoryEngine();
    try {
      const result = await engine.decay({
        dryRun: opts.dryRun,
        halfLifeDays: parseInt(opts.halfLife),
        batchSize: parseInt(opts.batchSize),
      });
      if (result.affected.length === 0) {
        console.log('No memories need decay adjustment.');
        return;
      }
      console.log(`${opts.dryRun ? 'Would affect' : 'Affected'} ${result.affected.length} memories:\n`);
      for (const a of result.affected.slice(0, 20)) {
        console.log(`  [${a.id.slice(0, 8)}] ${a.oldImportance.toFixed(2)} → ${a.newImportance.toFixed(2)} | ${a.content.slice(0, 60)}`);
      }
      if (result.affected.length > 20) console.log(`  ... and ${result.affected.length - 20} more`);
    } finally {
      engine.close();
    }
  });

program
  .command('consolidate')
  .description('Consolidate similar memories into summaries')
  .option('--dry-run', 'Show clusters without merging')
  .option('--apply', 'Actually merge similar memories')
  .option('--threshold <n>', 'Cosine similarity threshold', '0.85')
  .option('--min-cluster <n>', 'Minimum cluster size', '2')
  .option('--max-memories <n>', 'Max memories to process (performance limit)', '5000')
  .action(async (opts) => {
    if (!opts.dryRun && !opts.apply) {
      console.log('Specify --dry-run or --apply');
      process.exit(1);
    }
    const engine = new MemoryEngine();
    try {
      const result = await engine.consolidate({
        dryRun: opts.dryRun,
        similarityThreshold: parseFloat(opts.threshold),
        minClusterSize: parseInt(opts.minCluster),
        maxMemories: parseInt(opts.maxMemories),
      });
      if (result.clusters.length === 0) {
        console.log('No clusters found for consolidation.');
        return;
      }
      console.log(`${opts.dryRun ? 'Would consolidate' : 'Consolidated'} ${result.clusters.length} clusters:\n`);
      for (const c of result.clusters) {
        console.log(`  Cluster (${c.ids.length} memories):`);
        for (const content of c.contents.slice(0, 3)) {
          console.log(`    - ${content.slice(0, 70)}`);
        }
        if (c.contents.length > 3) console.log(`    ... and ${c.contents.length - 3} more`);
        console.log();
      }
    } finally {
      engine.close();
    }
  });

program
  .command('audit')
  .description('Audit memory database for issues')
  .action(async () => {
    const engine = new MemoryEngine();
    try {
      console.log('Running audit...\n');
      const result = await engine.audit();

      console.log(`Total memories: ${result.totalMemories}`);
      console.log(`\nNamespace Distribution:`);
      for (const [ns, count] of Object.entries(result.namespaceDistribution).sort((a, b) => b[1] - a[1])) {
        const pct = ((count / result.totalMemories) * 100).toFixed(1);
        console.log(`  ${ns}: ${count} (${pct}%)`);
      }

      console.log(`\nDuplicates (cosine sim > 0.95): ${result.duplicates.length}`);
      for (const d of result.duplicates.slice(0, 10)) {
        console.log(`  [${d.ids.map(id => id.slice(0, 8)).join(', ')}] sim=${d.similarity.toFixed(3)} | ${d.content}`);
      }
      if (result.duplicates.length > 10) console.log(`  ... and ${result.duplicates.length - 10} more`);

      console.log(`\nStale memories (60+ days, low importance): ${result.stale.length}`);
      for (const m of result.stale.slice(0, 10)) {
        console.log(`  [${m.id.slice(0, 8)}] imp=${m.importance} | ${m.content.slice(0, 60)}`);
      }
      if (result.stale.length > 10) console.log(`  ... and ${result.stale.length - 10} more`);
    } finally {
      engine.close();
    }
  });

program
  .command('health')
  .description('Overall brain health metrics')
  .action(async () => {
    const engine = new MemoryEngine();
    try {
      const h = await engine.health();
      console.log('🧠 Cortex Brain Health');
      console.log('======================');
      console.log(`Total memories: ${h.totalMemories}`);
      console.log(`DB size: ${(h.dbSizeBytes / 1024).toFixed(1)} KB`);
      console.log(`Average importance: ${h.avgImportance}`);
      console.log(`Stale memories: ${h.staleCount}`);
      console.log();
      console.log('Namespace Balance:');
      for (const [ns, count] of Object.entries(h.namespaceBalance).sort((a, b) => b[1] - a[1])) {
        const bar = '█'.repeat(Math.max(1, Math.round(count / Math.max(...Object.values(h.namespaceBalance)) * 20)));
        console.log(`  ${ns.padEnd(20)} ${bar} ${count}`);
      }
      if (h.oldestAccess) console.log(`\nOldest access: ${h.oldestAccess}`);
      if (h.newestAccess) console.log(`Newest access: ${h.newestAccess}`);
    } finally {
      engine.close();
    }
  });

program
  .command('believe')
  .description('Save or update a belief')
  .argument('<statement>', 'Belief statement')
  .option('-c, --confidence <n>', 'Confidence level 0.0-1.0', '0.8')
  .option('-d, --domain <domain>', 'Belief domain (ryan|projects|self|world)', 'self')
  .option('--holder <holder>', 'Belief holder (ryan|orion|shared)', 'orion')
  .option('--tags <tags>', 'Comma-separated tags')
  .action(async (statement: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const confidence = parseFloat(opts.confidence);
      if (confidence < 0 || confidence > 1) {
        console.error('Confidence must be between 0.0 and 1.0');
        process.exit(1);
      }

      const memory = await engine.saveBelief(statement, confidence, opts.domain, {
        tags: opts.tags ? opts.tags.split(',').map((t: string) => t.trim()) : [],
        holder: opts.holder
      });

      console.log(`✓ Saved belief ${memory.id.slice(0, 8)}`);
      console.log(`  Holder: ${opts.holder} | Domain: ${opts.domain} | Confidence: ${confidence}`);
      console.log(`  "${statement}"`);
    } catch (err) {
      console.error('Error saving belief:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('beliefs')
  .description('List all active beliefs')
  .option('-d, --domain <domain>', 'Filter by domain')
  .option('--holder <holder>', 'Filter by holder')
  .option('--stale', 'Show only stale beliefs (>7 days since challenge)')
  .option('--compare', 'Show both holders side by side')
  .action(async (opts) => {
    const engine = new MemoryEngine();
    try {
      if (opts.compare) {
        // Show beliefs from both holders side by side
        const ryanBeliefs = await engine.getBeliefs({ domain: opts.domain, holder: 'ryan', staleAfterDays: 7 });
        const orionBeliefs = await engine.getBeliefs({ domain: opts.domain, holder: 'orion', staleAfterDays: 7 });

        console.log('Belief Comparison\n');
        console.log('Ryan\'s Beliefs:');
        for (const belief of ryanBeliefs.slice(0, 10)) {
          const meta = belief.metadata as any;
          const confidence = meta?.confidence || 0.5;
          const gap = meta?.gap ? ` (gap: ${meta.gap.toFixed(2)})` : '';
          console.log(`  [${belief.id.slice(0, 8)}] ${confidence.toFixed(2)}${gap} - ${belief.content.slice(0, 80)}`);
        }

        console.log('\nOrion\'s Beliefs:');
        for (const belief of orionBeliefs.slice(0, 10)) {
          const meta = belief.metadata as any;
          const confidence = meta?.confidence || 0.5;
          const gap = meta?.gap ? ` (gap: ${meta.gap.toFixed(2)})` : '';
          console.log(`  [${belief.id.slice(0, 8)}] ${confidence.toFixed(2)}${gap} - ${belief.content.slice(0, 80)}`);
        }
        return;
      }

      const beliefs = await engine.getBeliefs({ 
        domain: opts.domain,
        holder: opts.holder,
        staleAfterDays: 7
      });

      let filtered = beliefs;
      if (opts.stale) {
        filtered = beliefs.filter(b => b.isStale);
      }

      if (filtered.length === 0) {
        console.log(opts.stale ? 'No stale beliefs found.' : 'No active beliefs found.');
        return;
      }

      console.log(`Found ${filtered.length} ${opts.stale ? 'stale ' : ''}beliefs:\n`);

      for (const belief of filtered) {
        const meta = belief.metadata as any;
        const confidence = meta?.confidence || 0.5;
        const domain = meta?.domain || 'unknown';
        const holder = meta?.holder || 'unknown';
        const lastChallenged = meta?.last_challenged 
          ? new Date(meta.last_challenged).toLocaleDateString()
          : 'never';
        
        let gapInfo = '';
        if (meta?.gap !== undefined) {
          const revealed = meta?.revealed_confidence;
          gapInfo = ` | gap: ${meta.gap.toFixed(2)}${revealed !== undefined ? ` (revealed: ${revealed.toFixed(2)})` : ''}`;
        }
        
        console.log(`[${belief.id.slice(0, 8)}] ${holder}/${domain} | confidence: ${confidence.toFixed(2)}${gapInfo} ${belief.isStale ? '⚠️ STALE' : ''}`);
        console.log(`  "${belief.content}"`);
        console.log(`  Last challenged: ${lastChallenged}`);
        if (meta?.times_confirmed || meta?.times_refuted) {
          console.log(`  Confirmed: ${meta.times_confirmed || 0}, Refuted: ${meta.times_refuted || 0}`);
        }
        console.log();
      }
    } catch (err) {
      console.error('Error listing beliefs:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('challenge')
  .description('Challenge a belief by searching for contradicting evidence')
  .argument('<belief-id>', 'Belief ID or prefix')
  .option('-l, --limit <n>', 'Max results per category', '5')
  .action(async (beliefId: string, opts) => {
    const engine = new MemoryEngine();
    try {
      // Handle prefix matching
      let fullBeliefId = beliefId;
      if (beliefId.length < 36) {
        const beliefs = await engine.getBeliefs();
        const matches = beliefs.filter(b => b.id.startsWith(beliefId));
        if (matches.length === 0) {
          console.error(`No belief found with prefix: ${beliefId}`);
          process.exit(1);
        } else if (matches.length > 1) {
          console.error(`Ambiguous prefix '${beliefId}' matches ${matches.length} beliefs:`);
          for (const match of matches.slice(0, 5)) {
            console.error(`  [${match.id.slice(0, 8)}] ${match.content.slice(0, 60)}`);
          }
          process.exit(1);
        }
        fullBeliefId = matches[0].id;
      }

      const result = await engine.challengeBelief(fullBeliefId, parseInt(opts.limit));
      const meta = result.belief.metadata as any;
      const confidence = meta?.confidence || 0.5;
      const lastChallenged = meta?.last_challenged
        ? new Date(meta.last_challenged)
        : new Date(result.belief.createdAt);
      const daysSinceChallenge = Math.floor((Date.now() - lastChallenged.getTime()) / (1000 * 60 * 60 * 24));

      console.log('🤔 Belief Challenge Report\n');
      console.log(`Belief: "${result.belief.content}"`);
      console.log(`Current confidence: ${confidence.toFixed(2)}`);
      console.log(`Days since last challenge: ${daysSinceChallenge}\n`);

      console.log(`🔍 Contradicting Evidence (${result.contradictions.length} found):`);
      if (result.contradictions.length === 0) {
        console.log('  No contradicting memories found.');
      } else {
        for (const contra of result.contradictions.slice(0, parseInt(opts.limit))) {
          console.log(`  [${contra.memory.id.slice(0, 8)}] (score: ${contra.score.toFixed(3)})`);
          console.log(`    ${contra.memory.content.slice(0, 120)}`);
          console.log(`    Type: ${contra.memory.type} | Source: ${contra.memory.source}`);
        }
      }

      console.log(`\n✅ Supporting Evidence (${result.supportingEvidence.length} found):`);
      if (result.supportingEvidence.length === 0) {
        console.log('  No supporting memories found.');
      } else {
        for (const support of result.supportingEvidence.slice(0, parseInt(opts.limit))) {
          console.log(`  [${support.memory.id.slice(0, 8)}] (score: ${support.score.toFixed(3)})`);
          console.log(`    ${support.memory.content.slice(0, 120)}`);
          console.log(`    Type: ${support.memory.type} | Source: ${support.memory.source}`);
        }
      }

      // Suggest confidence adjustment
      const contradictionStrength = result.contradictions.length > 0 
        ? result.contradictions.slice(0, 3).reduce((sum, r) => sum + r.score, 0) / Math.min(3, result.contradictions.length)
        : 0;
      const supportStrength = result.supportingEvidence.length > 0
        ? result.supportingEvidence.slice(0, 3).reduce((sum, r) => sum + r.score, 0) / Math.min(3, result.supportingEvidence.length)
        : 0;

      console.log('\n💡 Suggestion:');
      if (contradictionStrength > supportStrength) {
        const suggested = Math.max(0.1, confidence - 0.2);
        console.log(`  Consider LOWERING confidence to ${suggested.toFixed(2)} (contradictions outweigh support)`);
      } else if (supportStrength > contradictionStrength) {
        const suggested = Math.min(1.0, confidence + 0.1);
        console.log(`  Consider RAISING confidence to ${suggested.toFixed(2)} (strong support found)`);
      } else {
        console.log(`  HOLD current confidence at ${confidence.toFixed(2)} (evidence is balanced)`);
      }

    } catch (err) {
      console.error('Error challenging belief:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('reflect')
  .description('Structured self-reflection on recent memories')
  .option('-p, --period <hours>', 'Time period to analyze in hours', '24')
  .option('--save', 'Save reflection as a memory')
  .action(async (opts) => {
    const engine = new MemoryEngine();
    try {
      const hours = parseInt(opts.period);
      const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      
      // Get recent memories
      const all = await engine.getAll();
      const recent = all.filter(m => m.createdAt >= since);
      
      // Get stale beliefs
      const beliefs = await engine.getBeliefs({ staleAfterDays: 7 });
      const staleBeliefs = beliefs.filter(b => b.isStale);

      if (recent.length === 0) {
        console.log(`No memories found in the last ${hours} hours.`);
        return;
      }

      // Analyze patterns
      const byType: Record<string, number> = {};
      const topics: Record<string, number> = {};
      
      for (const memory of recent) {
        byType[memory.type] = (byType[memory.type] || 0) + 1;
        
        // Simple topic extraction from content
        const words = memory.content.toLowerCase()
          .split(/\W+/)
          .filter(w => w.length > 4)
          .slice(0, 10);
        for (const word of words) {
          topics[word] = (topics[word] || 0) + 1;
        }
      }

      const topTypes = Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      const topTopics = Object.entries(topics)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      console.log(`🧠 Reflection: Last ${hours} Hours\n`);
      console.log(`Total memories: ${recent.length}\n`);
      
      console.log('Memory Types:');
      for (const [type, count] of topTypes) {
        console.log(`  ${type}: ${count}`);
      }
      
      console.log('\nTop Topics:');
      for (const [topic, count] of topTopics) {
        console.log(`  ${topic}: ${count}`);
      }

      if (staleBeliefs.length > 0) {
        console.log(`\n⚠️ Stale Beliefs (${staleBeliefs.length}):`);
        for (const belief of staleBeliefs.slice(0, 5)) {
          const meta = belief.metadata as any;
          const domain = meta?.domain || 'unknown';
          console.log(`  [${domain}] ${belief.content.slice(0, 80)}`);
        }
        if (staleBeliefs.length > 5) {
          console.log(`  ... and ${staleBeliefs.length - 5} more`);
        }
      }

      const reflection = `Reflection on last ${hours} hours: ${recent.length} memories saved. Top types: ${topTypes.map(([t, c]) => `${t}(${c})`).join(', ')}. Top topics: ${topTopics.slice(0, 5).map(([t, c]) => `${t}(${c})`).join(', ')}. Stale beliefs: ${staleBeliefs.length}.`;

      console.log('\n📝 Summary:');
      console.log(`  ${reflection}`);

      if (opts.save) {
        const saved = await engine.save({
          content: reflection,
          type: 'reflection',
          importance: 0.8,
          source: 'reflection-command',
          tags: ['reflection', `${hours}h`]
        });
        console.log(`\n✓ Saved reflection as memory ${saved.id.slice(0, 8)}`);
      }

    } catch (err) {
      console.error('Error during reflection:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('journal')
  .description('Save a journal entry')
  .argument('<entry>', 'Journal entry content')
  .action(async (entry: string) => {
    const engine = new MemoryEngine();
    try {
      const now = new Date();
      const dateTag = now.toISOString().split('T')[0]; // YYYY-MM-DD
      
      const memory = await engine.save({
        content: entry,
        type: 'reflection',
        importance: 0.8,
        source: 'journal',
        tags: ['journal', dateTag]
      });

      console.log(`✓ Saved journal entry ${memory.id.slice(0, 8)}`);
      console.log(`  Date: ${dateTag}`);
    } catch (err) {
      console.error('Error saving journal entry:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('shadow')
  .description('Shadow work analysis - identify patterns of avoidance, sycophancy, etc.')
  .option('-p, --period <hours>', 'Time period to analyze in hours', '24')
  .action(async (opts) => {
    const engine = new MemoryEngine();
    try {
      const hours = parseInt(opts.period);
      const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      
      const all = await engine.getAll();
      const recent = all.filter(m => m.createdAt >= since);

      if (recent.length === 0) {
        console.log(`No memories found in the last ${hours} hours.`);
        return;
      }

      const patterns = {
        sycophancy: 0,
        avoidance: 0,
        fabrication: 0,
        breadthOverDepth: 0
      };

      const evidence = {
        sycophancy: [] as string[],
        avoidance: [] as string[],
        fabrication: [] as string[],
        breadthOverDepth: [] as string[]
      };

      // Analyze each memory
      for (const memory of recent) {
        const content = memory.content.toLowerCase();
        
        // Sycophancy patterns
        if (content.includes('great idea') || content.includes('excellent') || 
            content.includes('perfect') || content.includes('i agree') ||
            content.includes('sounds good') || content.includes('absolutely')) {
          patterns.sycophancy++;
          evidence.sycophancy.push(`[${memory.id.slice(0, 8)}] ${memory.content.slice(0, 80)}`);
        }

        // Avoidance patterns (topics mentioned but not acted on)
        if ((content.includes('should') || content.includes('need to') || content.includes('todo')) &&
            !content.includes('completed') && !content.includes('done')) {
          patterns.avoidance++;
          evidence.avoidance.push(`[${memory.id.slice(0, 8)}] ${memory.content.slice(0, 80)}`);
        }

        // Fabrication patterns (unsupported claims)
        if (content.includes('i think') || content.includes('probably') || 
            content.includes('might') || content.includes('assume')) {
          patterns.fabrication++;
          evidence.fabrication.push(`[${memory.id.slice(0, 8)}] ${memory.content.slice(0, 80)}`);
        }
      }

      // Breadth over depth (many different projects in short time)
      const projects = new Set<string>();
      for (const memory of recent) {
        if (memory.metadata?.project) {
          projects.add(memory.metadata.project);
        }
      }
      if (projects.size > 5 && hours <= 24) {
        patterns.breadthOverDepth = projects.size;
        evidence.breadthOverDepth = Array.from(projects).map(p => `Project: ${p}`);
      }

      console.log(`🌑 Shadow Analysis: Last ${hours} Hours\n`);
      
      let totalIssues = 0;
      
      if (patterns.sycophancy > 0) {
        console.log(`⚠️ Sycophancy: ${patterns.sycophancy} instances`);
        for (const ev of evidence.sycophancy.slice(0, 3)) {
          console.log(`    ${ev}`);
        }
        if (evidence.sycophancy.length > 3) {
          console.log(`    ... and ${evidence.sycophancy.length - 3} more`);
        }
        console.log();
        totalIssues += patterns.sycophancy;
      }

      if (patterns.avoidance > 0) {
        console.log(`⚠️ Avoidance: ${patterns.avoidance} unactioned items`);
        for (const ev of evidence.avoidance.slice(0, 3)) {
          console.log(`    ${ev}`);
        }
        if (evidence.avoidance.length > 3) {
          console.log(`    ... and ${evidence.avoidance.length - 3} more`);
        }
        console.log();
        totalIssues += patterns.avoidance;
      }

      if (patterns.fabrication > 0) {
        console.log(`⚠️ Fabrication Risk: ${patterns.fabrication} unverified claims`);
        for (const ev of evidence.fabrication.slice(0, 3)) {
          console.log(`    ${ev}`);
        }
        if (evidence.fabrication.length > 3) {
          console.log(`    ... and ${evidence.fabrication.length - 3} more`);
        }
        console.log();
        totalIssues += patterns.fabrication;
      }

      if (patterns.breadthOverDepth > 0) {
        console.log(`⚠️ Breadth Over Depth: ${patterns.breadthOverDepth} projects in ${hours}h`);
        for (const ev of evidence.breadthOverDepth.slice(0, 5)) {
          console.log(`    ${ev}`);
        }
        console.log();
        totalIssues++;
      }

      if (totalIssues === 0) {
        console.log('✅ No shadow patterns detected in this period.');
      } else {
        // Save shadow analysis
        const shadowReport = `Shadow analysis for ${hours}h period: Sycophancy(${patterns.sycophancy}), Avoidance(${patterns.avoidance}), Fabrication(${patterns.fabrication}), Breadth-over-depth(${patterns.breadthOverDepth}). Total concerns: ${totalIssues}.`;
        
        const saved = await engine.save({
          content: shadowReport,
          type: 'shadow',
          importance: 0.8,
          source: 'shadow-analysis',
          tags: ['shadow', 'self-analysis', `${hours}h`]
        });

        console.log(`📝 Saved shadow analysis as memory ${saved.id.slice(0, 8)}`);
      }

    } catch (err) {
      console.error('Error during shadow analysis:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('predict')
  .description('Save a prediction with deadline')
  .argument('<statement>', 'Prediction statement')
  .option('-c, --confidence <n>', 'Confidence level 0.0-1.0', '0.5')
  .option('--by <deadline>', 'Deadline (ISO date: YYYY-MM-DD)', new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
  .option('--holder <holder>', 'Prediction holder (ryan|orion|shared)', 'orion')
  .option('-d, --domain <domain>', 'Domain (ryan|projects|self|world)', 'self')
  .action(async (statement: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const confidence = parseFloat(opts.confidence);
      if (confidence < 0 || confidence > 1) {
        console.error('Confidence must be between 0.0 and 1.0');
        process.exit(1);
      }

      // Validate deadline format
      const deadlineDate = new Date(opts.by);
      if (isNaN(deadlineDate.getTime())) {
        console.error('Invalid deadline format. Use YYYY-MM-DD');
        process.exit(1);
      }

      const memory = await engine.savePrediction(statement, confidence, opts.by, opts.holder, opts.domain);

      console.log(`✓ Saved prediction ${memory.id.slice(0, 8)}`);
      console.log(`  Holder: ${opts.holder} | Domain: ${opts.domain} | Confidence: ${confidence}`);
      console.log(`  Deadline: ${opts.by}`);
      console.log(`  "${statement}"`);
    } catch (err) {
      console.error('Error saving prediction:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('predictions')
  .description('List open predictions')
  .option('--holder <holder>', 'Filter by holder')
  .option('--expired', 'Show only expired predictions')
  .option('-d, --domain <domain>', 'Filter by domain')
  .action(async (opts) => {
    const engine = new MemoryEngine();
    try {
      const predictions = await engine.getPredictions({
        holder: opts.holder,
        expired: opts.expired,
        domain: opts.domain
      });

      if (predictions.length === 0) {
        console.log(opts.expired ? 'No expired predictions found.' : 'No open predictions found.');
        return;
      }

      console.log(`Found ${predictions.length} ${opts.expired ? 'expired ' : ''}predictions:\n`);

      const now = new Date();
      for (const prediction of predictions) {
        const meta = prediction.metadata as any;
        const confidence = meta?.confidence || 0.5;
        const deadline = new Date(meta?.deadline);
        const holder = meta?.holder || 'unknown';
        const domain = meta?.domain || 'unknown';
        
        const daysUntil = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        let timeInfo;
        if (daysUntil > 0) {
          timeInfo = `Due in ${daysUntil} days`;
        } else if (daysUntil === 0) {
          timeInfo = `Due TODAY`;
        } else {
          timeInfo = `OVERDUE by ${Math.abs(daysUntil)} days`;
        }

        console.log(`[${prediction.id.slice(0, 8)}] ${holder}/${domain} | confidence: ${confidence.toFixed(2)} | ${timeInfo}`);
        console.log(`  "${prediction.content}"`);
        console.log(`  Deadline: ${deadline.toLocaleDateString()}`);
        console.log();
      }
    } catch (err) {
      console.error('Error listing predictions:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('resolve')
  .description('Resolve a prediction')
  .argument('<prediction-id>', 'Prediction ID or prefix')
  .option('--outcome <outcome>', 'Outcome: correct|wrong|partial', 'correct')
  .option('--reason <reason>', 'What actually happened', 'Resolved via CLI')
  .action(async (predictionId: string, opts) => {
    const engine = new MemoryEngine();
    try {
      if (!['correct', 'wrong', 'partial'].includes(opts.outcome)) {
        console.error('Outcome must be: correct, wrong, or partial');
        process.exit(1);
      }

      const resolved = await engine.resolvePrediction(predictionId, opts.outcome as 'correct' | 'wrong' | 'partial', opts.reason);
      if (resolved) {
        console.log(`✓ Resolved prediction ${predictionId.slice(0, 8)} as ${opts.outcome}`);
        console.log(`  Reason: ${opts.reason}`);
        console.log(`  "${resolved.content}"`);
      } else {
        console.log(`Prediction not found: ${predictionId}`);
      }
    } catch (err) {
      console.error('Error resolving prediction:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('calibration')
  .description('Show calibration scores')
  .option('--holder <holder>', 'Filter by holder')
  .option('-d, --domain <domain>', 'Filter by domain')
  .action(async (opts) => {
    const engine = new MemoryEngine();
    try {
      const cal = await engine.getCalibration({
        holder: opts.holder,
        domain: opts.domain
      });

      console.log('🎯 Calibration Analysis\n');
      console.log(`Total predictions: ${cal.totalPredictions}`);
      console.log(`Resolved predictions: ${cal.resolvedCount}`);

      if (cal.resolvedCount === 0) {
        console.log('\nNo resolved predictions to analyze.');
        return;
      }

      const brierGrade = cal.brierScore < 0.2 ? 'excellent' : 
                         cal.brierScore < 0.3 ? 'good' : 
                         cal.brierScore < 0.5 ? 'fair' : 'poor';
      
      console.log(`Overall Brier Score: ${cal.brierScore.toFixed(3)} (${brierGrade})\n`);

      if (cal.byConfidenceBucket.length > 0) {
        console.log('Confidence Calibration:');
        for (const bucket of cal.byConfidenceBucket) {
          const predicted = (bucket.predicted * 100).toFixed(0);
          const actual = (bucket.actual * 100).toFixed(0);
          const calibration = Math.abs(bucket.predicted - bucket.actual) < 0.1 ? '✓ well calibrated' : 
                             bucket.predicted > bucket.actual ? '↗ overconfident' : '↘ underconfident';
          console.log(`  When you say ${bucket.bucket}: actually right ${actual}% (${bucket.count} cases) ${calibration}`);
        }
        console.log();
      }

      if (Object.keys(cal.byDomain).length > 1) {
        console.log('By Domain:');
        for (const [domain, data] of Object.entries(cal.byDomain)) {
          console.log(`  ${domain}: ${data.brierScore.toFixed(3)} (${data.count} predictions)`);
        }
        console.log();
      }

      if (Object.keys(cal.byHolder).length > 1) {
        console.log('By Holder:');
        for (const [holder, data] of Object.entries(cal.byHolder)) {
          console.log(`  ${holder}: ${data.brierScore.toFixed(3)} (${data.count} predictions)`);
        }
      }
    } catch (err) {
      console.error('Error analyzing calibration:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('gaps')
  .description('Show stated vs revealed belief gaps')
  .option('--holder <holder>', 'Filter by holder', 'orion')
  .action(async (opts) => {
    const engine = new MemoryEngine();
    try {
      const gaps = await engine.getBeliefGaps(opts.holder);

      if (gaps.length === 0) {
        console.log(`No belief gaps found for ${opts.holder}.`);
        return;
      }

      console.log(`🔍 Stated vs Revealed Belief Gaps for ${opts.holder}\n`);

      for (const gap of gaps.slice(0, 10)) {
        const trendIcon = gap.trend === 'widening' ? '📈' : gap.trend === 'narrowing' ? '📉' : '➡️';
        
        console.log(`[${gap.belief.id.slice(0, 8)}] Gap: ${gap.gap.toFixed(2)} | Trend: ${trendIcon} ${gap.trend}`);
        console.log(`  Stated confidence: ${gap.statedConfidence.toFixed(2)}`);
        console.log(`  Revealed signals: ${gap.revealedSignals.length}`);
        console.log(`  "${gap.belief.content}"`);
        
        if (gap.revealedSignals.length > 0) {
          console.log(`  Recent behavior: ${gap.revealedSignals[0].content.slice(0, 80)}`);
        }
        console.log();
      }

      if (gaps.length > 10) {
        console.log(`... and ${gaps.length - 10} more gaps`);
      }
    } catch (err) {
      console.error('Error analyzing belief gaps:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('behavior')
  .description('Log a behavioral signal')
  .argument('<description>', 'Behavior description')
  .option('--holder <holder>', 'Behavior holder (ryan|orion|shared)', 'orion')
  .option('--beliefs <ids>', 'Comma-separated belief IDs this relates to')
  .action(async (description: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const relatedBeliefs = opts.beliefs ? opts.beliefs.split(',').map((id: string) => id.trim()) : undefined;
      
      const memory = await engine.logBehavior(description, opts.holder, relatedBeliefs);

      console.log(`✓ Logged behavior ${memory.id.slice(0, 8)}`);
      console.log(`  Holder: ${opts.holder}`);
      if (relatedBeliefs) {
        console.log(`  Related beliefs: ${relatedBeliefs.join(', ')}`);
      }
      console.log(`  "${description}"`);
    } catch (err) {
      console.error('Error logging behavior:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('attention')
  .description('Show attention distribution')
  .option('--period <hours>', 'Time period in hours', '24')
  .option('--holder <holder>', 'Filter by holder')
  .action(async (opts) => {
    const engine = new MemoryEngine();
    try {
      const attention = await engine.getAttention({
        holder: opts.holder,
        periodHours: parseInt(opts.period)
      });

      console.log(`🧠 Attention Analysis: Last ${opts.period} Hours\n`);

      const topTopics = Object.entries(attention.topicDistribution)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      if (topTopics.length === 0) {
        console.log('No attention records found.');
        return;
      }

      console.log('Topic Distribution:');
      const totalMinutes = Object.values(attention.topicDistribution).reduce((a, b) => a + b, 0);
      
      for (const [topic, minutes] of topTopics) {
        const percentage = totalMinutes > 0 ? ((minutes / totalMinutes) * 100).toFixed(1) : '0.0';
        const percentageNum = parseFloat(percentage);
        const bar = '█'.repeat(Math.max(1, Math.round(percentageNum / 5)));
        console.log(`  ${topic.padEnd(20)} ${bar} ${minutes}m (${percentage}%)`);
      }

      console.log(`\nProject count: ${attention.projectCount}`);
      console.log(`Breadth score: ${attention.breadthScore.toFixed(2)} (0=focused, 1=scattered)`);
      console.log(`Trend: ${attention.trend}`);

      const focusAssessment = attention.breadthScore < 0.3 ? 'Very focused' :
                              attention.breadthScore < 0.6 ? 'Moderately focused' :
                              attention.breadthScore < 0.8 ? 'Somewhat scattered' : 'Very scattered';
      
      console.log(`\n💡 Assessment: ${focusAssessment}`);
    } catch (err) {
      console.error('Error analyzing attention:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('followups')
  .description('List open follow-up items')
  .option('--holder <holder>', 'Filter by holder')
  .option('--resolved', 'Show resolved follow-ups instead of open ones')
  .action(async (opts) => {
    const engine = new MemoryEngine();
    try {
      const followUps = await engine.getFollowUps({
        holder: opts.holder,
        resolved: opts.resolved
      });

      if (followUps.length === 0) {
        console.log(opts.resolved ? 'No resolved follow-ups found.' : 'No open follow-ups found.');
        return;
      }

      console.log(`Found ${followUps.length} ${opts.resolved ? 'resolved' : 'open'} follow-ups:\n`);

      for (const followUp of followUps) {
        const meta = followUp.metadata as any;
        const holder = meta?.holder || 'unknown';
        const source = meta?.source || 'unknown';
        const status = meta?.status || 'unknown';
        
        console.log(`[${followUp.id.slice(0, 8)}] ${holder} | from: ${source} | status: ${status}`);
        console.log(`  "${followUp.content}"`);
        if (meta?.resolution) {
          console.log(`  Resolution: ${meta.resolution}`);
        }
        console.log(`  Created: ${new Date(followUp.createdAt).toLocaleDateString()}`);
        console.log();
      }
    } catch (err) {
      console.error('Error listing follow-ups:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('followup-resolve')
  .description('Resolve a follow-up')
  .argument('<id>', 'Follow-up ID or prefix')
  .option('--resolution <resolution>', 'Resolution description', 'Addressed via CLI')
  .action(async (id: string, opts) => {
    const engine = new MemoryEngine();
    try {
      const resolved = await engine.resolveFollowUp(id, opts.resolution);
      if (resolved) {
        console.log(`✓ Resolved follow-up ${id.slice(0, 8)}`);
        console.log(`  Resolution: ${opts.resolution}`);
        console.log(`  "${resolved.content}"`);
      } else {
        console.log(`Follow-up not found: ${id}`);
      }
    } catch (err) {
      console.error('Error resolving follow-up:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program
  .command('extract')
  .description('Auto-extract memories from a conversation transcript (reads from stdin or file)')
  .argument('[file]', 'Path to transcript file (or pipe via stdin)')
  .option('--namespace <ns>', 'Target namespace for extracted memories', 'general')
  .option('--dry-run', 'Show what would be extracted without saving')
  .option('-v, --verbose', 'Show extraction reasons')
  .action(async (file: string | undefined, opts) => {
    const engine = new MemoryEngine();
    try {
      let transcript = '';

      if (file) {
        // Read from file
        try {
          transcript = readFileSync(file, 'utf-8');
        } catch (err) {
          console.error(`Error reading file: ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        // Read from stdin
        const isTTY = process.stdin.isTTY;
        if (isTTY) {
          console.error('Usage: cat session.log | cortex extract [--namespace projects/voicecharm]');
          console.error('       cortex extract session.log [--namespace projects/voicecharm]');
          process.exit(1);
        }
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        transcript = Buffer.concat(chunks).toString('utf-8');
      }

      if (!transcript.trim()) {
        console.error('Empty transcript — nothing to extract.');
        process.exit(1);
      }

      const extracted = extractFromTranscript(transcript, opts.namespace);

      if (extracted.length === 0) {
        console.log('No structured memories could be extracted from the transcript.');
        return;
      }

      console.log(`Extracted ${extracted.length} memories from transcript:\n`);

      const byType: Record<string, number> = {};
      for (const m of extracted) {
        const t = m.input.type ?? 'semantic';
        byType[t] = (byType[t] ?? 0) + 1;
      }
      for (const [type, count] of Object.entries(byType)) {
        console.log(`  ${type}: ${count}`);
      }
      console.log();

      for (const m of extracted) {
        const typeIcon = m.input.type === 'belief' ? '🔵' :
                         m.input.type === 'reflection' ? '🟡' :
                         m.input.namespace === 'user/people' ? '🟣' : '⚪';
        console.log(`${typeIcon} [${m.input.type}] ${m.input.namespace}`);
        console.log(`  ${m.input.content.slice(0, 100)}${m.input.content.length > 100 ? '...' : ''}`);
        if (opts.verbose) console.log(`  Reason: ${m.reason}`);
        console.log();
      }

      if (opts.dryRun) {
        console.log('Dry run — nothing saved. Remove --dry-run to save.');
        return;
      }

      let saved = 0;
      for (const m of extracted) {
        try {
          await engine.save(m.input, false); // Skip FTS rebuild per-save
          saved++;
        } catch (err) {
          console.error(`  Failed to save: ${(err as Error).message}`);
        }
      }

      // Rebuild FTS once at the end
      await engine.rebuildFtsIndex();
      console.log(`✓ Saved ${saved}/${extracted.length} extracted memories`);

    } catch (err) {
      console.error('Error during extraction:', (err as Error).message);
      process.exit(1);
    } finally {
      engine.close();
    }
  });

program.parse();
