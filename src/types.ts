export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'decision' | 'lesson' | 'fact' | 'preference' | 'project-state' | 'person' | 'session' | 'belief' | 'reflection' | 'shadow';

export interface MemoryMetadata {
  project?: string;      // e.g. "voicecharm", "kalshi", "clawmart"
  confidence?: number;   // 0-1, how verified is this
  supersedes?: string;   // ID of memory this replaces
  supersededIds?: string[]; // IDs of memories this consolidation replaces
  expiresAt?: string;    // ISO 8601, for time-bound facts
  // Session ingestion metadata
  files?: string[];       // File paths referenced
  urls?: string[];        // URLs referenced
  commits?: string[];     // Git commit hashes
  deployed?: boolean;     // Whether deployment was involved
  isSummary?: boolean;    // Session summary memory
  exchangeCount?: number; // Number of exchanges in session
}

export interface BeliefMetadata extends MemoryMetadata {
  confidence: number;           // 0.0-1.0
  domain: string;               // 'ryan' | 'projects' | 'self' | 'world'
  evidence_for?: string[];      // memory IDs supporting this belief
  evidence_against?: string[];  // memory IDs contradicting this belief
  last_challenged?: string;     // ISO date
  times_confirmed?: number;
  times_refuted?: number;
  status?: 'active' | 'refuted' | 'confirmed' | 'retired';
  history?: Array<{ date: string; confidence: number; reason: string }>;
}

export interface Memory {
  id: string;
  namespace: string;    // brain region: health, projects/*, personal, daily, learnings, people
  type: MemoryType;
  content: string;
  embedding: Float32Array | null;
  importance: number; // 0.0 - 1.0
  source: string;
  tags: string[];
  createdAt: string; // ISO 8601
  updatedAt: string;
  accessedAt: string;
  accessCount: number;
  metadata?: MemoryMetadata;
}

export interface MemoryInput {
  content: string;
  namespace?: string;
  type?: MemoryType;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: MemoryMetadata;
}

export interface SearchOptions {
  query: string;
  namespace?: string;
  limit?: number;
  type?: MemoryType;
  tags?: string[];
  minImportance?: number;
  project?: string;
}

export interface SearchResult {
  memory: Memory;
  score: number;
  vectorScore: number;
  bm25Score: number;
  recencyScore: number;
  importanceScore: number;
}

export interface MemoryStats {
  totalMemories: number;
  byType: Record<string, number>;
  byNamespace: Record<string, number>;
  dbSizeBytes: number;
  oldestMemory: string | null;
  newestMemory: string | null;
}
