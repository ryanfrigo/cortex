import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { MemoryEngine } from './engine.js';
import type { MemoryInput, MemoryType } from './types.js';

const SESSIONS_DIR = join(process.env.HOME || '~', '.openclaw/agents/main/sessions');
const CHECKPOINT_PATH = join(process.env.HOME || '~', '.cortex/session-ingest-checkpoint.json');

interface Checkpoint {
  ingestedSessions: string[]; // session IDs already processed
  lastRun: string;
}

interface SessionLine {
  type: string;
  id?: string;
  timestamp?: string;
  message?: {
    role: string;
    content: any;
    timestamp?: number;
  };
  customType?: string;
  [key: string]: any;
}

interface ConversationExchange {
  userMessage: string;
  assistantMessage: string;
  timestamp: string;
  toolCalls: string[];
}

function loadCheckpoint(): Checkpoint {
  if (existsSync(CHECKPOINT_PATH)) {
    return JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf-8'));
  }
  return { ingestedSessions: [], lastRun: '' };
}

function saveCheckpoint(cp: Checkpoint): void {
  const dir = join(process.env.HOME || '~', '.cortex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

function extractTextFromContent(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text' && c.text)
      .map((c: any) => c.text)
      .join('\n');
  }
  return '';
}

function parseSessionFile(filePath: string): { sessionId: string; sessionTimestamp: string; exchanges: ConversationExchange[] } {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  
  let sessionId = basename(filePath, '.jsonl');
  let sessionTimestamp = '';
  const exchanges: ConversationExchange[] = [];
  
  let currentUser = '';
  let currentAssistant = '';
  let currentTimestamp = '';
  let currentToolCalls: string[] = [];

  const flushExchange = () => {
    if (currentUser && currentAssistant) {
      // Trim very long messages
      const userTrimmed = currentUser.slice(0, 2000);
      const assistantTrimmed = currentAssistant.slice(0, 3000);
      exchanges.push({
        userMessage: userTrimmed,
        assistantMessage: assistantTrimmed,
        timestamp: currentTimestamp,
        toolCalls: currentToolCalls,
      });
    }
    currentUser = '';
    currentAssistant = '';
    currentTimestamp = '';
    currentToolCalls = [];
  };

  for (const line of lines) {
    let parsed: SessionLine;
    try { parsed = JSON.parse(line); } catch { continue; }

    if (parsed.type === 'session') {
      sessionId = parsed.id || sessionId;
      sessionTimestamp = parsed.timestamp || '';
      continue;
    }

    if (parsed.type !== 'message') continue;
    const msg = parsed.message;
    if (!msg) continue;

    const role = msg.role;
    const text = extractTextFromContent(msg.content);

    if (role === 'user') {
      // New user message = flush previous exchange
      flushExchange();
      currentUser = text;
      currentTimestamp = parsed.timestamp || '';
    } else if (role === 'assistant') {
      if (text.trim()) {
        currentAssistant += (currentAssistant ? '\n' : '') + text;
      }
    } else if (role === 'toolResult') {
      // Track tool usage but don't dump full output
      // (tool results can be huge)
    }

    // Track tool_use blocks in assistant messages
    if (role === 'assistant' && msg.content && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.name) {
          currentToolCalls.push(block.name);
        }
      }
    }
  }
  flushExchange();

  return { sessionId, sessionTimestamp, exchanges };
}

function exchangeToMemoryContent(exchange: ConversationExchange, sessionId: string): string {
  let content = `User: ${exchange.userMessage}\n\nAssistant: ${exchange.assistantMessage}`;
  if (exchange.toolCalls.length > 0) {
    content += `\n\nTools used: ${[...new Set(exchange.toolCalls)].join(', ')}`;
  }
  return content;
}

