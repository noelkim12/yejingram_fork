import { nanoid } from 'nanoid';
import { getStorage } from '../storage';
import type { LLMRequest, LLMRequestQueue, LLMRequestStatus } from '../types';

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
    private inMemoryRequests: Map<string, LLMRequest> = new Map();

    constructor() {
        return;
    }

    async enqueue(request: LLMRequest): Promise<void> {
        const normalizedRequest = request.id ? request : { ...request, id: nanoid() };
        await getStorage().queue.enqueue(normalizedRequest);
        this.inMemoryRequests.set(normalizedRequest.id, normalizedRequest);
    }

    async dequeue(clientId: string): Promise<LLMRequest | null> {
        const request = await getStorage().queue.dequeuePendingByClient(clientId);
        if (request) {
            this.inMemoryRequests.set(request.id, request);
        }
        return request;
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
        const pending = await getStorage().queue.getPending();
        for (const request of pending) {
            this.inMemoryRequests.set(request.id, request);
        }
        return pending;
    }

    async getByClientId(clientId: string): Promise<LLMRequest[]> {
        const requests = await getStorage().queue.getByClientId(clientId);
        for (const request of requests) {
            this.inMemoryRequests.set(request.id, request);
        }
        return requests;
    }

    async recoverPendingRequests(): Promise<void> {
        await getStorage().queue.recoverProcessingToPending();
    }

    async acquireClientLock(clientId: string): Promise<() => void> {
        return acquireClientLock(clientId);
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

        await getStorage().queue.update(request);
        this.inMemoryRequests.set(requestId, request);
    }

    private async findRequestById(requestId: string): Promise<LLMRequest | null> {
        return getStorage().queue.findRequestById(requestId);
    }

    private async cleanup(requestId: string): Promise<void> {
        const request = this.inMemoryRequests.get(requestId) || await this.findRequestById(requestId);
        if (!request) return;

        try {
            await getStorage().queue.delete(requestId);
            this.inMemoryRequests.delete(requestId);
        } catch (err) {
            console.error('Failed to cleanup request:', err);
        }
    }
}

export const queue = new LLMRequestQueueImpl();
export default queue;
