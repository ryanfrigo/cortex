/**
 * Extractive summarization for L0/L1 tiers.
 * Zero dependencies — pure text extraction, no LLM required.
 *
 * L0 (~100 tokens / ~75 words): First sentence + key noun phrases
 * L1 (~500 tokens / ~375 words): First paragraph + structured overview
 */

/** Split text into sentences using basic punctuation rules */
function splitSentences(text: string): string[] {
  // Split on . ! ? followed by whitespace or end-of-string
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'\u2018\u2019\u201C])|(?<=[.!?])$/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** Split text into paragraphs */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').trim())
    .filter(p => p.length > 10);
}

/** Extract key noun/verb phrases using simple frequency analysis */
function extractKeyTerms(text: string, maxTerms = 8): string[] {
  // Common English stop words
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
    'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me',
    'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
    'what', 'which', 'who', 'how', 'when', 'where', 'why', 'not', 'no',
    'so', 'if', 'as', 'up', 'out', 'about', 'into', 'through', 'during',
    'also', 'just', 'more', 'than', 'then', 'now', 'very', 'too', 'all',
  ]);

  // Extract words, normalize
  const words = text
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w) && /^[a-z]/.test(w));

  // Count frequency
  const freq: Record<string, number> = {};
  for (const w of words) {
    freq[w] = (freq[w] ?? 0) + 1;
  }

  // Also capture capitalised phrases (proper nouns, acronyms) from original text
  const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
  const acronyms = text.match(/\b[A-Z]{2,}\b/g) ?? [];
  const specials = [...properNouns, ...acronyms].map(t => t.toLowerCase());
  for (const s of specials) {
    freq[s] = (freq[s] ?? 0) + 2; // Boost proper nouns / acronyms
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term]) => term);
}

/**
 * Generate L0 summary (~100 tokens).
 * Returns: first sentence + top key terms as tags.
 */
export function generateL0(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return '';

  const sentences = splitSentences(trimmed);
  const firstSentence = sentences[0] ?? trimmed.slice(0, 200);

  // Truncate first sentence if very long
  const shortFirst = firstSentence.length > 300
    ? firstSentence.slice(0, 297) + '...'
    : firstSentence;

  // Extract key terms from full content (not just first sentence)
  const keyTerms = extractKeyTerms(trimmed, 6);

  if (keyTerms.length === 0) return shortFirst;

  // Only append terms that aren't already in the sentence
  const sentenceLower = shortFirst.toLowerCase();
  const newTerms = keyTerms.filter(t => !sentenceLower.includes(t));

  if (newTerms.length === 0) return shortFirst;
  return `${shortFirst} [${newTerms.join(', ')}]`;
}

/**
 * Generate L1 summary (~500 tokens).
 * Returns: first paragraph + section headings + important sentences.
 */
export function generateL1(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return '';

  // If content is already short enough, return as-is
  if (trimmed.split(/\s+/).length <= 375) return trimmed;

  const paragraphs = splitParagraphs(trimmed);
  const parts: string[] = [];

  // Always include first paragraph
  if (paragraphs.length > 0) {
    parts.push(paragraphs[0]);
  }

  // Extract any markdown headings
  const headings = trimmed.match(/^#{1,3}\s+.+$/gm) ?? [];
  if (headings.length > 0) {
    parts.push('\n' + headings.join('\n'));
  }

  // Extract "important" sentences: those with decision/lesson/fact markers
  const importantMarkers = [
    /\b(decided|decision|resolved|conclusion|therefore|thus)\b/i,
    /\b(learned|lesson|insight|takeaway|key finding)\b/i,
    /\b(important|critical|essential|note:|warning:)\b/i,
    /\b(result:|outcome:|conclusion:)\b/i,
  ];

  const allSentences = splitSentences(trimmed);
  const importantSentences = allSentences
    .slice(1) // Skip first sentence (already in first paragraph)
    .filter(s => importantMarkers.some(re => re.test(s)))
    .slice(0, 5);

  if (importantSentences.length > 0) {
    parts.push('\nKey points: ' + importantSentences.join(' '));
  }

  // Add second paragraph if we're still short
  const joined = parts.join('\n');
  const wordCount = joined.split(/\s+/).length;
  if (wordCount < 200 && paragraphs.length > 1) {
    parts.splice(1, 0, paragraphs[1]);
  }

  const result = parts.join('\n').trim();

  // Final truncation to ~500 tokens (375 words)
  const words = result.split(/\s+/);
  if (words.length > 375) {
    return words.slice(0, 375).join(' ') + '...';
  }
  return result;
}
