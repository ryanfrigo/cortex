/**
 * Migrate memory namespaces based on type and tags.
 * Run: npx tsx scripts/migrate-namespaces.ts
 */
import * as lancedb from '@lancedb/lancedb';
import { join } from 'path';
import { homedir } from 'os';

const BATCH_SIZE = 200;

// Known project names for tag-based namespace assignment
const PROJECT_NAMES = [
  'myapp', 'dashboard', 'blog', 'docs', 'trading',
  'videogen', 'mybrand', 'viral-machine',
];

function resolveNamespace(type: string, tags: string[]): string | null {
  // Type-based mapping
  switch (type) {
    case 'session':     return 'sessions';
    case 'belief':      return 'beliefs';
    case 'reflection':  return 'reflections';
    case 'decision':    return 'decisions';
    case 'person':      return 'people';
    case 'project-state': return 'projects';
    default:            break;
  }

  // Tag-based project namespace
  const lowerTags = tags.map(t => t.toLowerCase());
  for (const proj of PROJECT_NAMES) {
    if (lowerTags.some(t => t.includes(proj))) {
      // Normalize project name
      const normalized = proj.replace('-', '');
      return `projects/${normalized}`;
    }
  }

  return null; // don't change
}

async function main() {
  const dbPath = join(homedir(), '.cortex', 'lance_db');
  console.log(`Connecting to LanceDB at ${dbPath}...`);

  const db = await lancedb.connect(dbPath);
  const tbl = await db.openTable('memories');
  const total = await tbl.countRows();
  console.log(`Total memories: ${total}`);

  let offset = 0;
  let changed = 0;
  let skipped = 0;

  const changesByNamespace: Record<string, number> = {};

  while (offset < total) {
    const rows = await tbl.query().offset(offset).limit(BATCH_SIZE).toArray();
    if (rows.length === 0) break;

    for (const row of rows) {
      const currentNs = (row.namespace as string) ?? 'general';
      const type = row.type as string;
      let tags: string[] = [];
      try {
        tags = typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags ?? []);
      } catch { tags = []; }

      const newNs = resolveNamespace(type, tags);

      // Only update if we have a new namespace AND it differs from current
      if (newNs && newNs !== currentNs) {
        try {
          await tbl.update({
            where: `id = '${(row.id as string).replace(/'/g, "''")}'`,
            values: { namespace: newNs },
          });
          changed++;
          changesByNamespace[newNs] = (changesByNamespace[newNs] ?? 0) + 1;
        } catch (err) {
          console.error(`  Error updating ${row.id}:`, (err as Error).message);
        }
      } else {
        skipped++;
      }
    }

    if ((offset + BATCH_SIZE) % 2000 === 0 || offset + BATCH_SIZE >= total) {
      console.log(`  Processed ${Math.min(offset + BATCH_SIZE, total)}/${total} — changed: ${changed}, skipped: ${skipped}`);
    }

    offset += BATCH_SIZE;
  }

  console.log(`\nMigration complete.`);
  console.log(`  Changed: ${changed}`);
  console.log(`  Skipped (already correct or no rule): ${skipped}`);
  console.log('\n  Changes by new namespace:');
  for (const [ns, count] of Object.entries(changesByNamespace).sort((a, b) => (b[1] as number) - (a[1] as number))) {
    console.log(`    ${ns.padEnd(30)} ${count}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
