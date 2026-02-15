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
    return db.openTable('memories');
  }
  // Create with a dummy record then delete it
  const table = await db.createTable('memories', [
    {
      id: '__init__',
      type: 'semantic',
      content: 'init',
      importance: 0.5,
      source: 'system',
      tags: '[]',
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
