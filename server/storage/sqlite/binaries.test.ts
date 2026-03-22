import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { SyncMetadata } from '../../../src/entities/sync/types';

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'yejingram-binaries-sqlite-'));
process.env.DATA_DIR = testRoot;
process.env.SERVER_STORAGE_BACKEND = 'sqlite';

const [{ default: app, DATA_DIR, BIN_DIR, SQLITE_DB_PATH, stateCache }, storageIndex] = await Promise.all([
    import('../../index.ts'),
    import('../../storage/index.ts'),
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

async function seedSyncState(clientId: string, metadata: SyncMetadata): Promise<void> {
    const storage = getStorage();
    await storage.sync.writeMetadata(clientId, metadata);
    await storage.sync.writeSnapshot(clientId, JSON.stringify({ count: 0 }), metadata.snapshotSeq);
}

beforeEach(async () => {
    await resetEnvironment();
});

after(async () => {
    resetStorageForTests();
    stateCache.clear();
    await rm(testRoot, { recursive: true, force: true });
});

test('sqlite binary endpoints preserve payload bytes and MIME type', async () => {
    const clientId = 'sqlite-binary-client';
    const storageKey = 'room/asset-1';
    const payload = Buffer.from([0, 1, 2, 127, 128, 255]);

    await withServer(async baseUrl => {
        const putResponse = await fetch(`${baseUrl}/${clientId}/binaries/${encodeURIComponent(storageKey)}`, {
            method: 'PUT',
            headers: { 'content-type': 'image/webp' },
            body: payload,
        });

        assert.equal(putResponse.status, 200);
        assert.deepEqual(await putResponse.json(), { ok: true });

        const getResponse = await fetch(`${baseUrl}/${clientId}/binaries/${encodeURIComponent(storageKey)}`);
        assert.equal(getResponse.status, 200);
        assert.equal(getResponse.headers.get('content-type'), 'image/webp');

        const downloaded = Buffer.from(await getResponse.arrayBuffer());
        assert.deepEqual(downloaded, payload);

        const deleteResponse = await fetch(`${baseUrl}/${clientId}/binaries/${encodeURIComponent(storageKey)}`, {
            method: 'DELETE',
        });
        assert.equal(deleteResponse.status, 200);
        assert.deepEqual(await deleteResponse.json(), { ok: true });

        const missingResponse = await fetch(`${baseUrl}/${clientId}/binaries/${encodeURIComponent(storageKey)}`);
        assert.equal(missingResponse.status, 404);
    });
});

test('snapshot reset clears all binaries for client in sqlite storage path', async () => {
    const clientId = 'sqlite-binary-reset-client';
    const otherClientId = 'sqlite-binary-other-client';
    await seedSyncState(clientId, { snapshotSeq: 5, patchSeq: 7, version: 1 });

    const storage = getStorage();
    await storage.binaries.put(clientId, 'room/a', 'image/png', Buffer.from('a'));
    await storage.binaries.put(clientId, 'room/b', 'image/jpeg', Buffer.from('b'));
    await storage.binaries.put(otherClientId, 'room/c', 'image/gif', Buffer.from('c'));

    await withServer(async baseUrl => {
        const formData = new FormData();
        formData.set('snapshot', JSON.stringify({ count: 99 }));
        formData.set('version', '2');

        const response = await fetch(`${baseUrl}/${clientId}/snapshot`, {
            method: 'POST',
            body: formData,
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { snapshotSeq: 0, patchSeq: 0 });
    });

    assert.equal(await storage.binaries.get(clientId, 'room/a'), null);
    assert.equal(await storage.binaries.get(clientId, 'room/b'), null);
    const otherClientBinary = await storage.binaries.get(otherClientId, 'room/c');
    assert.ok(otherClientBinary);
    assert.equal(Buffer.from(otherClientBinary.data).toString('utf8'), 'c');
});
