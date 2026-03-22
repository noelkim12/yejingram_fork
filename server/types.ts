// Re-export relevant types from src
export type { Message } from '../src/entities/message/types';
export type { Room } from '../src/entities/room/types';
export type { ServerState, SyncMetadata, Patch } from '../src/entities/sync/types';

// LLM Request status type
export type LLMRequestStatus = 'pending' | 'processing' | 'completed' | 'failed';

// LLM Request interface for queue
export interface LLMRequest {
  id: string;                    // Unique request ID (nanoid)
  clientId: string;              // Client identifier
  roomId: string;                // Room to send message to
  userMessages: Message[];       // User messages that triggered this request
  status: LLMRequestStatus;      // Current status
  createdAt: string;             // ISO timestamp
  completedAt?: string;          // ISO timestamp when completed
  error?: string;                // Error message if failed
}

// LLM Request Queue interface
export interface LLMRequestQueue {
  enqueue(request: LLMRequest): Promise<void>;
  dequeue(clientId: string): Promise<LLMRequest | null>;
  markProcessing(requestId: string): Promise<void>;
  markCompleted(requestId: string): Promise<void>;
  markFailed(requestId: string, error: string): Promise<void>;
  getPending(): Promise<LLMRequest[]>;
  getByClientId(clientId: string): Promise<LLMRequest[]>;
  recoverPendingRequests(): Promise<void>;
  acquireClientLock(clientId: string): Promise<() => void>;
}

// Unified Server Configuration
export interface UnifiedServerConfig {
  port: number;
  dataDir: string;
  binDir: string;
  syncEnabled: boolean;
  proactiveEnabled: boolean;
  llmProxyEnabled: boolean;
}
