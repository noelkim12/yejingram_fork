import fs from 'fs/promises';
import path from 'path';
import type { PushSubscription } from 'web-push';
import type { Message } from '../../src/entities/message/types';
import { store, persistor, persistConfig, resetAll, type RootState } from '../../src/app/store';
import { charactersActions } from '../../src/entities/character/slice';
import { roomsActions } from '../../src/entities/room/slice';
import { messagesActions } from '../../src/entities/message/slice';
import { settingsActions } from '../../src/entities/setting/slice';
import { lastSavedActions } from '../../src/entities/lastSaved/slice';
import { syncActions } from '../../src/entities/sync/slice';
import { selectRoomById } from '../../src/entities/room/selectors';
import { selectCharacterById } from '../../src/entities/character/selectors';
import { type Patch, type ServerState, type SyncMetadata } from '../../src/entities/sync/types';
import { applyPatch } from '../../src/utils/diff';
import { collectBinaryStorageKeysFromState } from '../../src/utils/binaryKeys';
import { headlessSendMessage } from '../../src/lib/headlessUtils';
import { clearAllBinaries, saveBlob } from '../../src/services/binaryStore';
import { shouldPersistWorkerSnapshot, shouldWorkerHandleMessage } from '../../src/services/llm/workerPolicies';
import { DATA_DIR, sanitizeClientId, stateCache } from '../index';
import { queue } from './queue';
import { readSubscriptions, prepareAvatarCache } from '../proactive/routes';
import { BIN_DIR } from '../index';

const POLL_INTERVAL_MS = 2_000;

interface WebPushLike {
    sendNotification(subscription: PushSubscription, payload: string): Promise<unknown>;
}

function metadataPath(clientId: string): string {
    return path.join(DATA_DIR, `${clientId}.metadata.json`);
}

function snapshotPath(clientId: string): string {
    return path.join(DATA_DIR, `${clientId}.snapshot.json`);
}

function patchLogPath(clientId: string): string {
    return path.join(DATA_DIR, `${clientId}.patches.log`);
}

