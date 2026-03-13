import { connect, Index, type Connection, type Table } from '@lancedb/lancedb';
import { mkdirSync } from 'fs';

export function getDefaultDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '~';
  return `${home}/.cortex/lance_db`;
}

export async function initDatabase(dbPath: string): Promise<Connection> {
  mkdirSync(dbPath, { recursive: true });
  const db = await connect(dbPath);
  return db;
}

export async function getOrCreateTable(db: Connection): Promise<Table> {
  const tableNames = await db.tableNames();
  if (tableNames.includes('memories')) {
    const table = await db.openTable('memories');
    // Migration: add missing columns
    try {
      const schema = await table.schema();
      const fieldNames = schema.fields.map((f: any) => f.name);
      const migrations: Array<{ name: string; valueSql: string }> = [];
      if (!fieldNames.includes('namespace')) migrations.push({ name: 'namespace', valueSql: "'general'" });
      if (!fieldNames.includes('l0_content')) migrations.push({ name: 'l0_content', valueSql: "''" });
      if (!fieldNames.includes('l1_content')) migrations.push({ name: 'l1_content', valueSql: "''" });
      if (migrations.length > 0) {
        await table.addColumns(migrations);
      }
    } catch {
      // If schema introspection fails, try adding columns individually
      for (const col of [
        { name: 'namespace', valueSql: "'general'" },
        { name: 'l0_content', valueSql: "''" },
        { name: 'l1_content', valueSql: "''" },
      ]) {
        try { await table.addColumns([col]); } catch { /* column may already exist */ }
      }
    }
    return table;
  }
  // Create with a dummy record then delete it
  const table = await db.createTable('memories', [
    {
      id: '__init__',
      namespace: 'general',
      type: 'semantic',
      content: 'init',
      l0_content: '',
      l1_content: '',
      importance: 0.5,
      source: 'system',
      tags: '[]',
      metadata: '{}',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      accessed_at: new Date().toISOString(),
      access_count: 0,
      vector: new Array(384).fill(0),
    },
  ]);
  await table.delete("id = '__init__'");
  // Create FTS index on content
  try {
    await table.createIndex('content', { config: Index.fts() });
  } catch {
    // Index may already exist
  }
  return table;
}
