// src/app/stateBackup.ts
import { store, persistor, resetAll, migrations, persistConfig, isBrowser } from '../app/store';
import type { RootState } from '../app/store';
import { charactersActions } from '../entities/character/slice';
import { roomsActions } from '../entities/room/slice';
import { messagesActions } from '../entities/message/slice';
import { settingsActions } from '../entities/setting/slice';
import { lastSavedActions } from '../entities/lastSaved/slice';
import type { EntityState, EntityId } from '@reduxjs/toolkit';
import { uiActions } from '../entities/ui/slice';
import type { ClientSyncResponse, Patch, BackupFile, BackupState, BackupError, SyncMetadata } from '../entities/sync/types';
import { clearAllBinaries, dataUrlToBlob, getBlob, getDataUrl, saveBlob } from '../services/binaryStore';
import { syncActions } from '../entities/sync/slice';
import { applyPatch } from './diff';
import { collectBinaryStorageKeysFromState } from './binaryKeys';

async function jsonStringify(value: any, replacer?: any, space?: string | number): Promise<string> {
  if (!isBrowser) {
    return JSON.stringify(value, replacer, space);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./jsonWorker.ts', import.meta.url));
    worker.postMessage({ action: 'stringify', data: { value, replacer, space } });
    worker.onmessage = (e) => {
      if (e.data.success) {
        resolve(e.data.result);
      } else {
        reject(new Error(e.data.error));
      }
      worker.terminate();
    };
    worker.onerror = reject;
  });
}

async function jsonParse(text: string): Promise<any> {
  if (!isBrowser) {
    return JSON.parse(text);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./jsonWorker.ts', import.meta.url));
    worker.postMessage({ action: 'parse', data: { text } });
    worker.onmessage = (e) => {
      if (e.data.success) {
        resolve(e.data.result);
      } else {
        reject(new Error(e.data.error));
      }
      worker.terminate();
    };
    worker.onerror = reject;
  });
}

async function fetchWithProgress(url: string, method: string = 'GET', body?: Patch | FormData): Promise<any> {
  const IsFromData = body instanceof FormData;
  const payload = IsFromData ? body : body ? await jsonStringify(body) : undefined;
  if (isBrowser) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);

      if (payload && !IsFromData) {
        xhr.setRequestHeader('Content-Type', 'application/json');
      }

      xhr.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.max(0, Math.min(100, Math.floor((event.loaded / event.total) * 100)));
          store.dispatch(uiActions.setSyncProgress(percent));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject({ status: xhr.status, response: xhr.responseText });
          }
        } else {
          reject({ status: xhr.status, response: xhr.responseText });
        }
      };

      xhr.onerror = () => reject({ status: null, response: null });
      xhr.send(payload);
    });
  } else {
    const headers: Record<string, string> = {};
    if (!(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: payload
    });

    if (!res.ok) {
      throw { status: res.status, response: await res.json() };
    }

    return await res.json();
  }
}

export function entityStateToArray<T>(
  // Id extends PropertyKey 대신 Id extends EntityId를 사용합니다.
  state: Pick<EntityState<T, EntityId>, 'ids' | 'entities'>
): T[] {
  // undefined 안전 처리 (타입·런타임 모두)
  return state.ids
    .map((id) => state.entities[id as EntityId])
    .filter((v): v is T => v !== undefined);
}

export async function wipeAllState() {
  persistor.pause();
  await persistor.flush();     // 남은 write 처리
  await persistor.purge();     // ← localforage에 저장된 'yejingram' 스냅샷 제거
  await clearAllBinaries();    // ← 별도 binary store 제거
  store.dispatch(resetAll());  // ← 메모리상의 Redux 상태 초기화
}

// 백업 파일 스키마

// Build a compact payload from current state
export function buildBackupPayload() {
  const state = store.getState();
  const data = {
    characters: state.characters,
    rooms: state.rooms,
    messages: state.messages,
    settings: state.settings,
    lastSaved: state.lastSaved,
  } satisfies BackupState;
  const payload: BackupFile = {
    app: 'yejingram',
    version: persistConfig.version,
    createdAt: new Date().toISOString(),
    data,
    binaries: [],
  };
  return payload;
}

