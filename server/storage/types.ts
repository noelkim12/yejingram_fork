import type { Patch, ServerState, SyncMetadata } from '../../src/entities/sync/types';
import type { LLMRequest } from '../types';

export type StorageBackend = 'file' | 'sqlite';

export interface BinaryRecord {
    storageKey: string;
    mimeType: string;
    data: Uint8Array;
    updatedAt: number;
}

export interface SyncStorage {
    readMetadata(clientId: string): Promise<SyncMetadata | null>;
    writeMetadata(clientId: string, metadata: SyncMetadata): Promise<void>;
    readSnapshot(clientId: string): Promise<string | null>;
    writeSnapshot(clientId: string, snapshot: string, snapshotSeq: number): Promise<void>;
    readPatchLog(clientId: string): Promise<Patch[]>;
    appendPatch(clientId: string, patch: Patch): Promise<void>;
    resetPatchLog(clientId: string): Promise<void>;
    commitPatch(clientId: string, patch: Patch, metadata: SyncMetadata): Promise<void>;
    replaceState(
        clientId: string,
        payload: {
            snapshot: string;
            metadata: SyncMetadata;
            clearBinaries?: boolean;
        },
    ): Promise<void>;
    readState(clientId: string): Promise<ServerState | null>;
}

export interface QueueStorage {
    enqueue(request: LLMRequest): Promise<void>;
    dequeuePendingByClient(clientId: string): Promise<LLMRequest | null>;
    recoverProcessingToPending(): Promise<void>;
    getPending(): Promise<LLMRequest[]>;
    getByClientId(clientId: string): Promise<LLMRequest[]>;
    findRequestById(requestId: string): Promise<LLMRequest | null>;
    update(request: LLMRequest): Promise<void>;
    delete(requestId: string): Promise<void>;
}

export interface PushSubscriptionStorage {
    read(clientId: string): Promise<Record<string, unknown> | null>;
    readAll(): Promise<Record<string, Record<string, unknown>>>;
    save(clientId: string, subscription: Record<string, unknown>): Promise<void>;
    delete(clientId: string): Promise<boolean>;
}

export interface BinaryStorage {
    put(clientId: string, storageKey: string, mimeType: string, data: Uint8Array): Promise<void>;
    get(clientId: string, storageKey: string): Promise<BinaryRecord | null>;
    delete(clientId: string, storageKey: string): Promise<void>;
    clearClient(clientId: string): Promise<void>;
}

export interface StorageAdapter {
    readonly backend: StorageBackend;
    readonly sync: SyncStorage;
    readonly queue: QueueStorage;
    readonly pushSubscriptions: PushSubscriptionStorage;
    readonly binaries: BinaryStorage;
    init(): Promise<void>;
    close(): void;
}

export interface CreateStorageAdapterOptions {
    backend: StorageBackend;
    dataDir: string;
    binaryDir: string;
    sqlitePath: string;
}
