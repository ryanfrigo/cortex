import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { MemoryEngine } from './engine.js';
import type { MemoryInput, MemoryType } from './types.js';
import Anthropic from '@anthropic-ai/sdk';

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

/** All known project names for auto-tagging */
const ALL_PROJECTS = [
  'myapp', 'trading', 'dashboard', 'blog', 'docs', 'api',
  'openclaw', 'remotion', 'vapi', 'convex', 'vercel', 'stripe',
];

/**
 * Detect all projects mentioned in text.
 * Returns array of matching project names.
 */
function extractAllProjects(text: string): string[] {
  const lower = text.toLowerCase();
  return ALL_PROJECTS.filter(p => lower.includes(p));
}

/**
 * AI-powered session summarization.
 * Condenses a session into key decisions, learnings, outcomes.
 * Returns structured MemoryInput[] ready to save.
 */
async function summarizeSessionWithAI(
  exchanges: ConversationExchange[],
  sessionId: string,
): Promise<MemoryInput[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('  ANTHROPIC_API_KEY not set — falling back to heuristic summarization');
    return [];
  }

  // Build compact transcript (limit tokens)
  const transcript = exchanges
    .slice(0, 15)
    .map((ex, i) =>
      `[${i + 1}] User: ${ex.userMessage.slice(0, 400)}\n    Assistant: ${ex.assistantMessage.slice(0, 600)}`,
    )
    .join('\n\n');

  const client = new Anthropic({ apiKey });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Analyze this AI agent session transcript and extract only the highest-value information.

SESSION TRANSCRIPT:
${transcript}

Respond with ONLY a JSON object (no markdown, no explanation) with these fields:
{
  "summary": "2-3 sentence session summary",
  "decisions": ["decision 1", "decision 2"],
  "learnings": ["lesson 1", "lesson 2"],
  "outcomes": ["concrete outcome 1"],
  "projects": ["project name 1"],
  "hasHighValue": true
}

