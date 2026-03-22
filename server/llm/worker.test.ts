import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';

import { BIN_DIR, DATA_DIR } from '../index.ts';
import { getStorage, initializeStorage, resetStorageForTests } from '../storage/index.ts';
import { getBlob } from '../../src/services/binaryStore.ts';
import { preloadReferencedBinaries } from './worker.ts';

test('preloadReferencedBinaries loads stored binaries for the worker', async () => {
    const clientId = `worker-test-${Date.now()}`;
    const storageKey = 'avatars/seo-yeon';
    const clientDir = path.join(BIN_DIR, clientId);
    resetStorageForTests();
    await initializeStorage({
        backend: 'file',
        dataDir: DATA_DIR,
        binaryDir: BIN_DIR,
        sqlitePath: path.join(DATA_DIR, 'yejingram.db'),
    });
    await getStorage().binaries.put(clientId, storageKey, 'image/png', Buffer.from('worker-binary-data'));

    try {
        await preloadReferencedBinaries(clientId, [storageKey]);
        const blob = await getBlob(storageKey);

        assert.ok(blob);
        assert.equal(blob?.type, 'image/png');
        assert.equal(Buffer.from(await blob!.arrayBuffer()).toString('utf8'), 'worker-binary-data');
    } finally {
        resetStorageForTests();
        await fs.rm(clientDir, { recursive: true, force: true });
    }
});
