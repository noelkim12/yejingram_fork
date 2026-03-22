import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { SqliteStorageAdapter } from './adapter';
import type { LLMRequest } from '../../types';
import type { Patch, SyncMetadata } from '../../../src/entities/sync/types';

async function withTempSqliteAdapter(
    run: (adapter: SqliteStorageAdapter, dbPath: string) => Promise<void>,
): Promise<void> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yejingram-sqlite-'));
    const dbPath = path.join(tempDir, 'test.db');
    const adapter = new SqliteStorageAdapter({ databasePath: dbPath });

    try {
        await adapter.init();
        await run(adapter, dbPath);
    } finally {
        adapter.close();
        await rm(tempDir, { recursive: true, force: true });
    }
}

test('sqlite schema init is idempotent', async () => {
    await withTempSqliteAdapter(async adapter => {
        await adapter.init();

        const metadata: SyncMetadata = {
            snapshotSeq: 0,
            patchSeq: 0,
            version: 1,
        };

        await adapter.sync.writeMetadata('client-a', metadata);
        const loaded = await adapter.sync.readMetadata('client-a');

        assert.deepEqual(loaded, metadata);
    });
});

test('sqlite adapter provides storage CRUD smoke coverage', async () => {
    await withTempSqliteAdapter(async adapter => {
        const clientId = 'client-smoke';
        const metadata: SyncMetadata = {
            snapshotSeq: 0,
            patchSeq: 1,
            version: 7,
        };
        const patch: Patch = {
            id: 'patch-1',
            seq: 0,
            baseSnapshotSeq: 0,
            timestamp: Date.now(),
            diff: [],
        };

        await adapter.sync.writeMetadata(clientId, metadata);
        await adapter.sync.writeSnapshot(clientId, JSON.stringify({ rooms: [] }), metadata.snapshotSeq);
        await adapter.sync.appendPatch(clientId, patch);

        const state = await adapter.sync.readState(clientId);
        assert.ok(state);
        assert.deepEqual(state?.metadata, metadata);
        assert.equal(state?.patches.length, 1);
        assert.equal(state?.patches[0]?.seq, 0);

        await adapter.sync.resetPatchLog(clientId);
        assert.deepEqual(await adapter.sync.readPatchLog(clientId), []);

        const request: LLMRequest = {
            id: 'req-1',
            clientId,
            roomId: 'room-a',
            userMessages: [],
            status: 'pending',
            createdAt: new Date().toISOString(),
        };

        await adapter.queue.enqueue(request);
        const pending = await adapter.queue.getPending();
        assert.equal(pending.length, 1);

        await adapter.queue.update({
            ...request,
            status: 'completed',
            completedAt: new Date().toISOString(),
        });
        const completed = await adapter.queue.findRequestById(request.id);
        assert.equal(completed?.status, 'completed');

        await adapter.queue.delete(request.id);
        assert.equal(await adapter.queue.findRequestById(request.id), null);

        const subscription = {
            endpoint: 'https://example.com/endpoint',
            keys: { p256dh: 'abc', auth: 'def' },
        };
        await adapter.pushSubscriptions.save(clientId, subscription);
        assert.deepEqual(await adapter.pushSubscriptions.read(clientId), subscription);
        const allSubscriptions = await adapter.pushSubscriptions.readAll();
        assert.deepEqual(allSubscriptions[clientId], subscription);
        assert.equal(await adapter.pushSubscriptions.delete(clientId), true);
        assert.equal(await adapter.pushSubscriptions.read(clientId), null);

        const binaryData = new TextEncoder().encode('binary-data');
        await adapter.binaries.put(clientId, 'avatars/a', 'image/png', binaryData);
        const binary = await adapter.binaries.get(clientId, 'avatars/a');
        assert.ok(binary);
        assert.equal(binary?.mimeType, 'image/png');
        assert.equal(new TextDecoder().decode(binary?.data), 'binary-data');

        await adapter.binaries.delete(clientId, 'avatars/a');
        assert.equal(await adapter.binaries.get(clientId, 'avatars/a'), null);

        await adapter.binaries.put(clientId, 'avatars/b', 'image/png', binaryData);
        await adapter.binaries.clearClient(clientId);
        assert.equal(await adapter.binaries.get(clientId, 'avatars/b'), null);
    });
});