async function buildBinaryPayloadFromState(state: RootState): Promise<Array<{ storageKey: string; dataUrl: string }>> {
  const keys = new Set<string>(collectBinaryStorageKeysFromState(state));
  const binaries: Array<{ storageKey: string; dataUrl: string }> = [];
  for (const key of keys) {
    const dataUrl = await getDataUrl(key);
    if (dataUrl) binaries.push({ storageKey: key, dataUrl });
  }
  return binaries;
}

function makeServerBinaryUrl(baseURL: string, clientId: string, storageKey: string): string {
  return `${baseURL}/api/${clientId}/binaries/${encodeURIComponent(storageKey)}`;
}

async function uploadBinariesToServer(clientId: string, baseURL: string, storageKeys: string[]): Promise<void> {
  for (let i = 0; i < storageKeys.length; i++) {
    const key = storageKeys[i];
    const blob = await getBlob(key);
    if (!blob) continue;

    // Simple linear progress (binary transfers are outside xhr.onprogress)
    const percent = Math.max(1, Math.min(100, Math.floor(((i + 1) / storageKeys.length) * 100)));
    store.dispatch(uiActions.setSyncProgress(percent));

    const res = await fetch(makeServerBinaryUrl(baseURL, clientId, key), {
      method: 'PUT',
      headers: {
        'Content-Type': blob.type || 'application/octet-stream'
      },
      body: blob
    });

    if (!res.ok) {
      throw new Error(`Binary upload failed (${res.status})`);
    }
  }
}

