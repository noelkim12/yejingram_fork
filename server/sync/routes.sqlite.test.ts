import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { once } from 'events';
import type { AddressInfo } from 'net';

import type { Patch, SyncMetadata } from '../../src/entities/sync/types';

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'yejingram-sync-sqlite-'));
process.env.DATA_DIR = testRoot;
process.env.SERVER_STORAGE_BACKEND = 'sqlite';

const [{ default: app, DATA_DIR, BIN_DIR, SQLITE_DB_PATH, stateCache }, storageIndex] = await Promise.all([
    import('../index.ts'),
    import('../storage/index.ts'),
]);

const { getStorage, initializeStorage, resetStorageForTests } = storageIndex;

async function resetEnvironment(): Promise<void> {
    resetStorageForTests();
    stateCache.clear();
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(BIN_DIR, { recursive: true });
    await initializeStorage({
        backend: 'sqlite',
        dataDir: DATA_DIR,
        binaryDir: BIN_DIR,
        sqlitePath: SQLITE_DB_PATH,
    });
}

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
    const server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/api`;

    try {
        return await run(baseUrl);
    } finally {
        await new Promise<void>(resolve => {
            server.close(() => resolve());
        });
    }
}

function buildPatch(seq: number, baseSnapshotSeq = 0, extra: Partial<Patch> = {}): Patch {
    return {
        id: `patch-${seq}`,
        seq,
        baseSnapshotSeq,
        timestamp: Date.now() + seq,
        diff: [{ op: 'replace', path: '/count', value: seq + 1 }],
        ...extra,
    } as Patch;
}

async function seedSyncState(clientId: string, metadata: SyncMetadata, patches: Patch[] = []): Promise<void> {
    const storage = getStorage();
    await storage.sync.writeMetadata(clientId, metadata);
    await storage.sync.writeSnapshot(clientId, JSON.stringify({ count: 0 }), metadata.snapshotSeq);
    await storage.sync.resetPatchLog(clientId);

    for (const patch of patches) {
        await storage.sync.appendPatch(clientId, patch);
    }
}

beforeEach(async () => {
    await resetEnvironment();
});

after(async () => {
    resetStorageForTests();
    stateCache.clear();
    await rm(testRoot, { recursive: true, force: true });
});

test('sync/check returns 410 on snapshot mismatch and 409 on patch mismatch', async () => {
    const clientId = 'sqlite-sync-check-client';
    await seedSyncState(clientId, { snapshotSeq: 0, patchSeq: 0, version: 1 });

    await withServer(async baseUrl => {
        const snapshotMismatchResponse = await fetch(`${baseUrl}/${clientId}/sync/check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildPatch(0, 1)),
        });
        assert.equal(snapshotMismatchResponse.status, 410);

        const patchMismatchResponse = await fetch(`${baseUrl}/${clientId}/sync/check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildPatch(1, 0)),
        });
        assert.equal(patchMismatchResponse.status, 409);
        const body = await patchMismatchResponse.json() as { seq?: number };
        assert.equal(body.seq, 0);
    });
});

test('sync push deletes binary keys from patch.binary.del and persists sequence', async () => {
    const clientId = 'sqlite-sync-binary-delete-client';
    const storageKey = 'room/asset-1';
    await seedSyncState(clientId, { snapshotSeq: 0, patchSeq: 0, version: 1 });

    const storage = getStorage();
    await storage.binaries.put(clientId, storageKey, 'application/octet-stream', Buffer.from('payload'));

    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/${clientId}/sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildPatch(0, 0, { binary: { del: [storageKey] } })),
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { snapshotSeq: 0, patchSeq: 1 });
    });

    const updatedMetadata = await storage.sync.readMetadata(clientId);
    assert.equal(updatedMetadata?.patchSeq, 1);
    assert.equal((await storage.sync.readPatchLog(clientId)).length, 1);
    assert.equal(await storage.binaries.get(clientId, storageKey), null);
});

test('sync push compacts into snapshot at 100 patches', async () => {
    const clientId = 'sqlite-sync-compaction-client';
    const existingPatches = Array.from({ length: 99 }, (_, index) => buildPatch(index));
    await seedSyncState(clientId, { snapshotSeq: 0, patchSeq: 99, version: 1 }, existingPatches);

    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/${clientId}/sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildPatch(99)),
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { snapshotSeq: 1, patchSeq: 0 });
    });

    const storage = getStorage();
    const metadata = await storage.sync.readMetadata(clientId);
    const compactedSnapshot = await storage.sync.readSnapshot(clientId);
    const remainingPatches = await storage.sync.readPatchLog(clientId);

    assert.deepEqual(metadata, { snapshotSeq: 1, patchSeq: 0, version: 1 });
    assert.equal(remainingPatches.length, 0);
    assert.equal(compactedSnapshot ? (JSON.parse(compactedSnapshot) as { count: number }).count : -1, 100);
});

test('snapshot upload resets sync state and clears binaries', async () => {
    const clientId = 'sqlite-snapshot-reset-client';
    const storageKey = 'room/asset-reset';
    await seedSyncState(clientId, { snapshotSeq: 3, patchSeq: 5, version: 1 }, [buildPatch(0, 3)]);

    const storage = getStorage();
    await storage.sync.writeSnapshot(clientId, JSON.stringify({ count: 999 }), 3);
    await storage.binaries.put(clientId, storageKey, 'image/png', Buffer.from('binary-before-reset'));

    await withServer(async baseUrl => {
        const formData = new FormData();
        formData.set('snapshot', JSON.stringify({ count: 42 }));
        formData.set('version', '2');

        const response = await fetch(`${baseUrl}/${clientId}/snapshot`, {
            method: 'POST',
            body: formData,
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { snapshotSeq: 0, patchSeq: 0 });

        const snapshotResponse = await fetch(`${baseUrl}/${clientId}/snapshot`);
        assert.equal(snapshotResponse.status, 200);
        assert.equal((await snapshotResponse.json() as { count: number }).count, 42);
    });

    const metadata = await storage.sync.readMetadata(clientId);
    const currentSnapshot = await storage.sync.readSnapshot(clientId);
    const patches = await storage.sync.readPatchLog(clientId);
    assert.deepEqual(metadata, { snapshotSeq: 0, patchSeq: 0, version: 2 });
    assert.equal(currentSnapshot ? (JSON.parse(currentSnapshot) as { count: number }).count : -1, 42);
    assert.equal(patches.length, 0);
    assert.equal(await storage.binaries.get(clientId, storageKey), null);
});

test('concurrent same-seq sync pushes accept only one patch', async () => {
    const clientId = 'sqlite-sync-concurrency-client';
    await seedSyncState(clientId, { snapshotSeq: 0, patchSeq: 0, version: 1 });

    await withServer(async baseUrl => {
        const [first, second] = await Promise.all([
            fetch(`${baseUrl}/${clientId}/sync`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(buildPatch(0, 0, { id: 'dup-0-a' })),
            }),
            fetch(`${baseUrl}/${clientId}/sync`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(buildPatch(0, 0, { id: 'dup-0-b' })),
            }),
        ]);

        const statuses = [first.status, second.status].sort((a, b) => a - b);
        assert.deepEqual(statuses, [200, 409]);
    });

    const storage = getStorage();
    const metadata = await storage.sync.readMetadata(clientId);
    const patches = await storage.sync.readPatchLog(clientId);
    assert.equal(metadata?.patchSeq, 1);
    assert.equal(patches.length, 1);
});