Rules:
- decisions: only concrete choices made (skip trivial)
- learnings: only genuine lessons/corrections/insights
- outcomes: only tangible deliverables (code shipped, configs changed, etc.)
- projects: project names mentioned (myapp, trading, dashboard, etc.)
- hasHighValue: false if this session was just chit-chat or routine work
- Max 5 items per array, prefer fewer high-quality items over many weak ones
- Empty arrays are fine`,
        },
      ],
    });
  } catch (err) {
    console.warn(`  AI summarization failed: ${(err as Error).message}`);
    return [];
  }

  let parsed: {
    summary: string;
    decisions: string[];
    learnings: string[];
    outcomes: string[];
    projects: string[];
    hasHighValue: boolean;
  };

  try {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn('  Failed to parse AI response — falling back to heuristic');
    return [];
  }

  if (!parsed.hasHighValue) return [];

  const inputs: MemoryInput[] = [];
  const sessionTags = ['session', 'ai-summary', ...(parsed.projects || [])];
  const project = parsed.projects?.[0];

  // Session summary memory
  if (parsed.summary) {
    inputs.push({
      content: `[Session ${sessionId.slice(0, 8)}] ${parsed.summary}`,
      type: 'semantic' as MemoryType,
      importance: 0.5,
      source: `session:${sessionId}:ai-summary`,
      tags: sessionTags,
      metadata: { project, isSummary: true, exchangeCount: exchanges.length },
    });
  }

  // Decision memories — high importance
  for (const decision of (parsed.decisions || []).slice(0, 5)) {
    if (decision.trim()) {
      inputs.push({
        content: decision,
        type: 'decision' as MemoryType,
        importance: 0.7,
        source: `session:${sessionId}`,
        tags: [...sessionTags, 'decision'],
        metadata: { project },
      });
    }
  }

  // Learning memories — high importance
  for (const learning of (parsed.learnings || []).slice(0, 5)) {
    if (learning.trim()) {
      inputs.push({
        content: learning,
        type: 'lesson' as MemoryType,
        importance: 0.7,
        source: `session:${sessionId}`,
        tags: [...sessionTags, 'lesson'],
        metadata: { project },
      });
    }
  }

  // Outcome memories — medium-high importance
  for (const outcome of (parsed.outcomes || []).slice(0, 5)) {
    if (outcome.trim()) {
      inputs.push({
        content: outcome,
        type: 'episodic' as MemoryType,
        importance: 0.65,
        source: `session:${sessionId}`,
        tags: [...sessionTags, 'outcome'],
        metadata: { project },
      });
    }
  }

  return inputs;
}

export async function ingestSessions(opts: { force?: boolean; limit?: number; verbose?: boolean; summarize?: boolean } = {}): Promise<{ ingested: number; skipped: number; exchanges: number }> {
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

      let inputs: MemoryInput[];

      if (opts.summarize) {
        // AI summarization: condense session to key decisions/learnings/outcomes
        if (opts.verbose) process.stdout.write(`  [${i + 1}/${toProcess.length}] ${sessionId.slice(0, 8)} — summarizing with AI...`);
        const aiInputs = await summarizeSessionWithAI(substantive, sessionId);
        if (aiInputs.length > 0) {
          inputs = aiInputs;
          if (opts.verbose) console.log(` → ${aiInputs.length} memories`);
        } else {
          // Fallback: save a lightweight summary-only memory
          if (opts.verbose) console.log(` → low-value session, skipping`);
          ingestedSet.add(file.id);
          continue;
        }
      } else {
        // Standard heuristic ingestion — all substantive exchanges
        inputs = substantive.map(ex => {
          const fullText = ex.userMessage + ' ' + ex.assistantMessage;
          const meta = extractMetadata(fullText);
          // Enrich tags with all detected projects
          const projects = extractAllProjects(fullText);
          return {
            content: exchangeToMemoryContent(ex, sessionId),
            type: 'session' as MemoryType,
            importance: scoreImportance(ex),
            source: `session:${sessionId}`,
            tags: ['session', 'transcript', ...projects],
            metadata: { ...meta, ...(projects.length > 0 ? { projectNames: projects } as any : {}) } as any,
          };
        });

        // Add session summary for multi-turn sessions
        const summary = generateSessionSummary(substantive, sessionId);
        if (summary) {
          const summaryProjects = extractAllProjects(summary);
          inputs.push({
            content: summary,
            type: 'session' as MemoryType,
            importance: 0.5, // Updated from 0.6 to match session default
            source: `session:${sessionId}:summary`,
            tags: ['session', 'summary', ...summaryProjects],
            metadata: {
              project: extractProject(summary),
              isSummary: true,
              exchangeCount: substantive.length,
            },
          });
        }
      }

      allInputs.push(...inputs);
      ingestedSet.add(file.id);

      if (!opts.summarize && (opts.verbose || (i + 1) % 50 === 0)) {
        console.log(`  [${i + 1}/${toProcess.length}] ${sessionId.slice(0, 8)} — ${inputs.length} memories queued`);
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
  const projects = ['myapp', 'trading', 'dashboard', 'blog', 'docs', 'api'];
  for (const p of projects) {
    if (lower.includes(p)) return p;
  }
  return undefined;
}

/** Extract structured metadata from exchange text for richer search */
function extractMetadata(text: string): Record<string, any> {
  const meta: Record<string, any> = {};

  // Extract file paths (e.g. src/foo.ts, ~/dev/bar.py, /Users/...)
  const filePaths = [...new Set(
    (text.match(/(?:[\w~.]\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,10}/g) || [])
      .filter(p => !p.startsWith('http') && !p.includes('@'))
      .slice(0, 10)
  )];
  if (filePaths.length) meta.files = filePaths;

  // Extract URLs
  const urls = [...new Set(
    (text.match(/https?:\/\/[^\s"'<>\]){},]+/g) || []).slice(0, 5)
  )];
  if (urls.length) meta.urls = urls;

  // Extract git commits
  const commits = [...new Set(
    (text.match(/\b[0-9a-f]{7,40}\b/g) || [])
      .filter(h => h.length >= 7 && h.length <= 40 && !/^\d+$/.test(h))
      .slice(0, 5)
  )];
  if (commits.length) meta.commits = commits;

  // Detect deployment signals
  const deploySignals = ['deployed', 'pushed to prod', 'live on', 'shipped to', 'vercel', 'git push'];
  if (deploySignals.some(s => text.toLowerCase().includes(s))) {
    meta.deployed = true;
  }

  // Extract project
  const project = extractProject(text);
  if (project) meta.project = project;

  return meta;
}

/** Generate a summary memory for sessions with many exchanges */
function generateSessionSummary(exchanges: ConversationExchange[], sessionId: string): string | null {
  if (exchanges.length < 3) return null;

  // Collect key signals across all exchanges
  const allTools = new Set<string>();
  const allProjects = new Set<string>();
  const topics: string[] = [];

  for (const ex of exchanges) {
    ex.toolCalls.forEach(t => allTools.add(t));
    const proj = extractProject(ex.userMessage + ' ' + ex.assistantMessage);
    if (proj) allProjects.add(proj);

    // First 100 chars of user message as topic hint
    const topic = ex.userMessage.slice(0, 100).replace(/\n/g, ' ').trim();
    if (topic.length > 15) topics.push(topic);
  }

  const parts = [`Session ${sessionId.slice(0, 8)} — ${exchanges.length} exchanges`];
  if (allProjects.size > 0) parts.push(`Projects: ${[...allProjects].join(', ')}`);
  if (allTools.size > 0) parts.push(`Tools: ${[...allTools].slice(0, 10).join(', ')}`);
  if (topics.length > 0) parts.push(`Topics:\n${topics.slice(0, 8).map(t => `- ${t}`).join('\n')}`);

  return parts.join('\n');
}

/** Score exchange importance based on content signals (0.2 - 0.9) */
function scoreImportance(exchange: ConversationExchange): number {
  const text = (exchange.userMessage + ' ' + exchange.assistantMessage).toLowerCase();
  let score = 0.3; // base

  // High-value signals: decisions, deployments, money
  const highSignals = [
    /deploy|pushed to prod|shipped|launched|live on/,
    /decision|decided|pivot|strategy change/,
    /\$\d+|revenue|paying customer|subscription|invoice/,
    /api key|secret|credential|password/,
    /bug fix|critical|breaking|incident|outage/,
    /architecture|migration|refactor/,
  ];
  for (const re of highSignals) {
    if (re.test(text)) { score += 0.15; break; }
  }

  // Medium signals: learning, configuration, setup
  const medSignals = [
    /learned|lesson|mistake|realized|correction/,
    /configured|setup|installed|integrated/,
    /commit|merge|pr |pull request/,
    /cron|schedule|automat/,
  ];
  for (const re of medSignals) {
    if (re.test(text)) { score += 0.1; break; }
  }

  // Tool usage depth — more tools = more substantial work
  if (exchange.toolCalls.length >= 5) score += 0.1;
  else if (exchange.toolCalls.length >= 2) score += 0.05;

  // Longer substantive responses indicate deeper work
  if (exchange.assistantMessage.length > 1500) score += 0.05;

  // Low-value signals: reduce score
  const lowSignals = [
    /heartbeat|heartbeat_ok/,
    /no_reply/,
    /weather|temperature|forecast/,
  ];
  for (const re of lowSignals) {
    if (re.test(text)) { score -= 0.1; break; }
  }

  return Math.max(0.1, Math.min(0.9, score));
}