async function downloadBinariesFromServer(clientId: string, baseURL: string, storageKeys: string[]): Promise<void> {
  for (let i = 0; i < storageKeys.length; i++) {
    const key = storageKeys[i];
    const existing = await getBlob(key);
    if (existing) continue;

    const percent = Math.max(1, Math.min(100, Math.floor(((i + 1) / storageKeys.length) * 100)));
    store.dispatch(uiActions.setSyncProgress(percent));

    const res = await fetch(makeServerBinaryUrl(baseURL, clientId, key), {
      method: 'GET'
    });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Binary download failed (${res.status})`);

    const blob = await res.blob();
    await saveBlob(key, blob);
  }
}


export async function buildBackupPayloadWithBinaries(): Promise<BackupFile> {
  const base = buildBackupPayload();
  const binaries = await buildBinaryPayloadFromState(store.getState());
  return { ...base, binaries };
}

// ---------- 백업 ----------
export async function backupStateToFile() {
  const payload = await buildBackupPayloadWithBinaries();

  const json = await jsonStringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `yejingram-backup-${Date.now()}.json`;
  a.click();

  URL.revokeObjectURL(url);
}

// ---------- 복원 ----------
export async function restoreStateFromFile(file: File) {
  const text = await file.text();

  let parsed: BackupFile;
  try {
    parsed = await jsonParse(text);
  } catch (e) {
    throw new Error('잘못된 JSON 파일입니다.');
  }

  await restoreStateFromPayload(parsed);
}

export async function restoreStateFromPayload(payload: BackupFile) {
  if (payload.app !== 'yejingram' || !payload.data) {
    throw new Error('이 앱의 백업 형식이 아닙니다.');
  }

  await restoreState(payload.data, payload.version);
}

async function restoreState(
  state: Partial<RootState>,
  lastVersion = persistConfig.version,
  options?: { preloadBinaryKeys?: string[]; clientId?: string; baseURL?: string }
) {
  store.dispatch({ type: 'sync/applyDeltaStart' });

  await wipeAllState();
  for (let v = lastVersion + 1; v <= persistConfig.version; v++) {
    if (migrations[v] == null) continue;
    // Support both sync and async migrations
    state = await Promise.resolve(migrations[v](state as unknown as any) as any) as unknown as typeof state;
  }

  // Preload binaries from sync server AFTER wipeAllState (so they won't be deleted)
  // and BEFORE importing Redux slices (so UI loads after binaries are present).
  if (options?.preloadBinaryKeys?.length && options.clientId && options.baseURL) {
    try {
      await downloadBinariesFromServer(options.clientId, options.baseURL, options.preloadBinaryKeys);
    } catch (e) {
      console.warn('[restoreState] Binary preload failed', e);
    }
  }

  // Restore binary store payloads if present (for backups created after binary offloading).
  const legacyBinaries = (state as any).binaries;
  const binariesArray: Array<{ storageKey: string; dataUrl: string }> = Array.isArray(legacyBinaries)
    ? legacyBinaries
    : (legacyBinaries && typeof legacyBinaries === 'object')
      ? Object.entries(legacyBinaries).map(([storageKey, dataUrl]) => ({ storageKey, dataUrl: String(dataUrl) }))
      : [];

  for (const item of binariesArray) {
    const storageKey = item?.storageKey;
    const dataUrl = item?.dataUrl;
    if (typeof storageKey !== 'string' || typeof dataUrl !== 'string') continue;
    if (!dataUrl.startsWith('data:')) continue;
    try {
      const blob = await dataUrlToBlob(dataUrl);
      await saveBlob(storageKey, blob);
    } catch {
      // Skip broken entries.
    }
  }

  const { characters, rooms, messages, settings, lastSaved } = state;
  if (characters) store.dispatch(charactersActions.importCharacters(entityStateToArray(characters)));
  if (rooms) store.dispatch(roomsActions.importRooms(entityStateToArray(rooms)));
  if (messages) store.dispatch(messagesActions.importMessages(entityStateToArray(messages)));
  if (settings) store.dispatch(settingsActions.importSettings(settings));
  if (lastSaved) store.dispatch(lastSavedActions.importLastSaved(lastSaved));
  persistor.persist();

  // Snapshot upload if version changeds
  if (lastVersion != persistConfig.version && state.settings) {
    if (state.settings.syncSettings.syncEnabled && state.settings.syncSettings.syncClientId && state.settings.syncSettings.syncBaseUrl) {
      await backupStateToServer(state.settings.syncSettings.syncClientId, state.settings.syncSettings.syncBaseUrl);
    }
  }

  store.dispatch({ type: 'sync/applyDeltaEnd' });
}

// ---------- 서버 동기화 ----------
export async function checkForConflict(clientId: string, baseURL: string) {
  const state = store.getState();
  try {
    const response = await fetch(`${baseURL}/api/${clientId}/sync/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: await jsonStringify({
        seq: state.sync.patchSeq,
        baseSnapshotSeq: state.sync.snapshotSeq
      } as Patch),
    });

    if (response.ok) {
      store.dispatch(syncActions.resolveConflict());
      return;
    } else if (response.status === 409) {
      const res = await response.json();
      const serverSnapshotSeq = Number(res.snapshotSeq);
      const serverPatchSeq = Number(res.seq);
      const clientSnapshotSeq = state.sync.snapshotSeq;
      const clientPatchSeq = state.sync.patchSeq;

      if (clientPatchSeq < serverPatchSeq) {
        // 클라이언트 패치가 서버보다 뒤처져 있음
        restoreStateFromServer(clientId, baseURL, false);
      } else if (clientSnapshotSeq < serverSnapshotSeq) {
        // 클라이언트 스냅샷이 서버보다 뒤처져 있음
        restoreStateFromServer(clientId, baseURL, true);
      } else {
        // 클라이언트가 서버 보다 앞서 있음
        console.log(`⚠️ 충돌 발생! 서버 패치 시퀀스: ${serverPatchSeq}, 클라이언트 패치 시퀀스: ${clientPatchSeq}`);
        handleBackupError({
          cause: 'conflict',
          timestamp: res.timestamp ? Number(res.timestamp) : Date.now(),
          seq: serverPatchSeq
        }, clientId, baseURL);
      }
    } else if (response.status === 410) {
      handleBackupError({ cause: 'snapshot_mismatch' }, clientId, baseURL);
    } else {
      throw new Error(`Check failed: ${response.statusText}`);
    }
  } catch (error) {
    throw new Error('Check failed');
  }
}

