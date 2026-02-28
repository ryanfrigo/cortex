import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryEngine } from './engine.js';
import type { MemoryType, MemoryMetadata } from './types.js';

const ALL_TYPES = ['episodic', 'semantic', 'procedural', 'decision', 'lesson', 'fact', 'preference', 'project-state', 'person'];

const engine = new MemoryEngine();

const server = new Server(
  { name: 'cortex-memory', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_save',
      description: 'Save a new memory. Use this to remember facts, preferences, procedures, decisions, lessons, or events for later recall.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'The memory content to save' },
          type: { type: 'string', enum: ALL_TYPES, description: 'Memory type' },
          importance: { type: 'number', description: 'Importance from 0.0 to 1.0 (default 0.5)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
          metadata: {
            type: 'object',
            description: 'Optional metadata',
            properties: {
              project: { type: 'string', description: 'Project name (e.g. voicecharm, kalshi)' },
              confidence: { type: 'number', description: '0-1, how verified' },
              supersedes: { type: 'string', description: 'ID of memory this replaces' },
              expiresAt: { type: 'string', description: 'ISO 8601 expiry date' },
            },
          },
        },
        required: ['content'],
      },
    },
    {
      name: 'memory_search',
      description: 'Search memories using hybrid retrieval (semantic similarity + full-text + recency + importance). Use this to recall relevant information.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results (default 5)' },
          type: { type: 'string', enum: ALL_TYPES, description: 'Filter by memory type' },
          project: { type: 'string', description: 'Filter by project name' },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_context',
      description: 'Get a summary of all stored memories and database statistics.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'memory_forget',
      description: 'Delete a memory by its ID.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Memory ID to delete' },
        },
        required: ['id'],
      },
    },
    {
      name: 'memory_reflect',
      description: 'Returns top 10 most-accessed memories and top 10 highest-importance memories — a "what I know well" summary.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'memory_save': {
        const metadata: MemoryMetadata | undefined = args?.metadata as MemoryMetadata | undefined;
        const memory = await engine.save({
          content: args?.content as string,
          type: (args?.type as MemoryType) ?? 'semantic',
          importance: (args?.importance as number) ?? 0.5,
          tags: (args?.tags as string[]) ?? [],
          source: 'mcp',
          metadata,
        });
        return {
          content: [{ type: 'text', text: `Saved memory ${memory.id} (${memory.type}, importance: ${memory.importance})` }],
        };
      }

      case 'memory_search': {
        const results = await engine.search({
          query: args?.query as string,
          limit: (args?.limit as number) ?? 5,
          type: args?.type as MemoryType | undefined,
          project: args?.project as string | undefined,
        });

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No relevant memories found.' }] };
        }

        const text = results.map(r =>
          `[${r.score.toFixed(3)}] (${r.memory.type}) ${r.memory.content}` +
          (r.memory.tags.length ? ` [tags: ${r.memory.tags.join(', ')}]` : '') +
          (r.memory.metadata?.project ? ` [project: ${r.memory.metadata.project}]` : '') +
          ` (id: ${r.memory.id})`
        ).join('\n');

        return { content: [{ type: 'text', text }] };
      }

      case 'memory_context': {
        const stats = await engine.stats();
        const lines = [
          `Total memories: ${stats.totalMemories}`,
          ...Object.entries(stats.byType).sort((a, b) => b[1] - a[1]).map(([t, c]) => `  ${t}: ${c}`),
          `DB size: ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`,
          stats.oldestMemory ? `Oldest: ${stats.oldestMemory}` : null,
          stats.newestMemory ? `Newest: ${stats.newestMemory}` : null,
        ].filter(Boolean).join('\n');

        return { content: [{ type: 'text', text: lines }] };
      }

      case 'memory_forget': {
        const deleted = await engine.delete(args?.id as string);
        return {
          content: [{ type: 'text', text: deleted ? `Deleted memory ${args?.id}` : `Memory not found: ${args?.id}` }],
        };
      }

      case 'memory_reflect': {
        const { mostAccessed, highestImportance } = await engine.reflect();

        const formatMemory = (m: any) => `  [${m.type}] (imp: ${m.importance}, accessed: ${m.accessCount}x) ${m.content.slice(0, 120)}`;

        const text = [
          '## Most Accessed Memories (what I recall often)',
          ...mostAccessed.map(formatMemory),
          '',
          '## Highest Importance Memories (what matters most)',
          ...highestImportance.map(formatMemory),
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
