#!/usr/bin/env npx tsx
/**
 * Import ChatGPT conversation history into Cortex.
 * Parses conversations-*.json files, extracts user+assistant messages,
 * chunks by conversation turn pairs, and ingests with dedup.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { MemoryEngine } from '../dist/engine.js';
import type { MemoryInput } from '../dist/types.js';

const CHATGPT_DIR = `${process.env.HOME}/Documents/chatgpt_history`;
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_FILES = process.argv.includes('--limit') 
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1]) 
  : undefined;

interface ChatMessage {
  id: string;
  author: { role: string };
  content: { content_type: string; parts?: any[] };
  create_time?: number;
}

interface Conversation {
  id: string;
  title: string;
  create_time: number;
  mapping: Record<string, { message?: ChatMessage; parent?: string; children?: string[] }>;
}

function extractConversationChunks(conv: Conversation): MemoryInput[] {
  const inputs: MemoryInput[] = [];
  
  // Walk the message tree to get ordered messages
  const messages: Array<{ role: string; text: string; time?: number }> = [];
  
  // Find root node (no parent or parent not in mapping)
  const visited = new Set<string>();
  
  function walk(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    
    const node = conv.mapping[nodeId];
    if (!node) return;
    
    const msg = node.message;
    if (msg && msg.author && msg.content?.parts) {
      const role = msg.author.role;
      if (role === 'user' || role === 'assistant') {
        const textParts = msg.content.parts
          .filter((p: any) => typeof p === 'string')
          .join('\n')
          .trim();
        if (textParts.length > 20) { // skip trivial messages
          messages.push({ role, text: textParts, time: msg.create_time });
        }
      }
    }
    
    // Walk children
    for (const childId of node.children ?? []) {
      walk(childId);
    }
  }
  
  // Find root nodes
  for (const [id, node] of Object.entries(conv.mapping ?? {})) {
    if (!node.parent || !conv.mapping[node.parent]) {
      walk(id);
    }
  }
  
  if (messages.length === 0) return inputs;
  
  // Group into conversation chunks (user + assistant pairs, with context)
  // Aim for paragraph-level chunks: combine consecutive turns into chunks
  const title = conv.title || 'Untitled conversation';
  const date = conv.create_time 
    ? new Date(conv.create_time * 1000).toISOString().split('T')[0] 
    : 'unknown';
  
  // Strategy: group by user-assistant pairs, max ~2000 chars per chunk
  let currentChunk: string[] = [];
  let currentLen = 0;
  const MAX_CHUNK = 2000;
  
  const flushChunk = () => {
    if (currentChunk.length === 0) return;
    const content = `[ChatGPT conversation: "${title}" (${date})]\n\n${currentChunk.join('\n\n')}`;
    inputs.push({
      content,
      type: 'episodic',
      importance: 0.4,
      source: 'chatgpt-import',
      tags: ['chatgpt', 'conversation'],
    });
    currentChunk = [];
    currentLen = 0;
  };
  
  for (const msg of messages) {
    const prefix = msg.role === 'user' ? 'User' : 'Assistant';
    const text = `${prefix}: ${msg.text}`;
    
    if (currentLen + text.length > MAX_CHUNK && currentChunk.length > 0) {
      flushChunk();
    }
    
    currentChunk.push(text);
    currentLen += text.length;
  }
  
  flushChunk();
  return inputs;
}

async function main() {
  // Find conversation files
  const files = readdirSync(CHATGPT_DIR)
    .filter(f => f.startsWith('conversations-') && f.endsWith('.json'))
    .sort();
  
  const filesToProcess = LIMIT_FILES ? files.slice(0, LIMIT_FILES) : files;
  console.log(`Found ${files.length} conversation files, processing ${filesToProcess.length}`);
  
  // Parse all conversations
  let allInputs: MemoryInput[] = [];
  let totalConvs = 0;
  
  for (const file of filesToProcess) {
    const path = join(CHATGPT_DIR, file);
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Conversation[];
    totalConvs += data.length;
    
    for (const conv of data) {
      const chunks = extractConversationChunks(conv);
      allInputs.push(...chunks);
    }
    console.log(`  ${file}: ${data.length} conversations → ${allInputs.length} chunks so far`);
  }
  
  console.log(`\nTotal: ${totalConvs} conversations → ${allInputs.length} chunks`);
  
  if (DRY_RUN) {
    console.log('Dry run — not saving. Sample chunk:');
    if (allInputs.length > 0) {
      console.log(allInputs[0].content.slice(0, 500));
    }
    return;
  }
  
  // Ingest with dedup
  const engine = new MemoryEngine();
  try {
    const saved = await engine.saveBatch(allInputs, true); // dedup=true
    console.log(`\n✓ Ingested ${saved} ChatGPT memory chunks`);
    
    const stats = await engine.stats();
    console.log(`Total memories now: ${stats.totalMemories}`);
  } finally {
    engine.close();
  }
}

main().catch(console.error);
