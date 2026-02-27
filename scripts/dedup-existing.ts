#!/usr/bin/env npx tsx
/**
 * Deduplicate existing Cortex memories by content hash.
 * Keeps the oldest entry for each unique content, deletes the rest.
 */
import { connect, type Table } from '@lancedb/lancedb';
import { createHash } from 'crypto';

const dbPath = `${process.env.HOME}/.cortex/lance_db`;

async function main() {
  const db = await connect(dbPath);
  const tbl = await db.openTable('memories');
  
  console.log('Loading all memories...');
  const rows = await tbl.query().select(['id', 'content', 'created_at']).toArray();
  console.log(`Total: ${rows.length}`);

  // Group by content hash
  const hashMap = new Map<string, Array<{ id: string; created_at: string }>>();
  for (const r of rows) {
    const hash = createHash('sha256').update(r.content.trim()).digest('hex');
    if (!hashMap.has(hash)) hashMap.set(hash, []);
    hashMap.get(hash)!.push({ id: r.id, created_at: r.created_at });
  }

  console.log(`Unique content hashes: ${hashMap.size}`);
  
  // Find duplicates to delete (keep oldest)
  const toDelete: string[] = [];
  for (const [, entries] of hashMap) {
    if (entries.length > 1) {
      entries.sort((a, b) => a.created_at.localeCompare(b.created_at));
      // Keep first (oldest), delete rest
      for (let i = 1; i < entries.length; i++) {
        toDelete.push(entries[i].id);
      }
    }
  }

  console.log(`Duplicates to remove: ${toDelete.length}`);
  
  if (toDelete.length === 0) {
    console.log('No duplicates found!');
    return;
  }

  // Delete in batches
  const batchSize = 100;
  for (let i = 0; i < toDelete.length; i += batchSize) {
    const batch = toDelete.slice(i, i + batchSize);
    const whereClause = batch.map(id => `id = '${id}'`).join(' OR ');
    await tbl.delete(whereClause);
    process.stdout.write(`  Deleted ${Math.min(i + batchSize, toDelete.length)}/${toDelete.length}\r`);
  }
  console.log(`\n✓ Removed ${toDelete.length} duplicate memories`);

  // Verify
  const remaining = await tbl.query().select(['id']).toArray();
  console.log(`Remaining memories: ${remaining.length}`);
}

main().catch(console.error);
