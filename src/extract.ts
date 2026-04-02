/**
 * Auto-Session Extraction
 * Parses conversation transcripts and extracts structured memories:
 *   - Key facts      → semantic
 *   - Decisions      → belief
 *   - Lessons        → reflection
 *   - People         → semantic in user/people/
 *
 * Zero external API dependencies — pure regex/heuristic extraction.
 */

import type { MemoryInput, MemoryType } from './types.js';

export interface ExtractedMemory {
  input: MemoryInput;
  reason: string; // Why this was extracted
}

/** Common English first names for people detection */
const COMMON_NAMES = new Set([
  'john', 'jane', 'michael', 'sarah', 'david', 'emily', 'james',
  'olivia', 'robert', 'emma', 'william', 'ava', 'joseph', 'isabella',
  'charles', 'mia', 'thomas', 'sophia', 'christopher', 'charlotte',
  'daniel', 'amelia', 'matthew', 'harper', 'anthony', 'evelyn', 'mark',
  'abigail', 'donald', 'emily', 'steven', 'elizabeth', 'paul', 'mila',
  'andrew', 'ella', 'joshua', 'avery', 'kenneth', 'sofia', 'kevin',
  'camila', 'brian', 'aria', 'george', 'scarlett', 'timothy', 'victoria',
  'ron', 'bob', 'alice', 'carol', 'sam', 'alex', 'pat', 'chris', 'jordan',
  'taylor', 'morgan', 'casey', 'riley', 'jesse', 'jamie', 'robin',
]);

/** Patterns that signal a DECISION */
const DECISION_PATTERNS = [
  /\b(decided|decision:|we decided|i decided|going to|will use|chose|choosing|picked|selected|agreed to|resolved to)\b/i,
  /\b(the plan is|our approach|we'll|we will|i'll|i will|let's go with|sticking with)\b/i,
  /\b(pivoting to|switching to|moving forward with|committing to)\b/i,
];

/** Patterns that signal a LESSON / REFLECTION */
const LESSON_PATTERNS = [
  /\b(lesson:|learned|learning:|realized|insight:|takeaway:|key takeaway)\b/i,
  /\b(mistake:|error:|gotcha:|gotcha|watch out|don't forget|remember to|note to self)\b/i,
  /\b(discovered that|turns out|found out|it turns out|it seems that)\b/i,
  /\b(next time|in the future|should have|could have|would have|i wish)\b/i,
];

/** Patterns that signal a KEY FACT */
const FACT_PATTERNS = [
  /\b(is|are|was|were|has|have|had)\b.{5,100}$/i,
  /\b(api key|token|url|endpoint|version|config|setting|value|port|path)\b/i,
  /\b(works|working|fixed|solved|resolved|confirmed|verified)\b/i,
  /\b(stack:|tech:|using:|built with:|powered by:)\b/i,
];

/** Pattern for detecting person mentions */
const PERSON_MENTION_PATTERNS = [
  // "talked to [Name]", "meeting with [Name]"
  /\b(?:talked? (?:to|with)|spoke (?:to|with)|meeting (?:with|from)|email (?:from|to)|message (?:from|to)|mentioned by|introduced by|hired|fired)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/,
  // "[Name] said|told|mentioned|asked|replied"
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:said|told|mentioned|asked|replied|confirmed|agreed|disagreed|suggested|recommended)\b/,
  // Capitalised name followed by role
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:is|was|joined|left|started|works|worked)\b/,
];