function isSubstantiveExchange(exchange: ConversationExchange): boolean {
  // Filter out trivial exchanges
  const userLen = exchange.userMessage.trim().length;
  const assistantLen = exchange.assistantMessage.trim().length;
  
  // Skip if either side is empty or very short
  if (userLen < 10 || assistantLen < 20) return false;
  
  // Skip cron heartbeats that just say HEARTBEAT_OK
  if (exchange.assistantMessage.includes('HEARTBEAT_OK') && assistantLen < 100) return false;
  
  // Skip error-only responses
  if (exchange.assistantMessage.startsWith('Error:') && assistantLen < 100) return false;
  
  return true;
}

export async function ingestSessions(opts: { force?: boolean; limit?: number; verbose?: boolean } = {}): Promise<{ ingested: number; skipped: number; exchanges: number }> {
  const checkpoint = opts.force ? { ingestedSessions: [], lastRun: '' } : loadCheckpoint();
  const ingestedSet = new Set(checkpoint.ingestedSessions);

  if (!existsSync(SESSIONS_DIR)) {
    console.error(`Sessions directory not found: ${SESSIONS_DIR}`);
    return { ingested: 0, skipped: 0, exchanges: 0 };
  }

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      id: basename(f, '.jsonl'),
      path: join(SESSIONS_DIR, f),
    }))
    .filter(f => !ingestedSet.has(f.id));

  if (files.length === 0) {
    console.log('No new sessions to ingest.');
    return { ingested: 0, skipped: 0, exchanges: 0 };
  }

  const toProcess = opts.limit ? files.slice(0, opts.limit) : files;
  console.log(`Found ${files.length} new sessions, processing ${toProcess.length}...`);

  const engine = new MemoryEngine();
  let totalExchanges = 0;
  let skippedSessions = 0;
  const allInputs: MemoryInput[] = [];

  try {
    for (let i = 0; i < toProcess.length; i++) {
      const file = toProcess[i];
      const { sessionId, sessionTimestamp, exchanges } = parseSessionFile(file.path);

      const substantive = exchanges.filter(isSubstantiveExchange);
      
      if (substantive.length === 0) {
        skippedSessions++;
        ingestedSet.add(file.id);
        if (opts.verbose) console.log(`  [${i + 1}/${toProcess.length}] ${sessionId.slice(0, 8)} — no substantive exchanges, skipping`);
        continue;
      }

      const inputs: MemoryInput[] = substantive.map(ex => ({
        content: exchangeToMemoryContent(ex, sessionId),
        type: 'session' as MemoryType,
        importance: 0.4,
        source: `session:${sessionId}`,
        tags: ['session', 'transcript'],
        metadata: {
          project: extractProject(ex.userMessage + ' ' + ex.assistantMessage),
        },
      }));

      allInputs.push(...inputs);
      ingestedSet.add(file.id);

      if (opts.verbose || (i + 1) % 50 === 0) {
        console.log(`  [${i + 1}/${toProcess.length}] ${sessionId.slice(0, 8)} — ${inputs.length} exchanges queued`);
      }
    }

    // Save all exchanges in one batch
    if (allInputs.length > 0) {
      console.log(`\nSaving ${allInputs.length} exchanges in batch...`);
      totalExchanges = await engine.saveBatch(allInputs, true);
    }

    // Save checkpoint
    checkpoint.ingestedSessions = Array.from(ingestedSet);
    checkpoint.lastRun = new Date().toISOString();
    saveCheckpoint(checkpoint);

    console.log(`\n✓ Ingested ${toProcess.length - skippedSessions} sessions, ${totalExchanges} exchanges total`);
    console.log(`  Skipped ${skippedSessions} empty/trivial sessions`);
    
    return { ingested: toProcess.length - skippedSessions, skipped: skippedSessions, exchanges: totalExchanges };
  } finally {
    engine.close();
  }
}

function extractProject(text: string): string | undefined {
  const lower = text.toLowerCase();
  const projects = ['voicecharm', 'kalshi', 'clawmart', 'perspektiv', 'cortex', 'viralmachine'];
  for (const p of projects) {
    if (lower.includes(p)) return p;
  }
  return undefined;
}