export async function backupStateToServer(
  clientId: string,
  baseURL: string,
  diff?: Patch
) {
  store.dispatch(uiActions.setSyncProgress(1));

  let url = `${baseURL}/api/${clientId}/sync`;

  let payload: Patch | FormData | undefined = diff;
  if (!diff) {
    url = `${baseURL}/api/${clientId}/snapshot`;

    const formData = new FormData();
    formData.append('snapshot', JSON.stringify(buildBackupPayload().data));
    formData.append('version', persistConfig.version.toString());

    payload = formData;
  }

  let response: any = null;

  try {
    // If this is an incremental patch, upload newly referenced binaries first.
    if (diff?.binary?.put?.length) {
      await uploadBinariesToServer(clientId, baseURL, diff.binary.put);
    }

    const state = store.getState();
    console.log(`[backupStateToServer] Client patchSeq: ${state.sync.patchSeq}, snapshotSeq: ${state.sync.snapshotSeq}`);

    response = await fetchWithProgress(url, 'POST', payload);

    const res = response as SyncMetadata;

    store.dispatch(syncActions.setSnapshotSeq(res.snapshotSeq));
    store.dispatch(syncActions.setPatchSeq(res.patchSeq));
    store.dispatch(syncActions.popPatchQueue());

    if (!diff) {
      store.dispatch(syncActions.clearPatchQueue());
      store.dispatch(syncActions.resolveConflict());

      // Snapshot mode: ensure server has all binaries referenced by the snapshot.
      // (server may clear its binary dir on snapshot overwrite)
      try {
        const keys = collectBinaryStorageKeysFromState(store.getState());
        if (keys.length) await uploadBinariesToServer(clientId, baseURL, keys);
      } catch (e) {
        console.warn('[backupStateToServer] Snapshot binary upload failed', e);
      }
    }

  } catch (err: any) {
    const status = err.status;
    const res = err.response;

    switch (status) {
      case 404: {
        await backupStateToServer(clientId, baseURL);
        break;
      }

      case 409: {
        console.log(`[backupStateToServer] Conflict: Server seq: ${res.seq}, timestamp: ${res.timestamp}, Client patchSeq: ${store.getState().sync.patchSeq}`);
        handleBackupError({ cause: 'conflict', seq: Number(res.seq), timestamp: Number(res.timestamp) }, clientId, baseURL);
        break;
      }

      case 410: {
        console.log(`[backupStateToServer] Snapshot mismatch`)
        handleBackupError({ cause: 'snapshot_mismatch' }, clientId, baseURL);
        break;
      }

      default:
        throw new Error(`Upload failed: ${status}`);
    }
  } finally {
    store.dispatch(uiActions.clearSyncProgress());
    store.dispatch(uiActions.clearForceShowSyncModal());
  }
}

export async function restoreStateFromServer(clientId: string, baseURL: string, full = false) {
  store.dispatch(uiActions.setSyncProgress(1));
  try {
    const currentState = store.getState();
    const queryParams = new URLSearchParams({
      sinceSnapshotSeq: currentState.sync.snapshotSeq.toString(),
      sincePatchSeq: full ? '0' : currentState.sync.patchSeq.toString(),
      ...(full && { full: 'true' })
    });
    let serverResponse: ClientSyncResponse | null = null;

    serverResponse = await fetchWithProgress(`${baseURL}/api/${clientId}/sync?${queryParams.toString()}`);

    if (serverResponse) {
      const serverState: ClientSyncResponse = serverResponse;

      if (full) {
        let snapshotResponse: RootState;
        snapshotResponse = await fetchWithProgress(`${baseURL}/api/${clientId}/snapshot`);
        const state: RootState = snapshotResponse;
        const patchedState = applyPatch(state, serverState.patches);

        // Full restore: preload binaries referenced by the final state.
        const needed = collectBinaryStorageKeysFromState(patchedState);
        await restoreState(patchedState, serverState.version, { preloadBinaryKeys: needed, clientId, baseURL });
      } else {
        const state = store.getState();
        const patchedState = applyPatch(state, serverState.patches);

        // Patch-only restore: preload binaries referenced by the resulting state.
        const needed = collectBinaryStorageKeysFromState(patchedState);
        await restoreState(patchedState, persistConfig.version, { preloadBinaryKeys: needed, clientId, baseURL });
      }

      store.dispatch(syncActions.updateFromSnapshot({
        snapshotSeq: serverState.snapshotSeq,
        patchSeq: serverState.patchSeq
      }));
      store.dispatch(syncActions.clearPatchQueue());
      store.dispatch(syncActions.resolveConflict());
      return true;
    }
  } catch (error) {
    return {
      'cause': (error as Error).message
    }
  } finally {
    store.dispatch(uiActions.clearSyncProgress());
    store.dispatch(uiActions.clearForceShowSyncModal());
  }

  return false;
}

