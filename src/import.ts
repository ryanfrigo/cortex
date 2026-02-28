import { readFileSync } from 'fs';
import type { MemoryInput, MemoryType } from './types.js';

interface ParsedMemory {
  input: MemoryInput;
}

// High-signal extraction patterns
const HIGH_SIGNAL_PATTERNS: { pattern: RegExp; type: MemoryType; importance: number }[] = [
  { pattern: /^Decision:\s*(.+)/i, type: 'decision', importance: 0.9 },
  { pattern: /^Decided:\s*(.+)/i, type: 'decision', importance: 0.9 },
  { pattern: /^Lesson:\s*(.+)/i, type: 'lesson', importance: 0.85 },
  { pattern: /^Learned:\s*(.+)/i, type: 'lesson', importance: 0.85 },
  { pattern: /^Key:\s*(.+)/i, type: 'fact', importance: 0.8 },
  { pattern: /^Important:\s*(.+)/i, type: 'fact', importance: 0.8 },
  { pattern: /^Bug:\s*(.+)/i, type: 'lesson', importance: 0.75 },
  { pattern: /^Fix:\s*(.+)/i, type: 'lesson', importance: 0.75 },
  { pattern: /^Shipped:\s*(.+)/i, type: 'fact', importance: 0.7 },
  { pattern: /^Preference:\s*(.+)/i, type: 'preference', importance: 0.7 },
  { pattern: /^Prefers?:\s*(.+)/i, type: 'preference', importance: 0.7 },
];

export function extractHighSignalMemories(content: string, source: string): ParsedMemory[] {
  const memories: ParsedMemory[] = [];
  const lines = content.split('\n');
  const usedLines = new Set<number>();

  // First pass: extract high-signal lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^[-*]\s+/, '').trim();
    if (!line) continue;

    for (const { pattern, type, importance } of HIGH_SIGNAL_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        memories.push({
          input: {
            content: match[1].trim(),
            type,
            importance,
            source,
            tags: ['high-signal'],
          },
        });
        usedLines.add(i);
        break;
      }
    }
  }

  // Second pass: fall back to standard parsing for remaining content, lower importance
  const remainingLines = lines.filter((_, i) => !usedLines.has(i));
  const remainingContent = remainingLines.join('\n');
  const fallback = parseMarkdown(remainingContent, source);
  for (const m of fallback) {
    m.input.importance = Math.min(m.input.importance ?? 0.3, 0.3);
  }

  return [...memories, ...fallback];
}

export function parseMarkdownFile(filePath: string): ParsedMemory[] {
  const content = readFileSync(filePath, 'utf-8');
  return parseMarkdown(content, filePath);
}

export function parseMarkdownFileSmart(filePath: string): ParsedMemory[] {
  const content = readFileSync(filePath, 'utf-8');
  return extractHighSignalMemories(content, filePath);
}

export function parseMarkdown(content: string, source: string = 'import'): ParsedMemory[] {
  const memories: ParsedMemory[] = [];
  const lines = content.split('\n');

  let currentSection = '';
  let currentType: MemoryType = 'semantic';
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) {
      const tags: string[] = [];
      if (currentSection) tags.push(currentSection.toLowerCase().replace(/\s+/g, '-'));

      memories.push({
        input: {
          content: text,
          type: currentType,
          importance: inferImportance(text),
          source,
          tags,
        },
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    // H1/H2 headers mark sections
    const h1Match = line.match(/^#\s+(.+)/);
    const h2Match = line.match(/^##\s+(.+)/);

    if (h1Match || h2Match) {
      flush();
      currentSection = (h1Match?.[1] ?? h2Match?.[1] ?? '').trim();
      currentType = inferType(currentSection);
      continue;
    }

    // Bullet points become individual memories
    const bulletMatch = line.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      flush();
      buffer.push(bulletMatch[1].trim());
      continue;
    }

    // Skip empty lines between items (flush)
    if (line.trim() === '' && buffer.length > 0) {
      flush();
      continue;
    }

    if (line.trim()) {
      buffer.push(line.trim());
    }
  }

  flush();
  return memories;
}

function inferType(section: string): MemoryType {
  const lower = section.toLowerCase();
  if (lower.includes('procedure') || lower.includes('how to') || lower.includes('workflow') || lower.includes('process')) {
    return 'procedural';
  }
  if (lower.includes('event') || lower.includes('log') || lower.includes('history') || lower.includes('episode')) {
    return 'episodic';
  }
  if (lower.includes('decision')) return 'decision';
  if (lower.includes('lesson') || lower.includes('learned')) return 'lesson';
  if (lower.includes('preference') || lower.includes('likes') || lower.includes('dislikes')) return 'preference';
  if (lower.includes('fact') || lower.includes('reference')) return 'fact';
  if (lower.includes('project') || lower.includes('state') || lower.includes('status')) return 'project-state';
  if (lower.includes('person') || lower.includes('people') || lower.includes('team')) return 'person';
  return 'semantic';
}

function inferImportance(text: string): number {
  const lower = text.toLowerCase();
  if (lower.includes('always') || lower.includes('never') || lower.includes('important') || lower.includes('critical')) {
    return 0.8;
  }
  if (lower.includes('prefer') || lower.includes('like') || lower.includes('dislike') || lower.includes('hate')) {
    return 0.7;
  }
  return 0.5;
}
