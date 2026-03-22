import test from 'node:test';
import assert from 'node:assert/strict';

import type { Message } from '../../entities/message/types';

import { resolveLlmTransport, shouldPersistWorkerSnapshot, shouldWorkerHandleMessage } from './workerPolicies.ts';

test('local transport bypasses backend proxy even when sync is enabled', () => {
    assert.equal(resolveLlmTransport({
        syncEnabled: true,
        syncBaseUrl: 'https://example.com',
        preferProxy: false,
    }), 'local');

    assert.equal(resolveLlmTransport({
        syncEnabled: true,
        syncBaseUrl: 'https://example.com',
        preferProxy: false,
    }), 'local');
});

test('proxy transport is used only when explicitly requested with sync enabled', () => {
    assert.equal(resolveLlmTransport({
        syncEnabled: true,
        syncBaseUrl: 'https://example.com',
        preferProxy: true,
    }), 'proxy');

    assert.equal(resolveLlmTransport({
        syncEnabled: false,
        syncBaseUrl: 'https://example.com',
        preferProxy: true,
    }), 'local');
});

test('worker snapshot persists only when a request or response changes state', () => {
    assert.equal(shouldPersistWorkerSnapshot({ snapshotChanged: true, acceptedUserMessageCount: 1, generatedMessageCount: 0 }), true);
    assert.equal(shouldPersistWorkerSnapshot({ snapshotChanged: true, acceptedUserMessageCount: 0, generatedMessageCount: 1 }), true);
    assert.equal(shouldPersistWorkerSnapshot({ snapshotChanged: false, acceptedUserMessageCount: 1, generatedMessageCount: 0 }), false);
    assert.equal(shouldPersistWorkerSnapshot({ snapshotChanged: true, acceptedUserMessageCount: 0, generatedMessageCount: 0 }), false);
});

test('worker keeps image messages instead of dropping them', () => {
    const imageMessage: Message = {
        id: 'image-1',
        roomId: 'room-1',
        authorId: 1,
        createdAt: '2026-03-23T00:00:00.000Z',
        type: 'IMAGE',
        file: {
            storageKey: 'message/image-1',
            mimeType: 'image/png',
            name: 'generated.png',
        },
        imageGenerationSetting: {
            prompt: 'draw a portrait',
            isIncludingChar: true,
        },
    };

    assert.equal(shouldWorkerHandleMessage(imageMessage), true);
});
