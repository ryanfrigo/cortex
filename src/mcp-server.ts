import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryEngine } from './engine.js';
import type { MemoryType } from './types.js';

const engine = new MemoryEngine();

const server = new Server(
  { name: 'cortex-memory', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_save',
      description: 'Save a new memory. Use this to remember facts, preferences, procedures, or events for later recall.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'The memory content to save' },
          type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'], description: 'Memory type. semantic=facts/knowledge, episodic=events/experiences, procedural=how-to/processes' },
          importance: { type: 'number', description: 'Importance from 0.0 to 1.0 (default 0.5)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
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
          type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'], description: 'Filter by memory type' },
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'memory_save': {
        const memory = await engine.save({
          content: args?.content as string,
          type: (args?.type as MemoryType) ?? 'semantic',
          importance: (args?.importance as number) ?? 0.5,
          tags: (args?.tags as string[]) ?? [],
          source: 'mcp',
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
        });

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No relevant memories found.' }] };
        }

        const text = results.map(r =>
          `[${r.score.toFixed(3)}] (${r.memory.type}) ${r.memory.content}` +
          (r.memory.tags.length ? ` [tags: ${r.memory.tags.join(', ')}]` : '') +
          ` (id: ${r.memory.id})`
        ).join('\n');

        return { content: [{ type: 'text', text }] };
      }

      case 'memory_context': {
        const stats = await engine.stats();
        const text = [
          `Total memories: ${stats.totalMemories}`,
          `  Episodic: ${stats.byType.episodic}`,
          `  Semantic: ${stats.byType.semantic}`,
          `  Procedural: ${stats.byType.procedural}`,
          `DB size: ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`,
          stats.oldestMemory ? `Oldest: ${stats.oldestMemory}` : null,
          stats.newestMemory ? `Newest: ${stats.newestMemory}` : null,
        ].filter(Boolean).join('\n');

        return { content: [{ type: 'text', text }] };
      }

      case 'memory_forget': {
        const deleted = await engine.delete(args?.id as string);
        return {
          content: [{ type: 'text', text: deleted ? `Deleted memory ${args?.id}` : `Memory not found: ${args?.id}` }],
        };
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
