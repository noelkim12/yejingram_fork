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
import { type ServerState, type SyncMetadata } from '../../src/entities/sync/types';
import { applyPatch } from '../../src/utils/diff';
import { collectBinaryStorageKeysFromState } from '../../src/utils/binaryKeys';
import { headlessSendMessage } from '../../src/lib/headlessUtils';
import { clearAllBinaries, saveBlob } from '../../src/services/binaryStore';
import { shouldPersistWorkerSnapshot, shouldWorkerHandleMessage } from '../../src/services/llm/workerPolicies';
import { sanitizeClientId, stateCache } from '../index';
import { queue } from './queue';
import { broadcastLLMComplete } from './events';
import { readSubscriptions, prepareAvatarCache } from '../proactive/routes';
import { getStorage } from '../storage';

const POLL_INTERVAL_MS = 2_000;

interface WebPushLike {
    sendNotification(subscription: PushSubscription, payload: string): Promise<unknown>;
}

async function readServerState(clientId: string): Promise<ServerState | null> {
    if (stateCache.has(clientId)) {
        return stateCache.get(clientId) as ServerState;
    }

    const state = await getStorage().sync.readState(clientId);
    if (!state) return null;

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
    const binaryStorage = getStorage().binaries;

    for (const storageKey of storageKeys) {
        const binary = await binaryStorage.get(clientId, storageKey);
        if (!binary) {
            console.warn(`[llm-worker:${clientId}] Missing binary ${storageKey}, continuing without preload.`);
            continue;
        }

        await saveBlob(storageKey, new Blob([new Uint8Array(binary.data)], { type: binary.mimeType || 'application/octet-stream' }));
    }
}

async function loadStateFromSyncStore(clientId: string): Promise<SyncMetadata> {
    const safeClientId = sanitizeClientId(clientId);
    const snapshotRaw = await getStorage().sync.readSnapshot(safeClientId);
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
    void vapidPublicKey;

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
                tag: `llm-${roomId}`,
                data: {
                    url: `/?roomId=${roomId}`,
                    roomId,
                    clientId,
                },
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

            if (generatedMessages.length > 0 && request.userMessages.length > 0) {
                const latestUserTime = request.userMessages
                    .map(m => m.createdAt)
                    .filter(Boolean)
                    .sort()
                    .pop() ?? '';

                if (latestUserTime) {
                    let offset = 1;
                    for (const msg of generatedMessages) {
                        if (msg.createdAt <= latestUserTime) {
                            const fixedTime = new Date(new Date(latestUserTime).getTime() + offset).toISOString();
                            store.dispatch({
                                type: 'messages/updateOne',
                                payload: { id: msg.id, changes: { createdAt: fixedTime } },
                            });
                            offset++;
                        }
                    }
                }
            }

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
                await getStorage().sync.replaceState(safeClientId, {
                    snapshot: JSON.stringify(buildSnapshot(nextState)),
                    metadata: nextMetadata,
                });
                console.log(`[llm-worker:${safeClientId}] ✅ Snapshot saved`);

                stateCache.set(safeClientId, { metadata: nextMetadata, patches: [] } as ServerState);
            } else {
                console.log(`[llm-worker:${safeClientId}] ⏭️ Skipping snapshot save because no request or response changed state`);
            }

            if (generatedMessages.length > 0) {
                const currentServerState = stateCache.get(safeClientId) as ServerState | undefined;
                broadcastLLMComplete(safeClientId, {
                    requestId: request.id,
                    roomId: request.roomId,
                    snapshotSeq: currentServerState?.metadata.snapshotSeq ?? 0,
                    patchSeq: currentServerState?.metadata.patchSeq ?? 0,
                });

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
            const orderedPending = [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            for (const request of orderedPending) {
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
