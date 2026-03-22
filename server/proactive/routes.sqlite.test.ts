import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { once } from 'events';
import type { AddressInfo } from 'net';
import type { PushSubscription } from 'web-push';

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'yejingram-proactive-sqlite-'));
process.env.DATA_DIR = testRoot;
process.env.SERVER_STORAGE_BACKEND = 'sqlite';

const [{ default: app, DATA_DIR, BIN_DIR, SQLITE_DB_PATH }, storageIndex, proactiveRoutes] = await Promise.all([
    import('../index.ts'),
    import('../storage/index.ts'),
    import('./routes.ts'),
]);

const { getStorage, initializeStorage, resetStorageForTests } = storageIndex;
const { readSubscriptions } = proactiveRoutes;

function createSubscription(seed: string): PushSubscription {
    return {
        endpoint: `https://push.example.com/${seed}`,
        keys: {
            p256dh: `p256dh-${seed}`,
            auth: `auth-${seed}`,
        },
    };
}

async function resetEnvironment(): Promise<void> {
    resetStorageForTests();
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

beforeEach(async () => {
    await resetEnvironment();
});

after(async () => {
    resetStorageForTests();
    await rm(testRoot, { recursive: true, force: true });
});

test('subscribe route persists subscription in storage adapter and readSubscriptions(clientId) returns it', async () => {
    const clientId = 'sqlite-push-single';
    const subscription = createSubscription('single');

    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/${clientId}/push/subscription`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(subscription),
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
    });

    const saved = await getStorage().pushSubscriptions.read(clientId);
    assert.ok(saved);
    assert.equal(saved.endpoint, subscription.endpoint);

    const readOne = await readSubscriptions(clientId) as PushSubscription;
    assert.equal(readOne.endpoint, subscription.endpoint);
    assert.deepEqual(readOne.keys, subscription.keys);
});

test('readSubscriptions() returns object shape keyed by clientId for proactive loop consumption', async () => {
    const firstClientId = 'sqlite-loop-a';
    const secondClientId = 'sqlite-loop-b';

    await getStorage().pushSubscriptions.save(firstClientId, createSubscription('a') as unknown as Record<string, unknown>);
    await getStorage().pushSubscriptions.save(secondClientId, createSubscription('b') as unknown as Record<string, unknown>);

    const allSubscriptions = await readSubscriptions() as Record<string, PushSubscription>;

    assert.equal(Object.keys(allSubscriptions).length, 2);
    assert.equal(allSubscriptions[firstClientId].endpoint, 'https://push.example.com/a');
    assert.equal(allSubscriptions[secondClientId].endpoint, 'https://push.example.com/b');
});

test('unsubscribe route returns 404 when subscription does not exist', async () => {
    const clientId = 'sqlite-missing-subscription';

    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/${clientId}/push/unsubscribe`, {
            method: 'POST',
        });

        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: 'Subscription not found' });
    });
});
