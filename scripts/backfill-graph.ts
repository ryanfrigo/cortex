/**
 * Backfill the knowledge graph from all existing memories.
 * Run: npx tsx scripts/backfill-graph.ts
 */
import * as lancedb from '@lancedb/lancedb';
import { join } from 'path';
import { homedir } from 'os';
import { KnowledgeGraph } from '../src/graph.js';

const BATCH_SIZE = 100;
const LOG_EVERY = 500;

async function main() {
  const dbPath = join(homedir(), '.cortex', 'lance_db');
  console.log(`Connecting to LanceDB at ${dbPath}...`);

  const db = await lancedb.connect(dbPath);
  const tbl = await db.openTable('memories');
  const total = await tbl.countRows();
  console.log(`Total memories: ${total}`);

  const graph = new KnowledgeGraph();

  let processed = 0;
  let offset = 0;
  let errCount = 0;

  while (offset < total) {
    const rows = await tbl.query().offset(offset).limit(BATCH_SIZE).toArray();
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        const content = row.content as string;
        const id = row.id as string;
        if (content && content.trim().length > 0) {
          await graph.extractAndLink(id, content);
        }
      } catch (err) {
        errCount++;
        if (errCount <= 5) {
          console.error(`  Error on row ${row.id}:`, (err as Error).message);
        }
      }
      processed++;
    }

    if (processed % LOG_EVERY === 0 || processed === total) {
      const stats = graph.stats();
      console.log(`  Processed ${processed}/${total} — entities: ${stats.entityCount}, relationships: ${stats.relationshipCount}`);
    }

    offset += BATCH_SIZE;
  }

  console.log(`\nBackfill complete. Processed ${processed} memories, errors: ${errCount}`);

  const stats = graph.stats();
  console.log('\n=== Graph Stats ===');
  console.log(`  Entities:      ${stats.entityCount}`);
  console.log(`  Relationships: ${stats.relationshipCount}`);
  console.log(`  Mentions:      ${stats.mentionCount}`);
  console.log('\n  By type:');
  for (const [type, count] of Object.entries(stats.byType).sort((a, b) => (b[1] as number) - (a[1] as number))) {
    console.log(`    ${type.padEnd(12)} ${count}`);
  }
  console.log('\n  Top entities by connections:');
  for (const ent of stats.topEntities) {
    console.log(`    [${ent.type.padEnd(10)}] ${ent.name.padEnd(30)} ${ent.connections} connections`);
  }

  graph.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
