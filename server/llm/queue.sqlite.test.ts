import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import type { Message } from '../../src/entities/message/types';
import { initializeStorage, getStorage, resetStorageForTests } from '../storage';
import { LLMRequestQueueImpl } from './queue';
import type { LLMRequest } from '../types';

async function withSqliteQueue(run: (queue: LLMRequestQueueImpl, clientId: string) => Promise<void>): Promise<void> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yejingram-queue-sqlite-'));
    const dataDir = path.join(tempDir, 'data');
    const binaryDir = path.join(dataDir, 'binaries');
    const sqlitePath = path.join(dataDir, 'yejingram.db');

    resetStorageForTests();

    try {
        await initializeStorage({
            backend: 'sqlite',
            dataDir,
            binaryDir,
            sqlitePath,
        });

        const queue = new LLMRequestQueueImpl();
        const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await run(queue, clientId);
    } finally {
        resetStorageForTests();
        await rm(tempDir, { recursive: true, force: true });
    }
}

function createRequest(clientId: string, id: string, createdAt: string, status: LLMRequest['status'] = 'pending'): LLMRequest {
    const userMessages: Message[] = [{
        id: `msg-${id}`,
        roomId: 'room-a',
        authorId: 1,
        createdAt,
        type: 'TEXT',
        content: `content-${id}`,
    }];

    return {
        id,
        clientId,
        roomId: 'room-a',
        userMessages,
        status,
        createdAt,
    };
}

test('queue preserves oldest-first dequeue order per client and persists full payload', async () => {
    await withSqliteQueue(async (queue, clientId) => {
        const newer = createRequest(clientId, 'req-newer', '2026-01-02T00:00:00.000Z');
        const older = createRequest(clientId, 'req-older', '2026-01-01T00:00:00.000Z');

        await queue.enqueue(newer);
        await queue.enqueue(older);

        const first = await queue.dequeue(clientId);
        assert.equal(first?.id, 'req-older');

        await queue.markProcessing('req-newer');
        const persisted = await getStorage().queue.findRequestById('req-newer');
        assert.equal(persisted?.status, 'processing');
        assert.deepEqual(persisted?.userMessages, newer.userMessages);
    });
});

test('queue recovery moves processing requests back to pending', async () => {
    await withSqliteQueue(async (queue, clientId) => {
        await getStorage().queue.enqueue(createRequest(clientId, 'req-processing', '2026-01-01T00:00:00.000Z', 'processing'));
        await getStorage().queue.enqueue(createRequest(clientId, 'req-pending', '2026-01-01T01:00:00.000Z', 'pending'));

        await queue.recoverPendingRequests();

        const requests = await queue.getByClientId(clientId);
        const byId = new Map(requests.map(request => [request.id, request]));

        assert.equal(byId.get('req-processing')?.status, 'pending');
        assert.equal(byId.get('req-pending')?.status, 'pending');
    });
});

test('queue status transitions persist and completed requests are cleaned up', async () => {
    await withSqliteQueue(async (queue, clientId) => {
        await queue.enqueue(createRequest(clientId, 'req-status', '2026-01-01T00:00:00.000Z'));

        await queue.markProcessing('req-status');
        const processing = await getStorage().queue.findRequestById('req-status');
        assert.equal(processing?.status, 'processing');

        let scheduledDelayMs = -1;
        const originalSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
            scheduledDelayMs = Number(timeout);
            return originalSetTimeout(() => {
                if (typeof handler === 'function') {
                    handler(...args);
                }
            }, 0);
        }) as unknown) as typeof setTimeout;

        try {
            await queue.markCompleted('req-status');
        } finally {
            globalThis.setTimeout = originalSetTimeout;
        }

        assert.equal(scheduledDelayMs, 5 * 60 * 1000);

        await new Promise(resolve => originalSetTimeout(resolve, 5));
        const removed = await getStorage().queue.findRequestById('req-status');
        assert.equal(removed, null);
    });
});
