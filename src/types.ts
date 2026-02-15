export type MemoryType = 'episodic' | 'semantic' | 'procedural';

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
}

export interface MemoryInput {
  content: string;
  type?: MemoryType;
  importance?: number;
  source?: string;
  tags?: string[];
}

export interface SearchOptions {
  query: string;
  limit?: number;
  type?: MemoryType;
  tags?: string[];
  minImportance?: number;
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
  byType: Record<MemoryType, number>;
  dbSizeBytes: number;
  oldestMemory: string | null;
  newestMemory: string | null;
}
