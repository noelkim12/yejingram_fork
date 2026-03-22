import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';

import { BIN_DIR } from '../index.ts';
import { getBlob } from '../../src/services/binaryStore.ts';
import { preloadReferencedBinaries } from './worker.ts';

function toBase64Url(input: string): string {
    return Buffer.from(input, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

test('preloadReferencedBinaries loads stored binaries for the worker', async () => {
    const clientId = `worker-test-${Date.now()}`;
    const storageKey = 'avatars/seo-yeon';
    const clientDir = path.join(BIN_DIR, clientId);
    const encodedKey = toBase64Url(storageKey);
    const binaryPath = path.join(clientDir, `${encodedKey}.bin`);
    const metaPath = path.join(clientDir, `${encodedKey}.meta.json`);

    await fs.mkdir(clientDir, { recursive: true });
    await fs.writeFile(binaryPath, Buffer.from('worker-binary-data'));
    await fs.writeFile(metaPath, JSON.stringify({ storageKey, mimeType: 'image/png' }));

    try {
        await preloadReferencedBinaries(clientId, [storageKey]);
        const blob = await getBlob(storageKey);

        assert.ok(blob);
        assert.equal(blob?.type, 'image/png');
        assert.equal(Buffer.from(await blob!.arrayBuffer()).toString('utf8'), 'worker-binary-data');
    } finally {
        await fs.rm(clientDir, { recursive: true, force: true });
    }
});
