import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { SqliteStorageAdapter } from '../storage/sqlite/adapter';
import { migrateJsonToSqlite } from './migrate-json-to-sqlite';
import { verifySqliteMigration } from './verify-sqlite-migration';
import { exportSqliteToJson } from './export-sqlite-to-json';
import type { Patch, SyncMetadata } from '../../src/entities/sync/types';
import type { LLMRequest } from '../types';

function toBase64Url(input: string): string {
    return Buffer.from(input, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

async function writeLegacyClientData(
    dataDir: string,
    clientId: string,
    payload: {
        metadata: SyncMetadata;
        snapshot: Record<string, unknown>;
        patches: Patch[];
        subscription?: Record<string, unknown>;
        binaries?: Array<{ storageKey: string; mimeType: string; bytes: Uint8Array }>;
        requests?: LLMRequest[];
    },
): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, `${clientId}.metadata.json`), JSON.stringify(payload.metadata, null, 2));
    await writeFile(path.join(dataDir, `${clientId}.snapshot.json`), JSON.stringify(payload.snapshot));

    const patchLog = payload.patches.map(patch => JSON.stringify(patch)).join('\n');
    await writeFile(path.join(dataDir, `${clientId}.patches.log`), patchLog.length > 0 ? `${patchLog}\n` : '');

    if (payload.subscription) {
        await writeFile(path.join(dataDir, `${clientId}.json`), JSON.stringify(payload.subscription, null, 2));
    }

    if (payload.binaries?.length) {
        const clientBinaryDir = path.join(dataDir, 'binaries', clientId);
        await rm(clientBinaryDir, { recursive: true, force: true });
        await mkdir(clientBinaryDir, { recursive: true });
        for (const binary of payload.binaries) {
            const encoded = toBase64Url(binary.storageKey);
            await writeFile(path.join(clientBinaryDir, `${encoded}.bin`), Buffer.from(binary.bytes));
            await writeFile(
                path.join(clientBinaryDir, `${encoded}.meta.json`),
                JSON.stringify({ storageKey: binary.storageKey, mimeType: binary.mimeType }, null, 2),
            );
        }
    }

    if (payload.requests?.length) {
        const requestDir = path.join(dataDir, 'requests', clientId);
        await rm(requestDir, { recursive: true, force: true });
        await mkdir(requestDir, { recursive: true });
        for (const request of payload.requests) {
            await writeFile(path.join(requestDir, `${request.id}.json`), JSON.stringify(request, null, 2));
        }
    }
}