function toBase64Url(input: string): string {
    return Buffer.from(input, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function binaryDataPath(clientId: string, storageKey: string): string {
    return path.join(BIN_DIR, clientId, `${toBase64Url(storageKey)}.bin`);
}

function binaryMetaPath(clientId: string, storageKey: string): string {
    return path.join(BIN_DIR, clientId, `${toBase64Url(storageKey)}.meta.json`);
}

async function readMetadata(clientId: string): Promise<SyncMetadata | null> {
    try {
        const raw = await fs.readFile(metadataPath(clientId), 'utf-8');
        return JSON.parse(raw) as SyncMetadata;
    } catch (err: any) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

async function readSnapshot(clientId: string): Promise<string | null> {
    try {
        return await fs.readFile(snapshotPath(clientId), 'utf-8');
    } catch (err: any) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

async function readPatchLog(clientId: string): Promise<Patch[]> {
    try {
        const raw = await fs.readFile(patchLogPath(clientId), 'utf-8');
        return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as Patch);
    } catch (err: any) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

async function writeSnapshot(clientId: string, snapshot: string): Promise<void> {
    await fs.writeFile(snapshotPath(clientId), snapshot);
}

async function updateMetadata(clientId: string, metadata: SyncMetadata): Promise<void> {
    await fs.writeFile(metadataPath(clientId), JSON.stringify(metadata, null, 2));
}

async function resetPatchLog(clientId: string): Promise<void> {
    const file = patchLogPath(clientId);
    try {
        await fs.truncate(file, 0);
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            await fs.writeFile(file, '');
            return;
        }
        throw err;
    }
}

async function readServerState(clientId: string): Promise<ServerState | null> {
    if (stateCache.has(clientId)) {
        return stateCache.get(clientId) as ServerState;
    }

    const metadata = await readMetadata(clientId);
    if (!metadata) return null;

    const state: ServerState = {
        metadata,
        patches: await readPatchLog(clientId)
    };

    stateCache.set(clientId, state);
    return state;
}

function entityStateToArray<T extends { id: string | number }>(entityState: {
    ids: Array<string | number>;
    entities: Record<string, T | undefined>;
}): T[] {
    return entityState.ids
        .map(id => entityState.entities[String(id)])
        .filter(Boolean) as T[];
}

function buildSnapshot(state: RootState) {
    return {
        characters: state.characters,
        rooms: state.rooms,
        messages: state.messages,
        settings: state.settings,
        lastSaved: state.lastSaved,
    };
}

export async function preloadReferencedBinaries(clientId: string, storageKeys: string[]): Promise<void> {
    await clearAllBinaries();

    for (const storageKey of storageKeys) {
        try {
            const [buffer, metaRaw] = await Promise.all([
                fs.readFile(binaryDataPath(clientId, storageKey)),
                fs.readFile(binaryMetaPath(clientId, storageKey), 'utf-8').catch(() => ''),
            ]);
            const meta = metaRaw ? JSON.parse(metaRaw) as { mimeType?: string } : null;
            await saveBlob(storageKey, new Blob([buffer], { type: meta?.mimeType || 'application/octet-stream' }));
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                console.warn(`[llm-worker:${clientId}] Missing binary ${storageKey}, continuing without preload.`);
                continue;
            }
            throw err;
        }
    }
}

async function loadStateFromSyncStore(clientId: string): Promise<SyncMetadata> {
    const safeClientId = sanitizeClientId(clientId);
    const snapshotRaw = await readSnapshot(safeClientId);
    const serverState = await readServerState(safeClientId);
    if (!snapshotRaw || !serverState) {
        throw new Error(`Sync state missing for client '${safeClientId}'`);
    }

    const snapshot = JSON.parse(snapshotRaw) as RootState;
    const hydrated = serverState.patches.length > 0
        ? applyPatch(snapshot, serverState.patches)
        : snapshot;
    const binaryKeys = collectBinaryStorageKeysFromState(hydrated);

    await preloadReferencedBinaries(safeClientId, binaryKeys);

    persistor.pause();
    void persistor.flush();

    store.dispatch(resetAll());
    store.dispatch(charactersActions.importCharacters(entityStateToArray(hydrated.characters as any)));
    store.dispatch(roomsActions.importRooms(entityStateToArray(hydrated.rooms as any)));
    store.dispatch(messagesActions.importMessages(entityStateToArray(hydrated.messages as any)));
    store.dispatch(settingsActions.importSettings(hydrated.settings));
    store.dispatch(lastSavedActions.importLastSaved(hydrated.lastSaved));
    store.dispatch(syncActions.updateFromSnapshot({
        snapshotSeq: serverState.metadata.snapshotSeq,
        patchSeq: serverState.metadata.patchSeq,
    }));
    store.dispatch(syncActions.clearPatchQueue());
    store.dispatch(syncActions.resolveConflict());

    persistor.persist();
    return serverState.metadata;
}

async function sendCompletionPush(
    webpush: WebPushLike,
    vapidPublicKey: string,
    clientId: string,
    roomId: string,
    state: RootState,
    generatedMessages: Message[]
): Promise<void> {
    let subscription: PushSubscription;
    try {
        subscription = await readSubscriptions(clientId) as PushSubscription;
        console.log(`[llm-worker:${clientId}] 📱 Push subscription found, sending notification...`);
    } catch {
        console.log(`[llm-worker:${clientId}] 📱 No push subscription, skipping notification`);
        return;
    }

    const latestMessage = generatedMessages[generatedMessages.length - 1];
    const latestAuthorId = latestMessage?.authorId;
    if (latestAuthorId != null) {
        await prepareAvatarCache(state, clientId, latestAuthorId);
    }

    const characterName = latestAuthorId == null
        ? 'Assistant'
        : (selectCharacterById(state, latestAuthorId)?.name ?? 'Assistant');
    const body = latestMessage?.content ?? '[message]';

    try {
        await webpush.sendNotification(
            subscription,
            JSON.stringify({
                title: 'Reply ready',
                icon: latestAuthorId == null ? '/yejingram.png' : `/api/${clientId}/push/icon/${latestAuthorId}`,
                badge: '/yejingram.png',
                body: `${characterName}: ${body}`,
                tag: roomId,
                roomId,
                clientId,
                vapidPublicKey,
            })
        );
        console.log(`[llm-worker:${clientId}] ✅ Push notification sent to ${characterName}`);
    } catch (error) {
        console.warn(`[llm-worker:${clientId}] ⚠️ Push notification failed:`, error);
    }
}

async function processRequest(
    request: { id: string; clientId: string; roomId: string; userMessages: Message[] },
    config: { webpush: WebPushLike; vapidPublicKey: string }
): Promise<void> {
    const safeClientId = sanitizeClientId(request.clientId);
    console.log(`[llm-worker:${safeClientId}] 🔄 Processing request ${request.id} for room ${request.roomId}`);
    const release = await queue.acquireClientLock(safeClientId);

    try {
        await queue.markProcessing(request.id);
        console.log(`[llm-worker:${safeClientId}] 📋 Request marked as processing`);

        store.dispatch({ type: 'sync/applyDeltaStart' });
        try {
            console.log(`[llm-worker:${safeClientId}] 📂 Loading state from sync store...`);
            const metadata = await loadStateFromSyncStore(safeClientId);
            const stateBefore = store.getState();
            const snapshotBefore = JSON.stringify(buildSnapshot(stateBefore));
            console.log(`[llm-worker:${safeClientId}] ✅ State loaded (snapshotSeq: ${metadata.snapshotSeq})`);

            const room = selectRoomById(stateBefore, request.roomId);
            if (!room) {
                throw new Error(`Room not found: ${request.roomId}`);
            }

            let acceptedUserMessageCount = 0;
            for (const userMessage of request.userMessages) {
                if (!shouldWorkerHandleMessage(userMessage)) {
                    console.warn(`[llm-worker:${safeClientId}] Skipping unsupported user message ${userMessage.id}.`);
                    continue;
                }
                store.dispatch(messagesActions.upsertOne(userMessage));
                acceptedUserMessageCount++;
            }
            console.log(`[llm-worker:${safeClientId}] 📝 Added ${acceptedUserMessageCount} user message(s) to store`);

            console.log(`[llm-worker:${safeClientId}] 🤖 Calling LLM API...`);
            const startTime = Date.now();
            const generatedMessages: Message[] = [];
            await headlessSendMessage({
                store,
                room,
                mode: 'normal',
                transport: 'local',
                onMessage: generated => {
                    if (!shouldWorkerHandleMessage(generated)) {
                        console.warn(`[llm-worker:${safeClientId}] Skipping unsupported generated message ${generated.id}.`);
                        return;
                    }
                    console.log(`[llm-worker:${safeClientId}] 💬 Received message from ${generated.authorId}: ${generated.content?.slice(0, 50)}...`);
                    generatedMessages.push(generated);
                },
            });
            const elapsed = Date.now() - startTime;
            console.log(`[llm-worker:${safeClientId}] ✅ LLM completed in ${elapsed}ms, generated ${generatedMessages.length} message(s)`);

            const nextState = store.getState();
            const snapshotAfter = JSON.stringify(buildSnapshot(nextState));
            if (shouldPersistWorkerSnapshot({
                snapshotChanged: snapshotBefore !== snapshotAfter,
                acceptedUserMessageCount,
                generatedMessageCount: generatedMessages.length,
            })) {
                const nextMetadata: SyncMetadata = {
                    snapshotSeq: metadata.snapshotSeq + 1,
                    patchSeq: 0,
                    version: metadata.version ?? persistConfig.version,
                };

                console.log(`[llm-worker:${safeClientId}] 💾 Saving snapshot (seq: ${nextMetadata.snapshotSeq})...`);
                await writeSnapshot(safeClientId, JSON.stringify(buildSnapshot(nextState)));
                await updateMetadata(safeClientId, nextMetadata);
                await resetPatchLog(safeClientId);
                console.log(`[llm-worker:${safeClientId}] ✅ Snapshot saved`);

                stateCache.set(safeClientId, { metadata: nextMetadata, patches: [] } as ServerState);
            } else {
                console.log(`[llm-worker:${safeClientId}] ⏭️ Skipping snapshot save because no request or response changed state`);
            }

            if (generatedMessages.length > 0) {
                await sendCompletionPush(
                    config.webpush,
                    config.vapidPublicKey,
                    safeClientId,
                    room.id,
                    nextState,
                    generatedMessages
                );
            } else {
                console.log(`[llm-worker:${safeClientId}] 📱 No generated messages, skipping notification`);
            }
        } finally {
            store.dispatch({ type: 'sync/applyDeltaEnd' });
        }

        await queue.markCompleted(request.id);
        console.log(`[llm-worker:${safeClientId}] 🎉 Request ${request.id} completed successfully`);
    } catch (error: any) {
        console.error(`[llm-worker:${safeClientId}] ❌ Failed request ${request.id}:`, error);
        await queue.markFailed(request.id, error?.message ?? String(error));
    } finally {
        release();
    }
}

export function startLLMWorker(config: { webpush: WebPushLike; vapidPublicKey: string }): () => void {
    let polling = false;

    console.log('[llm-worker] 🚀 LLM Worker started - polling every 2s');

    const poll = async () => {
        if (polling) return;
        polling = true;
        try {
            const pending = await queue.getPending();
            if (pending.length > 0) {
                console.log(`[llm-worker] 📥 Found ${pending.length} pending request(s)`);
            }
            pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            for (const request of pending) {
                await processRequest(request, config);
            }
        } catch (error) {
            console.error('[llm-worker] Polling failed:', error);
        } finally {
            polling = false;
        }
    };

    void queue.recoverPendingRequests().catch(error => {
        console.error('[llm-worker] Failed to recover pending requests:', error);
    });

    const interval = setInterval(() => {
        void poll();
    }, POLL_INTERVAL_MS);

    void poll();

    return () => {
        clearInterval(interval);
        console.log('[llm-worker] 🛑 LLM Worker stopped');
    };
}
