import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { openSqliteDatabase } from '../storage/sqlite/client';
import { initSqliteSchema } from '../storage/sqlite/schema';
import type { Patch, SyncMetadata } from '../../src/entities/sync/types';
import type { LLMRequest } from '../types';

export type MigrationMode = 'skip-existing' | 'replace-client';

export interface MigrateJsonToSqliteOptions {
    dataDir: string;
    sqlitePath: string;
    mode?: MigrationMode;
}

export interface ClientMigrationSummary {
    clientId: string;
    status: 'migrated' | 'skipped';
    patchCount: number;
    requestCount: number;
    binaryCount: number;
}

export interface MigrationReport {
    mode: MigrationMode;
    clientOrder: string[];
    migratedClientCount: number;
    skippedClientCount: number;
    clients: ClientMigrationSummary[];
}

interface LegacyBinaryRecord {
    storageKey: string;
    mimeType: string;
    bytes: Uint8Array;
}

interface LegacyClientPayload {
    clientId: string;
    syncState: {
        metadata: SyncMetadata;
        snapshotRaw: string;
        patches: Patch[];
    } | null;
    subscription: Record<string, unknown> | null;
    binaries: LegacyBinaryRecord[];
    requests: LLMRequest[];
}

interface SqliteClientDomainPresence {
    inClients: boolean;
    inPushSubscriptions: boolean;
    inBinaries: boolean;
    inRequests: boolean;
    inSnapshots: boolean;
    inPatches: boolean;
}

function toBase64Url(input: string): string {
    return Buffer.from(input, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function digestJson(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseMode(rawMode?: string): MigrationMode {
    if (!rawMode || rawMode === 'skip-existing') {
        return 'skip-existing';
    }
    if (rawMode === 'replace-client') {
        return 'replace-client';
    }

    throw new Error(`Invalid --mode value: ${rawMode}`);
}

function parseArgs(argv: string[]): MigrateJsonToSqliteOptions {
    let dataDir = path.resolve(process.cwd(), 'data');
    let sqlitePath = path.join(dataDir, 'yejingram.db');
    let mode: MigrationMode = 'skip-existing';

    for (const arg of argv) {
        if (arg.startsWith('--data-dir=')) {
            dataDir = path.resolve(arg.slice('--data-dir='.length));
            sqlitePath = path.join(dataDir, 'yejingram.db');
            continue;
        }
        if (arg.startsWith('--sqlite-path=')) {
            sqlitePath = path.resolve(arg.slice('--sqlite-path='.length));
            continue;
        }
        if (arg.startsWith('--mode=')) {
            mode = parseMode(arg.slice('--mode='.length));
            continue;
        }
    }

    return { dataDir, sqlitePath, mode };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
}

async function readOptionalJsonFile<T>(filePath: string): Promise<T | null> {
    try {
        return await readJsonFile<T>(filePath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function isPushSubscriptionObject(raw: unknown): raw is Record<string, unknown> {
    if (!raw || typeof raw !== 'object') {
        return false;
    }

    const endpoint = (raw as { endpoint?: unknown }).endpoint;
    const keys = (raw as { keys?: unknown }).keys;
    const p256dh = typeof keys === 'object' && keys ? (keys as { p256dh?: unknown }).p256dh : undefined;
    const auth = typeof keys === 'object' && keys ? (keys as { auth?: unknown }).auth : undefined;
    return typeof endpoint === 'string' && typeof p256dh === 'string' && typeof auth === 'string';
}

async function listSyncClientIds(dataDir: string): Promise<string[]> {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true });
    return entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.metadata.json'))
        .map(entry => entry.name.slice(0, -'.metadata.json'.length))
        .sort((a, b) => a.localeCompare(b));
}

async function listClientIdsBySuffix(dataDir: string, suffix: string): Promise<string[]> {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true });
    return entries
        .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
        .map(entry => entry.name.slice(0, -suffix.length))
        .sort((a, b) => a.localeCompare(b));
}

async function listPushSubscriptionClientIds(dataDir: string): Promise<string[]> {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true });
    const out = new Set<string>();

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }
        if (entry.name.endsWith('.metadata.json') || entry.name.endsWith('.snapshot.json') || entry.name.endsWith('.meta.json')) {
            continue;
        }

        const clientId = entry.name.slice(0, -'.json'.length);
        const payload = await readOptionalJsonFile<Record<string, unknown>>(path.join(dataDir, entry.name));
        if (payload && isPushSubscriptionObject(payload)) {
            out.add(clientId);
        }
    }

    return Array.from(out).sort((a, b) => a.localeCompare(b));
}

