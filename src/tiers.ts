/**
 * L0/L1/L2 Tiered Context Generation
 *
 * Generates compact memory abstracts without LLM calls:
 *   L0 (~100 tokens / ≤400 chars): first sentence + key technical terms
 *   L1 (~500 tokens / ≤2000 chars): first paragraph + structure headers
 *   L2: full original content (stored as `content`)
 *
 * Purely extractive — fast, zero API cost.
 */

/** Regex for technical/domain terms worth surfacing in L0 */
const TECH_TERM_RE = /\b(?:[A-Z][a-zA-Z]{2,}(?:\.[a-zA-Z]+)*|[a-z]+(?:DB|AI|ML|API|CLI|SDK|URL|LLM|RAG|MCP|SST|CDK|SQS|SNS|RDS|EC2|S3|VPC|IAM))\b/g;

/**
 * Extract key terms from content that aren't already in the first sentence.
 * Returns at most `maxTerms` unique terms.
 */
function extractKeyTerms(content: string, alreadyIn: string, maxTerms = 10): string[] {
  const found = new Set<string>();
  const lower = alreadyIn.toLowerCase();
  let match: RegExpExecArray | null;
  const re = new RegExp(TECH_TERM_RE.source, 'g');
  while ((match = re.exec(content)) !== null) {
    const term = match[0];
    if (!lower.includes(term.toLowerCase())) found.add(term);
    if (found.size >= maxTerms) break;
  }
  return [...found];
}

/** Split content into sentences (handles .!? and newlines) */
function firstSentence(text: string): string {
  const m = text.match(/^[^.!?\n]+(?:[.!?]|$)/);
  return (m ? m[0] : text.slice(0, 200)).trim();
}

/** First paragraph (double-newline delimited, else first 2000 chars) */
function firstParagraph(text: string): string {
  const idx = text.search(/\n\n+/);
  return (idx > 0 ? text.slice(0, idx) : text).slice(0, 2000).trim();
}

/**
 * Generate L0 and L1 tier strings from raw content.
 *
 * @param content  Full memory content (L2)
 * @returns { l0, l1 } — both are non-empty strings
 */
export function generateTiers(content: string): { l0: string; l1: string } {
  const sentence = firstSentence(content);
  const keyTerms = extractKeyTerms(content, sentence);
  const l0 = (sentence + (keyTerms.length ? ` [${keyTerms.join(', ')}]` : '')).slice(0, 400);

  const l1 = firstParagraph(content);

  return { l0, l1 };
}

/**
 * Select the appropriate content string for a given depth level.
 *
 * @param memory  Row with content, l0_content, l1_content fields
 * @param depth   0 = L0, 1 = L1, 2 = L2 (full)
 */
export function contentAtDepth(
  content: string,
  l0Content: string | undefined,
  l1Content: string | undefined,
  depth: 0 | 1 | 2,
): string {
  if (depth === 0) return l0Content && l0Content.length > 0 ? l0Content : content.slice(0, 400);
  if (depth === 1) return l1Content && l1Content.length > 0 ? l1Content : content.slice(0, 2000);
  return content;
}