/** Lines/sections to skip (meta-noise) */
const SKIP_PATTERNS = [
  /^(you:|me:|user:|assistant:|human:|ai:|system:|claude:)\s*/i,
  /^[>\-*#]+\s*/,         // markdown list/heading prefixes
  /^```/,                  // code block delimiters
  /^https?:\/\//,          // bare URLs
  /^\s*$/,                 // empty lines
];

function cleanLine(line: string): string {
  // Remove common speaker prefixes like "[User] "
  return line
    .replace(/^\[?(?:User|Human|Assistant|AI|Claude)\]?:\s*/i, '')
    .replace(/^[>\-*#]+\s*/, '')
    .trim();
}

function shouldSkipLine(line: string): boolean {
  return SKIP_PATTERNS.some(p => p.test(line));
}

/** Split text into logical segments (sentences / paragraphs / list items) */
function segmentText(text: string): string[] {
  const lines = text.split('\n');
  const segments: string[] = [];

  for (const line of lines) {
    const cleaned = cleanLine(line);
    if (!cleaned || cleaned.length < 15) continue;
    if (shouldSkipLine(line)) continue;

    // Split long paragraphs into sentences
    if (cleaned.length > 300) {
      const sentences = cleaned.match(/[^.!?]+[.!?]+/g) ?? [cleaned];
      segments.push(...sentences.map(s => s.trim()).filter(s => s.length >= 15));
    } else {
      segments.push(cleaned);
    }
  }

  return segments;
}

/** Check if a segment matches decision patterns */
function isDecision(segment: string): boolean {
  return DECISION_PATTERNS.some(p => p.test(segment));
}

/** Check if a segment matches lesson patterns */
function isLesson(segment: string): boolean {
  return LESSON_PATTERNS.some(p => p.test(segment));
}

/** Check if a segment looks like a notable fact */
function isFact(segment: string): boolean {
  return FACT_PATTERNS.some(p => p.test(segment));
}

/** Extract person names from a segment */
function extractPersonMentions(segment: string): string[] {
  const names: string[] = [];
  for (const pattern of PERSON_MENTION_PATTERNS) {
    const match = segment.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      // Filter out common non-name words that get capitalised
      const lower = name.toLowerCase();
      if (lower !== 'the' && lower !== 'it' && lower !== 'this' && lower !== 'that' && name.length > 2) {
        names.push(name);
      }
    }
  }

  // Also check common names explicitly
  const words = segment.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (COMMON_NAMES.has(clean) && word[0] === word[0].toUpperCase()) {
      const capitalised = word.replace(/[^a-zA-Z]/, '');
      if (capitalised.length > 2 && !names.includes(capitalised)) {
        names.push(capitalised);
      }
    }
  }

  return [...new Set(names)];
}

/** Deduplicate extracted memories by content similarity (simple word overlap) */
function deduplicateMemories(memories: ExtractedMemory[]): ExtractedMemory[] {
  const deduped: ExtractedMemory[] = [];
  const seen: string[] = [];

  for (const m of memories) {
    const words = new Set(m.input.content.toLowerCase().split(/\W+/).filter(w => w.length > 4));
    const isDuplicate = seen.some(s => {
      const seenWords = new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 4));
      let overlap = 0;
      for (const w of words) {
        if (seenWords.has(w)) overlap++;
      }
      const minLen = Math.min(words.size, seenWords.size);
      return minLen > 0 && overlap / minLen > 0.7;
    });

    if (!isDuplicate) {
      deduped.push(m);
      seen.push(m.input.content);
    }
  }
  return deduped;
}

/**
 * Extract structured memories from a conversation transcript.
 *
 * @param transcript  Raw text of the conversation
 * @param namespace   Target namespace prefix (e.g. "projects/myapp")
 * @returns Array of MemoryInput objects ready to save
 */
export function extractFromTranscript(transcript: string, namespace = 'general'): ExtractedMemory[] {
  const segments = segmentText(transcript);
  const results: ExtractedMemory[] = [];
  const seenPeople = new Set<string>();

  for (const segment of segments) {
    // --- People detection (highest priority, run on every segment) ---
    const people = extractPersonMentions(segment);
    for (const person of people) {
      if (!seenPeople.has(person.toLowerCase())) {
        seenPeople.add(person.toLowerCase());
        results.push({
          input: {
            content: `Person mentioned in conversation: ${person}. Context: "${segment.slice(0, 150)}"`,
            namespace: 'user/people',
            type: 'semantic',
            importance: 0.6,
            source: 'extract',
            tags: ['person', person.toLowerCase()],
          },
          reason: `Person "${person}" detected in segment`,
        });
      }
    }

    // --- Decision detection ---
    if (isDecision(segment)) {
      results.push({
        input: {
          content: segment,
          namespace,
          type: 'belief',
          importance: 0.8,
          source: 'extract',
          tags: ['decision', 'extracted'],
        },
        reason: 'Decision pattern detected',
      });
      continue; // Don't double-classify
    }

    // --- Lesson detection ---
    if (isLesson(segment)) {
      results.push({
        input: {
          content: segment,
          namespace,
          type: 'reflection',
          importance: 0.75,
          source: 'extract',
          tags: ['lesson', 'extracted'],
        },
        reason: 'Lesson/insight pattern detected',
      });
      continue;
    }

    // --- Fact detection ---
    if (isFact(segment) && segment.length >= 30) {
      results.push({
        input: {
          content: segment,
          namespace,
          type: 'semantic',
          importance: 0.6,
          source: 'extract',
          tags: ['fact', 'extracted'],
        },
        reason: 'Key fact detected',
      });
    }
  }

  return deduplicateMemories(results);
}
