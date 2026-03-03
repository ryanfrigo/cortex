export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'decision' | 'lesson' | 'fact' | 'preference' | 'project-state' | 'person' | 'session';

export interface MemoryMetadata {
  project?: string;      // e.g. "myapp", "kalshi", "market"
  confidence?: number;   // 0-1, how verified is this
  supersedes?: string;   // ID of memory this replaces
  expiresAt?: string;    // ISO 8601, for time-bound facts
}

export interface Memory {
  id: string;
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
  type?: MemoryType;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: MemoryMetadata;
}

export interface SearchOptions {
  query: string;
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
  dbSizeBytes: number;
  oldestMemory: string | null;
  newestMemory: string | null;
}
