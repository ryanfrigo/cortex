import { readFileSync } from 'fs';
import type { MemoryInput, MemoryType } from './types.js';

interface ParsedMemory {
  input: MemoryInput;
}

export function parseMarkdownFile(filePath: string): ParsedMemory[] {
  const content = readFileSync(filePath, 'utf-8');
  return parseMarkdown(content, filePath);
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
  return 'semantic';
}

function inferImportance(text: string): number {
  const lower = text.toLowerCase();
  // Higher importance for strong preference/identity signals
  if (lower.includes('always') || lower.includes('never') || lower.includes('important') || lower.includes('critical')) {
    return 0.8;
  }
  if (lower.includes('prefer') || lower.includes('like') || lower.includes('dislike') || lower.includes('hate')) {
    return 0.7;
  }
  return 0.5;
}