async function withTempDirs<T>(run: (ctx: { root: string; dataDir: string; dbPath: string; exportDir: string }) => Promise<T>): Promise<T> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yejingram-migration-'));
    const dataDir = path.join(root, 'data');
    const dbPath = path.join(root, 'yejingram.db');
    const exportDir = path.join(root, 'exported-data');

    try {
        return await run({ root, dataDir, dbPath, exportDir });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('migration imports full legacy client data and verification passes', async () => {
    await withTempDirs(async ({ dataDir, dbPath }) => {
        const patch0: Patch = {
            id: 'patch-0',
            seq: 0,
            baseSnapshotSeq: 3,
            diff: [{ op: 'add', path: '/messages/0', value: { id: 1 } }],
            timestamp: 1700000000000,
        };
        const patch1: Patch = {
            id: 'patch-1',
            seq: 1,
            baseSnapshotSeq: 3,
            diff: [{ op: 'replace', path: '/settings/lang', value: 'ko' }],
            timestamp: 1700000001000,
        };

        await writeLegacyClientData(dataDir, 'beta', {
            metadata: { snapshotSeq: 3, patchSeq: 2, version: 9 },
            snapshot: { rooms: [{ id: 'r1' }], messages: [] },
            patches: [patch0, patch1],
            subscription: { endpoint: 'https://push.example/beta', keys: { p256dh: 'p', auth: 'a' } },
            binaries: [{ storageKey: 'avatars/main', mimeType: 'image/png', bytes: Buffer.from([1, 2, 3, 4]) }],
            requests: [{
                id: 'req-1',
                clientId: 'beta',
                roomId: 'room-1',
                userMessages: [],
                status: 'pending',
                createdAt: '2026-03-22T12:00:00.000Z',
            }],
        });

        await writeLegacyClientData(dataDir, 'alpha', {
            metadata: { snapshotSeq: 1, patchSeq: 0, version: 4 },
            snapshot: { rooms: [{ id: 'r0' }], messages: [] },
            patches: [],
            requests: [],
        });

        const report = await migrateJsonToSqlite({ dataDir, sqlitePath: dbPath, mode: 'skip-existing' });
        assert.deepEqual(report.clientOrder, ['alpha', 'beta']);
        assert.equal(report.migratedClientCount, 2);
        assert.equal(report.skippedClientCount, 0);

        const verify = await verifySqliteMigration({ dataDir, sqlitePath: dbPath });
        assert.equal(verify.ok, true);
        assert.equal(verify.mismatches.length, 0);

        const adapter = new SqliteStorageAdapter({ databasePath: dbPath });
        await adapter.init();
        try {
            const metadata = await adapter.sync.readMetadata('beta');
            assert.deepEqual(metadata, { snapshotSeq: 3, patchSeq: 2, version: 9 });
            const patches = await adapter.sync.readPatchLog('beta');
            assert.deepEqual(patches.map(p => p.seq), [0, 1]);
            const subscription = await adapter.pushSubscriptions.read('beta');
            assert.deepEqual(subscription, { endpoint: 'https://push.example/beta', keys: { p256dh: 'p', auth: 'a' } });
            const binary = await adapter.binaries.get('beta', 'avatars/main');
            assert.ok(binary);
            assert.equal(binary?.mimeType, 'image/png');
            assert.deepEqual(Buffer.from(binary?.data ?? []), Buffer.from([1, 2, 3, 4]));
            const requests = await adapter.queue.getByClientId('beta');
            assert.equal(requests.length, 1);
            assert.equal(requests[0]?.id, 'req-1');
        } finally {
            adapter.close();
        }
    });
});

test('skip-existing mode keeps previously migrated sqlite state', async () => {
    await withTempDirs(async ({ dataDir, dbPath }) => {
        await writeLegacyClientData(dataDir, 'client-x', {
            metadata: { snapshotSeq: 0, patchSeq: 0, version: 1 },
            snapshot: { v: 1 },
            patches: [],
        });

        await migrateJsonToSqlite({ dataDir, sqlitePath: dbPath, mode: 'skip-existing' });

        await writeLegacyClientData(dataDir, 'client-x', {
            metadata: { snapshotSeq: 99, patchSeq: 0, version: 2 },
            snapshot: { v: 2 },
            patches: [],
        });

        const report = await migrateJsonToSqlite({ dataDir, sqlitePath: dbPath, mode: 'skip-existing' });
        assert.equal(report.migratedClientCount, 0);
        assert.equal(report.skippedClientCount, 1);

        const adapter = new SqliteStorageAdapter({ databasePath: dbPath });
        await adapter.init();
        try {
            const metadata = await adapter.sync.readMetadata('client-x');
            assert.deepEqual(metadata, { snapshotSeq: 0, patchSeq: 0, version: 1 });
        } finally {
            adapter.close();
        }
    });
});

test('replace-client mode rewrites existing sqlite client data', async () => {
    await withTempDirs(async ({ dataDir, dbPath }) => {
        await writeLegacyClientData(dataDir, 'client-r', {
            metadata: { snapshotSeq: 1, patchSeq: 1, version: 1 },
            snapshot: { value: 'old' },
            patches: [{
                id: 'old-patch',
                seq: 0,
                baseSnapshotSeq: 1,
                diff: [],
                timestamp: 1700000000000,
            }],
            requests: [{
                id: 'old-req',
                clientId: 'client-r',
                roomId: 'room-1',
                userMessages: [],
                status: 'pending',
                createdAt: '2026-03-22T12:00:00.000Z',
            }],
        });

        await migrateJsonToSqlite({ dataDir, sqlitePath: dbPath, mode: 'skip-existing' });

        await writeLegacyClientData(dataDir, 'client-r', {
            metadata: { snapshotSeq: 2, patchSeq: 1, version: 2 },
            snapshot: { value: 'new' },
            patches: [{
                id: 'new-patch',
                seq: 0,
                baseSnapshotSeq: 2,
                diff: [],
                timestamp: 1700000001000,
            }],
            requests: [{
                id: 'new-req',
                clientId: 'client-r',
                roomId: 'room-2',
                userMessages: [],
                status: 'pending',
                createdAt: '2026-03-22T12:05:00.000Z',
            }],
        });

        const report = await migrateJsonToSqlite({ dataDir, sqlitePath: dbPath, mode: 'replace-client' });
        assert.equal(report.migratedClientCount, 1);

        const adapter = new SqliteStorageAdapter({ databasePath: dbPath });
        await adapter.init();
        try {
            const metadata = await adapter.sync.readMetadata('client-r');
            assert.deepEqual(metadata, { snapshotSeq: 2, patchSeq: 1, version: 2 });
            const requests = await adapter.queue.getByClientId('client-r');
            assert.equal(requests.length, 1);
            assert.equal(requests[0]?.id, 'new-req');
        } finally {
            adapter.close();
        }
    });
});

test('migration rejects non-contiguous patch sequence and export writes rollback layout', async () => {
    await withTempDirs(async ({ dataDir, dbPath, exportDir }) => {
        await writeLegacyClientData(dataDir, 'broken', {
            metadata: { snapshotSeq: 1, patchSeq: 2, version: 1 },
            snapshot: { value: 'broken' },
            patches: [{
                id: 'gap',
                seq: 1,
                baseSnapshotSeq: 1,
                diff: [],
                timestamp: 1700000000000,
            }],
        });

        await assert.rejects(
            () => migrateJsonToSqlite({ dataDir, sqlitePath: dbPath, mode: 'skip-existing' }),
            /Patch sequence continuity/,
        );

        await rm(path.join(dataDir, 'broken.metadata.json'), { force: true });
        await rm(path.join(dataDir, 'broken.snapshot.json'), { force: true });
        await rm(path.join(dataDir, 'broken.patches.log'), { force: true });

        await writeLegacyClientData(dataDir, 'restorable', {
            metadata: { snapshotSeq: 4, patchSeq: 1, version: 3 },
            snapshot: { data: 'ok' },
            patches: [{
                id: 'p0',
                seq: 0,
                baseSnapshotSeq: 4,
                diff: [],
                timestamp: 1700000000000,
            }],
            subscription: { endpoint: 'https://push.example/restore', keys: { p256dh: 'x', auth: 'y' } },
            binaries: [{ storageKey: 'icons/restore', mimeType: 'image/webp', bytes: Buffer.from([9, 8, 7]) }],
            requests: [{
                id: 'restore-req',
                clientId: 'restorable',
                roomId: 'room-x',
                userMessages: [],
                status: 'completed',
                createdAt: '2026-03-22T12:00:00.000Z',
                completedAt: '2026-03-22T12:01:00.000Z',
            }],
        });

        await migrateJsonToSqlite({ dataDir, sqlitePath: dbPath, mode: 'skip-existing' });
        const exportReport = await exportSqliteToJson({ sqlitePath: dbPath, outputDataDir: exportDir });
        assert.equal(exportReport.clientCount, 1);

        const metadataRaw = await readFile(path.join(exportDir, 'restorable.metadata.json'), 'utf8');
        assert.equal(JSON.parse(metadataRaw).snapshotSeq, 4);

        const patchLogRaw = await readFile(path.join(exportDir, 'restorable.patches.log'), 'utf8');
        const patchLines = patchLogRaw.trim().split('\n');
        assert.equal(patchLines.length, 1);

        const requestFiles = await readdir(path.join(exportDir, 'requests', 'restorable'));
        assert.deepEqual(requestFiles, ['restore-req.json']);

        const binaryDirEntries = await readdir(path.join(exportDir, 'binaries', 'restorable'));
        assert.deepEqual(binaryDirEntries.sort(), ['aWNvbnMvcmVzdG9yZQ.bin', 'aWNvbnMvcmVzdG9yZQ.meta.json']);
        const binStats = await stat(path.join(exportDir, 'binaries', 'restorable', 'aWNvbnMvcmVzdG9yZQ.bin'));
        assert.equal(binStats.size, 3);

        const verify = await verifySqliteMigration({ dataDir: exportDir, sqlitePath: dbPath });
        assert.equal(verify.ok, true);
    });
});

test('migration and export preserve push-only orphan clients', async () => {
    await withTempDirs(async ({ dataDir, dbPath, exportDir }) => {
        const pushOnly = {
            endpoint: 'https://push.example/push-only',
            keys: { p256dh: 'push-only-p', auth: 'push-only-a' },
        };
        await mkdir(dataDir, { recursive: true });
        await writeFile(path.join(dataDir, 'push-only.json'), JSON.stringify(pushOnly, null, 2));

        const report = await migrateJsonToSqlite({ dataDir, sqlitePath: dbPath, mode: 'skip-existing' });
        assert.deepEqual(report.clientOrder, ['push-only']);
        assert.equal(report.migratedClientCount, 1);

        const adapter = new SqliteStorageAdapter({ databasePath: dbPath });
        await adapter.init();
        try {
            const subscription = await adapter.pushSubscriptions.read('push-only');
            assert.deepEqual(subscription, pushOnly);
            const metadata = await adapter.sync.readMetadata('push-only');
            assert.equal(metadata, null);
        } finally {
            adapter.close();
        }

        const exportReport = await exportSqliteToJson({ sqlitePath: dbPath, outputDataDir: exportDir });
        assert.equal(exportReport.clientCount, 1);
        const exportedSubscription = JSON.parse(await readFile(path.join(exportDir, 'push-only.json'), 'utf8'));
        assert.deepEqual(exportedSubscription, pushOnly);

        const verify = await verifySqliteMigration({ dataDir: exportDir, sqlitePath: dbPath });
        assert.equal(verify.ok, true);
    });
});

test('verification reports snapshot and push-subscription mismatches', async () => {
    await withTempDirs(async ({ dataDir, dbPath }) => {
        await writeLegacyClientData(dataDir, 'verify-client', {
            metadata: { snapshotSeq: 2, patchSeq: 0, version: 1 },
            snapshot: { marker: 'original' },
            patches: [],
            subscription: { endpoint: 'https://push.example/verify', keys: { p256dh: 'orig-p', auth: 'orig-a' } },
        });

        await migrateJsonToSqlite({ dataDir, sqlitePath: dbPath, mode: 'skip-existing' });

        const adapter = new SqliteStorageAdapter({ databasePath: dbPath });
        await adapter.init();
        try {
            await adapter.sync.writeSnapshot('verify-client', JSON.stringify({ marker: 'tampered' }), 2);
            await adapter.pushSubscriptions.save('verify-client', {
                endpoint: 'https://push.example/verify',
                keys: { p256dh: 'changed-p', auth: 'changed-a' },
            });
        } finally {
            adapter.close();
        }

        const verify = await verifySqliteMigration({ dataDir, sqlitePath: dbPath });
        assert.equal(verify.ok, false);
        const categories = verify.mismatches.map(mismatch => mismatch.category);
        assert.ok(categories.includes('snapshot-digest'));
        assert.ok(categories.includes('push-subscription'));
    });
});