export async function pullLatestState(clientId: string, baseURL: string): Promise<boolean> {
  try {
    const currentState = store.getState();
    const queryParams = new URLSearchParams({
      sinceSnapshotSeq: currentState.sync.snapshotSeq.toString(),
      sincePatchSeq: '0',
      full: 'true',
    });

    const serverResponse: ClientSyncResponse | null = await fetchWithProgress(
      `${baseURL}/api/${clientId}/sync?${queryParams.toString()}`
    );
    if (!serverResponse) return false;

    const serverState: ClientSyncResponse = serverResponse;

    if (
      serverState.snapshotSeq === currentState.sync.snapshotSeq &&
      serverState.patchSeq === currentState.sync.patchSeq
    ) {
      return false;
    }

    let targetState: Partial<RootState>;
    if (serverState.snapshotSeq > currentState.sync.snapshotSeq) {
      const snapshotResponse: RootState = await fetchWithProgress(
        `${baseURL}/api/${clientId}/snapshot`
      );
      targetState = applyPatch(snapshotResponse, serverState.patches);
    } else {
      targetState = applyPatch(currentState, serverState.patches);
    }

    const needed = collectBinaryStorageKeysFromState(targetState as RootState);
    if (needed.length > 0) {
      await downloadBinariesFromServer(clientId, baseURL, needed);
    }

    store.dispatch({ type: 'sync/applyDeltaStart' });
    const { characters, rooms, messages, settings, lastSaved } = targetState;
    if (characters) store.dispatch(charactersActions.importCharacters(entityStateToArray(characters)));
    if (rooms) store.dispatch(roomsActions.importRooms(entityStateToArray(rooms)));
    if (messages) store.dispatch(messagesActions.importMessages(entityStateToArray(messages)));
    if (settings) store.dispatch(settingsActions.importSettings(settings));
    if (lastSaved) store.dispatch(lastSavedActions.importLastSaved(lastSaved));
    store.dispatch(syncActions.updateFromSnapshot({
      snapshotSeq: serverState.snapshotSeq,
      patchSeq: serverState.patchSeq,
    }));
    store.dispatch(syncActions.clearPatchQueue());
    store.dispatch(syncActions.resolveConflict());
    store.dispatch({ type: 'sync/applyDeltaEnd' });
    persistor.persist();

    return true;
  } catch (error) {
    console.error('[pullLatestState] Failed:', error);
    return false;
  } finally {
    store.dispatch(uiActions.clearSyncProgress());
  }
}

export function handleBackupError(
  error: BackupError,
  clientId: string,
  baseURL: string
) {
  if (error.cause === 'conflict') {
    console.log('⚠️ 충돌 발생!');
    store.dispatch(syncActions.setConflict({
      lastServerPatchSeq: error.seq,
      lastServerTimestamp: error.timestamp
    }));
    return;
  }
  if (error.cause === 'snapshot_mismatch') {
    console.log('⚠️ 스냅샷 불일치!');
    restoreStateFromServer(clientId, baseURL);
  }
}