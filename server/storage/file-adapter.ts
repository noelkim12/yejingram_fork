import fsp from 'fs/promises';
import path from 'path';
import { nanoid } from 'nanoid';
import type { LLMRequest, LLMRequestStatus } from '../types';
import type {
    BinaryRecord,
    BinaryStorage,
    PushSubscriptionStorage,
    QueueStorage,
    StorageAdapter,
    SyncStorage,
} from './types';
import type { Patch, ServerState, SyncMetadata } from '../../src/entities/sync/types';

function toBase64Url(input: string): string {
    return Buffer.from(input, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

interface FileStorageAdapterOptions {
    dataDir: string;
    binaryDir: string;
}

class FileSyncStorage implements SyncStorage {
    constructor(
        private readonly dataDir: string,
        private readonly binaryDir: string,
    ) { }

    private metadataPath(clientId: string): string {
        return path.join(this.dataDir, `${clientId}.metadata.json`);
    }

    private snapshotPath(clientId: string): string {
        return path.join(this.dataDir, `${clientId}.snapshot.json`);
    }

    private patchLogPath(clientId: string): string {
        return path.join(this.dataDir, `${clientId}.patches.log`);
    }

    private clientBinaryDir(clientId: string): string {
        return path.join(this.binaryDir, clientId);
    }

    async readMetadata(clientId: string): Promise<SyncMetadata | null> {
        try {
            const raw = await fsp.readFile(this.metadataPath(clientId), 'utf-8');
            return JSON.parse(raw) as SyncMetadata;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    async writeMetadata(clientId: string, metadata: SyncMetadata): Promise<void> {
        await fsp.writeFile(this.metadataPath(clientId), JSON.stringify(metadata, null, 2));
    }

    async readSnapshot(clientId: string): Promise<string | null> {
        try {
            return await fsp.readFile(this.snapshotPath(clientId), 'utf-8');
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    async writeSnapshot(clientId: string, snapshot: string, _snapshotSeq: number): Promise<void> {
        await fsp.writeFile(this.snapshotPath(clientId), snapshot);
    }

    async readPatchLog(clientId: string): Promise<Patch[]> {
        try {
            const log = await fsp.readFile(this.patchLogPath(clientId), 'utf-8');
            return log
                .split('\n')
                .filter(Boolean)
                .map(line => JSON.parse(line) as Patch);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    async appendPatch(clientId: string, patch: Patch): Promise<void> {
        await fsp.appendFile(this.patchLogPath(clientId), `${JSON.stringify(patch)}\n`);
    }

    async resetPatchLog(clientId: string): Promise<void> {
        const file = this.patchLogPath(clientId);
        try {
            await fsp.truncate(file, 0);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                await fsp.writeFile(file, '');
                return;
            }
            throw error;
        }
    }

    async commitPatch(clientId: string, patch: Patch, metadata: SyncMetadata): Promise<void> {
        await this.appendPatch(clientId, patch);
        await this.writeMetadata(clientId, metadata);
    }

    async replaceState(
        clientId: string,
        payload: {
            snapshot: string;
            metadata: SyncMetadata;
            clearBinaries?: boolean;
        },
    ): Promise<void> {
        await this.writeSnapshot(clientId, payload.snapshot, payload.metadata.snapshotSeq);
        await this.writeMetadata(clientId, payload.metadata);
        await this.resetPatchLog(clientId);

        if (payload.clearBinaries) {
            await fsp.rm(this.clientBinaryDir(clientId), { recursive: true, force: true });
            await fsp.mkdir(this.clientBinaryDir(clientId), { recursive: true });
        }
    }

    async readState(clientId: string): Promise<ServerState | null> {
        const metadata = await this.readMetadata(clientId);
        if (!metadata) {
            return null;
        }

        return {
            metadata,
            patches: await this.readPatchLog(clientId),
        };
    }
}

class FileQueueStorage implements QueueStorage {
    private readonly inMemoryRequests = new Map<string, LLMRequest>();
    private readonly clientLocks = new Map<string, Promise<void>>();

    constructor(private readonly dataDir: string) { }

    private getRequestsDir(): string {
        return path.join(this.dataDir, 'requests');
    }

    private getClientDir(clientId: string): string {
        return path.join(this.getRequestsDir(), clientId);
    }

    private getFilePath(clientId: string, requestId: string): string {
        return path.join(this.getClientDir(clientId), `${requestId}.json`);
    }

    private async readRequest(filePath: string): Promise<LLMRequest | null> {
        try {
            const content = await fsp.readFile(filePath, 'utf-8');
            return JSON.parse(content) as LLMRequest;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    private async findRequestByIdInternal(requestId: string): Promise<LLMRequest | null> {
        try {
            const clientDirs = await fsp.readdir(this.getRequestsDir());
            for (const clientId of clientDirs) {
                const request = await this.readRequest(this.getFilePath(clientId, requestId));
                if (request) {
                    return request;
                }
            }
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }

        return null;
    }

    async enqueue(request: LLMRequest): Promise<void> {
        const normalizedRequest = request.id ? request : { ...request, id: nanoid() };
        const clientDir = this.getClientDir(normalizedRequest.clientId);
        await fsp.mkdir(clientDir, { recursive: true });
        const filePath = this.getFilePath(normalizedRequest.clientId, normalizedRequest.id);
        await fsp.writeFile(filePath, JSON.stringify(normalizedRequest, null, 2));
        this.inMemoryRequests.set(normalizedRequest.id, normalizedRequest);
    }

    async getPending(): Promise<LLMRequest[]> {
        const pending: LLMRequest[] = [];
        try {
            const clientDirs = await fsp.readdir(this.getRequestsDir());
            for (const clientId of clientDirs) {
                const requests = await this.getByClientId(clientId);
                pending.push(...requests.filter(request => request.status === 'pending'));
            }
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }

        return pending;
    }

    async dequeuePendingByClient(clientId: string): Promise<LLMRequest | null> {
        const requests = await this.getByClientId(clientId);
        const pending = requests
            .filter(request => request.status === 'pending')
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        return pending[0] ?? null;
    }

    async recoverProcessingToPending(): Promise<void> {
        try {
            const clientDirs = await fsp.readdir(this.getRequestsDir());
            for (const clientId of clientDirs) {
                const clientDir = this.getClientDir(clientId);
                const files = await fsp.readdir(clientDir);
                for (const file of files) {
                    if (!file.endsWith('.json')) {
                        continue;
                    }

                    const request = await this.readRequest(path.join(clientDir, file));
                    if (!request) {
                        continue;
                    }

                    this.inMemoryRequests.set(request.id, request);
                    if (request.status === 'processing') {
                        await this.updateStatus(request.id, 'pending');
                    }
                }
            }
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    async getByClientId(clientId: string): Promise<LLMRequest[]> {
        const requests: LLMRequest[] = [];
        const clientDir = this.getClientDir(clientId);
        try {
            const files = await fsp.readdir(clientDir);
            for (const file of files) {
                if (!file.endsWith('.json')) {
                    continue;
                }

                const request = await this.readRequest(path.join(clientDir, file));
                if (!request) {
                    continue;
                }

                requests.push(request);
                this.inMemoryRequests.set(request.id, request);
            }
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }

        return requests;
    }

    async update(request: LLMRequest): Promise<void> {
        const filePath = this.getFilePath(request.clientId, request.id);
        await fsp.mkdir(this.getClientDir(request.clientId), { recursive: true });
        await fsp.writeFile(filePath, JSON.stringify(request, null, 2));
        this.inMemoryRequests.set(request.id, request);
    }

    async updateStatus(
        requestId: string,
        status: LLMRequestStatus,
        completedAt?: string,
        error?: string,
    ): Promise<void> {
        const request = this.inMemoryRequests.get(requestId) ?? await this.findRequestByIdInternal(requestId);
        if (!request) {
            return;
        }

        request.status = status;
        if (completedAt) {
            request.completedAt = completedAt;
        }
        if (error) {
            request.error = error;
        }
        if (!error && status !== 'failed') {
            delete request.error;
        }

        await this.update(request);
    }

    async delete(requestId: string): Promise<void> {
        const request = this.inMemoryRequests.get(requestId) ?? await this.findRequestByIdInternal(requestId);
        if (!request) {
            return;
        }

        const filePath = this.getFilePath(request.clientId, requestId);
        try {
            await fsp.unlink(filePath);
            this.inMemoryRequests.delete(requestId);
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    async recoverPendingRequests(): Promise<void> {
        await this.recoverProcessingToPending();
    }

    async acquireClientLock(clientId: string): Promise<() => void> {
        let releaseLock: (() => void) | undefined;
        const currentLock = this.clientLocks.get(clientId) ?? Promise.resolve();
        const newLock = new Promise<void>(resolve => {
            releaseLock = resolve;
        });
        this.clientLocks.set(clientId, currentLock.then(() => newLock));
        await currentLock;

        if (!releaseLock) {
            throw new Error('Failed to create lock release function');
        }

        return releaseLock;
    }

    async findRequestById(requestId: string): Promise<LLMRequest | null> {
        return this.findRequestByIdInternal(requestId);
    }
}

class FilePushSubscriptionStorage implements PushSubscriptionStorage {
    constructor(private readonly dataDir: string) { }

    private filePath(clientId: string): string {
        return path.join(this.dataDir, `${clientId}.json`);
    }

    async read(clientId: string): Promise<Record<string, unknown> | null> {
        try {
            const json = await fsp.readFile(this.filePath(clientId), 'utf-8');
            return JSON.parse(json) as Record<string, unknown>;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    async readAll(): Promise<Record<string, Record<string, unknown>>> {
        await fsp.mkdir(this.dataDir, { recursive: true });
        const entries = await fsp.readdir(this.dataDir, { withFileTypes: true });
        const subscriptions: Record<string, Record<string, unknown>> = {};

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) {
                continue;
            }

            try {
                const json = await fsp.readFile(path.join(this.dataDir, entry.name), 'utf-8');
                subscriptions[entry.name.replace('.json', '')] = JSON.parse(json) as Record<string, unknown>;
            } catch {
                continue;
            }
        }

        return subscriptions;
    }

    async save(clientId: string, subscription: Record<string, unknown>): Promise<void> {
        await fsp.mkdir(this.dataDir, { recursive: true });
        await fsp.writeFile(this.filePath(clientId), JSON.stringify(subscription, null, 2));
    }

    async delete(clientId: string): Promise<boolean> {
        try {
            await fsp.unlink(this.filePath(clientId));
            return true;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }
}

class FileBinaryStorage implements BinaryStorage {
    constructor(private readonly binaryDir: string) { }

    private clientDir(clientId: string): string {
        return path.join(this.binaryDir, clientId);
    }

    private binaryDataPath(clientId: string, storageKey: string): string {
        return path.join(this.clientDir(clientId), `${toBase64Url(storageKey)}.bin`);
    }

    private binaryMetaPath(clientId: string, storageKey: string): string {
        return path.join(this.clientDir(clientId), `${toBase64Url(storageKey)}.meta.json`);
    }

    async put(clientId: string, storageKey: string, mimeType: string, data: Uint8Array): Promise<void> {
        await fsp.mkdir(this.clientDir(clientId), { recursive: true });
        await fsp.writeFile(this.binaryDataPath(clientId, storageKey), Buffer.from(data));
        await fsp.writeFile(
            this.binaryMetaPath(clientId, storageKey),
            JSON.stringify({ storageKey, mimeType }, null, 2),
        );
    }

    async get(clientId: string, storageKey: string): Promise<BinaryRecord | null> {
        try {
            const [buffer, stats] = await Promise.all([
                fsp.readFile(this.binaryDataPath(clientId, storageKey)),
                fsp.stat(this.binaryDataPath(clientId, storageKey)),
            ]);
            let mimeType = 'application/octet-stream';

            try {
                const metaRaw = await fsp.readFile(this.binaryMetaPath(clientId, storageKey), 'utf-8');
                const parsed = JSON.parse(metaRaw) as { mimeType?: string };
                if (parsed.mimeType) {
                    mimeType = parsed.mimeType;
                }
            } catch {
            }

            return {
                storageKey,
                mimeType,
                data: new Uint8Array(buffer),
                updatedAt: stats.mtimeMs,
            };
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    async delete(clientId: string, storageKey: string): Promise<void> {
        try {
            await fsp.unlink(this.binaryDataPath(clientId, storageKey));
        } catch {
        }

        try {
            await fsp.unlink(this.binaryMetaPath(clientId, storageKey));
        } catch {
        }
    }

    async clearClient(clientId: string): Promise<void> {
        const dir = this.clientDir(clientId);
        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.mkdir(dir, { recursive: true });
    }
}

export class FileStorageAdapter implements StorageAdapter {
    readonly backend = 'file' as const;
    readonly sync: SyncStorage;
    readonly queue: QueueStorage;
    readonly pushSubscriptions: PushSubscriptionStorage;
    readonly binaries: BinaryStorage;

    constructor(private readonly options: FileStorageAdapterOptions) {
        this.sync = new FileSyncStorage(options.dataDir, options.binaryDir);
        this.queue = new FileQueueStorage(options.dataDir);
        this.pushSubscriptions = new FilePushSubscriptionStorage(options.dataDir);
        this.binaries = new FileBinaryStorage(options.binaryDir);
    }

    async init(): Promise<void> {
        await fsp.mkdir(this.options.dataDir, { recursive: true });
        await fsp.mkdir(this.options.binaryDir, { recursive: true });
    }

    close(): void {
        return;
    }
}