async function listClientIdsFromDir(dataDir: string, subDir: string): Promise<string[]> {
    const targetDir = path.join(dataDir, subDir);
    try {
        const entries = await fsp.readdir(targetDir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function listLegacyClientIds(dataDir: string): Promise<string[]> {
    const [syncClientIds, pushClientIds, requestClientIds, binaryClientIds, snapshotClientIds, patchLogClientIds] = await Promise.all([
        listSyncClientIds(dataDir),
        listPushSubscriptionClientIds(dataDir),
        listClientIdsFromDir(dataDir, 'requests'),
        listClientIdsFromDir(dataDir, 'binaries'),
        listClientIdsBySuffix(dataDir, '.snapshot.json'),
        listClientIdsBySuffix(dataDir, '.patches.log'),
    ]);

    return Array.from(new Set([
        ...syncClientIds,
        ...pushClientIds,
        ...requestClientIds,
        ...binaryClientIds,
        ...snapshotClientIds,
        ...patchLogClientIds,
    ]))
        .sort((a, b) => a.localeCompare(b));
}

function validatePatchContinuity(clientId: string, metadata: SyncMetadata, patches: Patch[]): void {
    if (metadata.patchSeq !== patches.length) {
        throw new Error(
            `[${clientId}] Patch sequence continuity failed: metadata.patchSeq=${metadata.patchSeq} but patches.length=${patches.length}`,
        );
    }

    for (let index = 0; index < patches.length; index += 1) {
        const patch = patches[index];
        if (!patch) {
            continue;
        }
        if (patch.seq !== index) {
            throw new Error(
                `[${clientId}] Patch sequence continuity failed: expected seq=${index}, got seq=${patch.seq}`,
            );
        }
        if (patch.baseSnapshotSeq !== metadata.snapshotSeq) {
            throw new Error(
                `[${clientId}] Patch baseSnapshotSeq mismatch: expected ${metadata.snapshotSeq}, got ${patch.baseSnapshotSeq}`,
            );
        }
    }
}

async function readLegacyPatches(dataDir: string, clientId: string): Promise<Patch[]> {
    const patchLogPath = path.join(dataDir, `${clientId}.patches.log`);
    try {
        const raw = await fsp.readFile(patchLogPath, 'utf8');
        return raw
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => JSON.parse(line) as Patch);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function readLegacyBinaries(dataDir: string, clientId: string): Promise<LegacyBinaryRecord[]> {
    const clientBinaryDir = path.join(dataDir, 'binaries', clientId);
    try {
        const entries = await fsp.readdir(clientBinaryDir, { withFileTypes: true });
        const binaryNames = entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.bin'))
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));

        const out: LegacyBinaryRecord[] = [];
        for (const binaryName of binaryNames) {
            const encodedStorageKey = binaryName.slice(0, -'.bin'.length);
            const metaPath = path.join(clientBinaryDir, `${encodedStorageKey}.meta.json`);
            const meta = await readJsonFile<{ storageKey?: string; mimeType?: string }>(metaPath);
            if (typeof meta.storageKey !== 'string' || typeof meta.mimeType !== 'string') {
                throw new Error(`[${clientId}] Invalid binary meta at ${metaPath}`);
            }
            if (toBase64Url(meta.storageKey) !== encodedStorageKey) {
                throw new Error(
                    `[${clientId}] Binary meta storageKey mismatch at ${metaPath}: expected encoded key ${encodedStorageKey}`,
                );
            }
            const bytes = new Uint8Array(await fsp.readFile(path.join(clientBinaryDir, binaryName)));
            out.push({ storageKey: meta.storageKey, mimeType: meta.mimeType, bytes });
        }

        return out;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function readLegacyRequests(dataDir: string, clientId: string): Promise<LLMRequest[]> {
    const requestDir = path.join(dataDir, 'requests', clientId);
    try {
        const entries = await fsp.readdir(requestDir, { withFileTypes: true });
        const fileNames = entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));

        const requests: LLMRequest[] = [];
        for (const fileName of fileNames) {
            const request = await readJsonFile<LLMRequest>(path.join(requestDir, fileName));
            if (!request.id || !request.clientId) {
                throw new Error(`[${clientId}] Invalid request payload: ${fileName}`);
            }
            if (request.clientId !== clientId) {
                throw new Error(`[${clientId}] Request clientId mismatch in ${fileName}: got ${request.clientId}`);
            }
            requests.push(request);
        }

        requests.sort((a, b) => {
            const byCreated = a.createdAt.localeCompare(b.createdAt);
            if (byCreated !== 0) {
                return byCreated;
            }
            return a.id.localeCompare(b.id);
        });

        return requests;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function readLegacyClientPayload(dataDir: string, clientId: string): Promise<LegacyClientPayload> {
    const metadataPath = path.join(dataDir, `${clientId}.metadata.json`);
    const snapshotPath = path.join(dataDir, `${clientId}.snapshot.json`);
    const subscriptionPath = path.join(dataDir, `${clientId}.json`);

    const [metadata, subscription, binaries, requests] = await Promise.all([
        readOptionalJsonFile<SyncMetadata>(metadataPath),
        readOptionalJsonFile<Record<string, unknown>>(subscriptionPath),
        readLegacyBinaries(dataDir, clientId),
        readLegacyRequests(dataDir, clientId),
    ]);

    if (!metadata) {
        const hasSnapshot = await readOptionalJsonFile<unknown>(snapshotPath);
        const hasPatchLog = (await readLegacyPatches(dataDir, clientId)).length > 0;
        if (hasSnapshot || hasPatchLog) {
            throw new Error(
                `[${clientId}] Legacy sync state is inconsistent: snapshot/patch data exists without metadata`,
            );
        }
    }

    let syncState: LegacyClientPayload['syncState'] = null;
    if (metadata) {
        const [snapshotRaw, patches] = await Promise.all([
            fsp.readFile(snapshotPath, 'utf8'),
            readLegacyPatches(dataDir, clientId),
        ]);
        validatePatchContinuity(clientId, metadata, patches);
        syncState = {
            metadata,
            snapshotRaw,
            patches,
        };
    }

    if (subscription && !isPushSubscriptionObject(subscription)) {
        throw new Error(`[${clientId}] Invalid push subscription payload in ${subscriptionPath}`);
    }

    return {
        clientId,
        syncState,
        subscription,
        binaries,
        requests,
    };
}

function getExistingClientPresence(db: ReturnType<typeof openSqliteDatabase> extends Promise<infer _T> ? any : never, clientId: string): SqliteClientDomainPresence {
    const inClients = Boolean(db.query('SELECT 1 AS v FROM clients WHERE client_id = ? LIMIT 1').get(clientId) as { v?: unknown } | null);
    const inPushSubscriptions = Boolean(db.query('SELECT 1 AS v FROM push_subscriptions WHERE client_id = ? LIMIT 1').get(clientId) as { v?: unknown } | null);
    const inBinaries = Boolean(db.query('SELECT 1 AS v FROM binaries WHERE client_id = ? LIMIT 1').get(clientId) as { v?: unknown } | null);
    const inRequests = Boolean(db.query('SELECT 1 AS v FROM llm_requests WHERE client_id = ? LIMIT 1').get(clientId) as { v?: unknown } | null);
    const inSnapshots = Boolean(db.query('SELECT 1 AS v FROM snapshots WHERE client_id = ? LIMIT 1').get(clientId) as { v?: unknown } | null);
    const inPatches = Boolean(db.query('SELECT 1 AS v FROM patches WHERE client_id = ? LIMIT 1').get(clientId) as { v?: unknown } | null);

    return { inClients, inPushSubscriptions, inBinaries, inRequests, inSnapshots, inPatches };
}

function hasAnyExistingDomainData(presence: SqliteClientDomainPresence): boolean {
    return Object.values(presence).some(Boolean);
}

export async function migrateJsonToSqlite(options: MigrateJsonToSqliteOptions): Promise<MigrationReport> {
    const mode = options.mode ?? 'skip-existing';
    const clientIds = await listLegacyClientIds(options.dataDir);
    const db = await openSqliteDatabase(options.sqlitePath);
    initSqliteSchema(db);

    const report: MigrationReport = {
        mode,
        clientOrder: clientIds,
        migratedClientCount: 0,
        skippedClientCount: 0,
        clients: [],
    };

    try {
        for (const clientId of clientIds) {
            const presence = getExistingClientPresence(db, clientId);
            if (hasAnyExistingDomainData(presence) && mode === 'skip-existing') {
                report.skippedClientCount += 1;
                report.clients.push({
                    clientId,
                    status: 'skipped',
                    patchCount: 0,
                    requestCount: 0,
                    binaryCount: 0,
                });
                continue;
            }

            const payload = await readLegacyClientPayload(options.dataDir, clientId);
            const tx = db.transaction((legacy: LegacyClientPayload) => {
                if (hasAnyExistingDomainData(presence) && mode === 'replace-client') {
                    db.query('DELETE FROM patches WHERE client_id = ?').run(legacy.clientId);
                    db.query('DELETE FROM snapshots WHERE client_id = ?').run(legacy.clientId);
                    db.query('DELETE FROM clients WHERE client_id = ?').run(legacy.clientId);
                    db.query('DELETE FROM push_subscriptions WHERE client_id = ?').run(legacy.clientId);
                    db.query('DELETE FROM binaries WHERE client_id = ?').run(legacy.clientId);
                    db.query('DELETE FROM llm_requests WHERE client_id = ?').run(legacy.clientId);
                }

                if (legacy.syncState) {
                    db.query(
                        `INSERT INTO clients (client_id, metadata_json, updated_at)
                         VALUES (?, ?, ?)
                         ON CONFLICT(client_id) DO UPDATE
                         SET metadata_json = excluded.metadata_json,
                             updated_at = excluded.updated_at`,
                    ).run(legacy.clientId, JSON.stringify(legacy.syncState.metadata), Date.now());

                    db.query(
                        `INSERT INTO snapshots (client_id, snapshot_seq, data_json, created_at)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT(client_id, snapshot_seq) DO UPDATE
                         SET data_json = excluded.data_json,
                             created_at = excluded.created_at`,
                    ).run(legacy.clientId, legacy.syncState.metadata.snapshotSeq, legacy.syncState.snapshotRaw, Date.now());

                    for (const patch of legacy.syncState.patches) {
                        db.query(
                            `INSERT INTO patches (client_id, seq, base_snapshot_seq, data_json, created_at)
                             VALUES (?, ?, ?, ?, ?)
                             ON CONFLICT(client_id, seq) DO UPDATE
                             SET base_snapshot_seq = excluded.base_snapshot_seq,
                                 data_json = excluded.data_json,
                                 created_at = excluded.created_at`,
                        ).run(legacy.clientId, patch.seq, patch.baseSnapshotSeq, JSON.stringify(patch), patch.timestamp);
                    }
                }

                if (legacy.subscription) {
                    db.query(
                        `INSERT INTO push_subscriptions (client_id, data_json, updated_at)
                         VALUES (?, ?, ?)
                         ON CONFLICT(client_id) DO UPDATE
                         SET data_json = excluded.data_json,
                             updated_at = excluded.updated_at`,
                    ).run(legacy.clientId, JSON.stringify(legacy.subscription), Date.now());
                }

                for (const binary of legacy.binaries) {
                    db.query(
                        `INSERT INTO binaries (client_id, storage_key, mime_type, data_blob, updated_at)
                         VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT(client_id, storage_key) DO UPDATE
                         SET mime_type = excluded.mime_type,
                             data_blob = excluded.data_blob,
                             updated_at = excluded.updated_at`,
                    ).run(legacy.clientId, binary.storageKey, binary.mimeType, binary.bytes, Date.now());
                }

                for (const request of legacy.requests) {
                    db.query(
                        `INSERT INTO llm_requests (id, client_id, room_id, status, created_at, completed_at, data_json)
                         VALUES (?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE
                         SET client_id = excluded.client_id,
                             room_id = excluded.room_id,
                             status = excluded.status,
                             created_at = excluded.created_at,
                             completed_at = excluded.completed_at,
                             data_json = excluded.data_json`,
                    ).run(
                        request.id,
                        request.clientId,
                        request.roomId,
                        request.status,
                        request.createdAt,
                        request.completedAt ?? null,
                        JSON.stringify(request),
                    );
                }
            });

            tx.immediate(payload);

            report.migratedClientCount += 1;
            report.clients.push({
                clientId,
                status: 'migrated',
                patchCount: payload.syncState?.patches.length ?? 0,
                requestCount: payload.requests.length,
                binaryCount: payload.binaries.length,
            });

            console.log(
                `[migrate-json-to-sqlite] client=${clientId} status=migrated patches=${payload.syncState?.patches.length ?? 0} requests=${payload.requests.length} binaries=${payload.binaries.length} metadataDigest=${payload.syncState ? digestJson(payload.syncState.metadata) : 'none'} subscription=${payload.subscription ? 'present' : 'absent'}`,
            );
        }

        return report;
    } finally {
        db.close(false);
    }
}

if (import.meta.main) {
    migrateJsonToSqlite(parseArgs(process.argv.slice(2)))
        .then(report => {
            console.log(
                `[migrate-json-to-sqlite] completed mode=${report.mode} migrated=${report.migratedClientCount} skipped=${report.skippedClientCount}`,
            );
        })
        .catch(error => {
            console.error('[migrate-json-to-sqlite] failed', error);
            process.exitCode = 1;
        });
}
