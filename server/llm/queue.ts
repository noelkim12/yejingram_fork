import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { DATA_DIR } from '../index';
import type { LLMRequest, LLMRequestQueue, LLMRequestStatus } from '../types';

function getRequestsDir() {
    return path.join(DATA_DIR, 'requests');
}

const clientLocks = new Map<string, Promise<void>>();

export async function acquireClientLock(clientId: string): Promise<() => void> {
    let releaseLock: () => void;
    const currentLock = clientLocks.get(clientId) || Promise.resolve();
    const newLock = new Promise<void>(resolve => {
        releaseLock = resolve;
    });
    clientLocks.set(clientId, currentLock.then(() => newLock));
    await currentLock;
    return releaseLock!;
}

export class LLMRequestQueueImpl implements LLMRequestQueue {
    private requestsDir: string;
    private inMemoryRequests: Map<string, LLMRequest> = new Map();

    constructor() {
        this.requestsDir = '';
    }

    private getRequestsDir(): string {
        if (!this.requestsDir) this.requestsDir = getRequestsDir();
        return this.requestsDir;
    }

    private getClientDir(clientId: string): string {
        return path.join(this.getRequestsDir(), clientId);
    }

    private getFilePath(clientId: string, requestId: string): string {
        return path.join(this.getClientDir(clientId), `${requestId}.json`);
    }

    async enqueue(request: LLMRequest): Promise<void> {
        const normalizedRequest = request.id ? request : { ...request, id: nanoid() };
        const clientDir = this.getClientDir(normalizedRequest.clientId);
        await fs.promises.mkdir(clientDir, { recursive: true });
        const filePath = this.getFilePath(normalizedRequest.clientId, normalizedRequest.id);
        await fs.promises.writeFile(filePath, JSON.stringify(normalizedRequest, null, 2));
        this.inMemoryRequests.set(normalizedRequest.id, normalizedRequest);
    }

    async dequeue(clientId: string): Promise<LLMRequest | null> {
        const clientDir = this.getClientDir(clientId);
        try {
            const files = await fs.promises.readdir(clientDir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const request = await this.readRequest(path.join(clientDir, file));
                if (request && request.status === 'pending') {
                    this.inMemoryRequests.set(request.id, request);
                    return request;
                }
            }
        } catch (err: any) {
            if (err.code !== 'ENOENT') throw err;
        }
        return null;
    }

    async markProcessing(requestId: string): Promise<void> {
        await this.updateStatus(requestId, 'processing');
    }

    async markCompleted(requestId: string): Promise<void> {
        await this.updateStatus(requestId, 'completed', new Date().toISOString());
        setTimeout(() => {
            void this.cleanup(requestId);
        }, 5 * 60 * 1000);
    }

    async markFailed(requestId: string, error: string): Promise<void> {
        await this.updateStatus(requestId, 'failed', undefined, error);
    }

    async getPending(): Promise<LLMRequest[]> {
        const pending: LLMRequest[] = [];
        try {
            const clientDirs = await fs.promises.readdir(this.getRequestsDir());
            for (const clientId of clientDirs) {
                const requests = await this.getByClientId(clientId);
                pending.push(...requests.filter(r => r.status === 'pending'));
            }
        } catch (err: any) {
            if (err.code !== 'ENOENT') throw err;
        }
        return pending;
    }

    async getByClientId(clientId: string): Promise<LLMRequest[]> {
        const requests: LLMRequest[] = [];
        const clientDir = this.getClientDir(clientId);
        try {
            const files = await fs.promises.readdir(clientDir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const request = await this.readRequest(path.join(clientDir, file));
                if (request) {
                    requests.push(request);
                    this.inMemoryRequests.set(request.id, request);
                }
            }
        } catch (err: any) {
            if (err.code !== 'ENOENT') throw err;
        }
        return requests;
    }

    async recoverPendingRequests(): Promise<void> {
        try {
            const clientDirs = await fs.promises.readdir(this.getRequestsDir());
            for (const clientId of clientDirs) {
                const clientDir = this.getClientDir(clientId);
                const files = await fs.promises.readdir(clientDir);
                for (const file of files) {
                    if (!file.endsWith('.json')) continue;
                    const request = await this.readRequest(path.join(clientDir, file));
                    if (!request) continue;
                    this.inMemoryRequests.set(request.id, request);
                    if (request.status === 'processing') {
                        await this.updateStatus(request.id, 'pending');
                    }
                }
            }
        } catch (err: any) {
            if (err.code !== 'ENOENT') throw err;
        }
    }

    async acquireClientLock(clientId: string): Promise<() => void> {
        return acquireClientLock(clientId);
    }

    private async readRequest(filePath: string): Promise<LLMRequest | null> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return JSON.parse(content) as LLMRequest;
        } catch (err: any) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    }

    private async updateStatus(
        requestId: string,
        status: LLMRequestStatus,
        completedAt?: string,
        error?: string
    ): Promise<void> {
        const request = this.inMemoryRequests.get(requestId) || await this.findRequestById(requestId);
        if (!request) return;

        request.status = status;
        if (completedAt) request.completedAt = completedAt;
        if (error) request.error = error;
        if (!error && status !== 'failed') delete request.error;

        const filePath = this.getFilePath(request.clientId, requestId);
        await fs.promises.writeFile(filePath, JSON.stringify(request, null, 2));
        this.inMemoryRequests.set(requestId, request);
    }

    private async findRequestById(requestId: string): Promise<LLMRequest | null> {
        try {
            const clientDirs = await fs.promises.readdir(this.getRequestsDir());
            for (const clientId of clientDirs) {
                const filePath = this.getFilePath(clientId, requestId);
                const request = await this.readRequest(filePath);
                if (request) return request;
            }
        } catch (err: any) {
            if (err.code !== 'ENOENT') throw err;
        }
        return null;
    }

    private async cleanup(requestId: string): Promise<void> {
        const request = this.inMemoryRequests.get(requestId) || await this.findRequestById(requestId);
        if (!request) return;

        const filePath = this.getFilePath(request.clientId, requestId);
        try {
            await fs.promises.unlink(filePath);
            this.inMemoryRequests.delete(requestId);
        } catch (err: any) {
            if (err.code !== 'ENOENT') console.error('Failed to cleanup request:', err);
        }
    }
}

export const queue = new LLMRequestQueueImpl();
export default queue;
