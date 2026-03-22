import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { openSqliteDatabase } from '../storage/sqlite/client';
import { initSqliteSchema } from '../storage/sqlite/schema';
import type { Patch, SyncMetadata } from '../../src/entities/sync/types';
import type { LLMRequest } from '../types';

export interface VerifySqliteMigrationOptions {
    dataDir: string;
    sqlitePath: string;
}

export interface VerificationMismatch {
    clientId: string;
    category: 'metadata' | 'snapshot-digest' | 'patch-count' | 'patch-digest' | 'request-count' | 'request-digest' | 'binary-count' | 'binary-bytes' | 'binary-digest' | 'push-subscription' | 'client-presence';
    expected: string | number;
    actual: string | number;
    message: string;
}

export interface VerificationReport {
    ok: boolean;
    checkedClients: number;
    mismatches: VerificationMismatch[];
}

interface LegacyBinaryDigestRecord {
    storageKey: string;
    mimeType: string;
    bytes: Uint8Array;
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

function parseArgs(argv: string[]): VerifySqliteMigrationOptions {
    let dataDir = path.resolve(process.cwd(), 'data');
    let sqlitePath = path.join(dataDir, 'yejingram.db');

    for (const arg of argv) {
        if (arg.startsWith('--data-dir=')) {
            dataDir = path.resolve(arg.slice('--data-dir='.length));
            sqlitePath = path.join(dataDir, 'yejingram.db');
            continue;
        }
        if (arg.startsWith('--sqlite-path=')) {
            sqlitePath = path.resolve(arg.slice('--sqlite-path='.length));
        }
    }

    return { dataDir, sqlitePath };
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`;
}

function sha256(input: string | Uint8Array): string {
    return createHash('sha256').update(input).digest('hex');
}

async function readJsonFile<T>(filePath: string): Promise<T> {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
}

async function listLegacyClientIds(dataDir: string): Promise<string[]> {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true });
    const metadataClientIds = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.metadata.json'))
        .map(entry => entry.name.slice(0, -'.metadata.json'.length));
    const snapshotClientIds = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.snapshot.json'))
        .map(entry => entry.name.slice(0, -'.snapshot.json'.length));
    const patchClientIds = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.patches.log'))
        .map(entry => entry.name.slice(0, -'.patches.log'.length));

    const pushClientIds = new Set<string>();
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }
        if (entry.name.endsWith('.metadata.json') || entry.name.endsWith('.snapshot.json') || entry.name.endsWith('.meta.json')) {
            continue;
        }

        const payload = await readJsonFile<unknown>(path.join(dataDir, entry.name));
        if (isPushSubscriptionObject(payload)) {
            pushClientIds.add(entry.name.slice(0, -'.json'.length));
        }
    }

    const requestClientIds = await listClientIdsFromDir(dataDir, 'requests');
    const binaryClientIds = await listClientIdsFromDir(dataDir, 'binaries');

    return Array.from(new Set([
        ...metadataClientIds,
        ...snapshotClientIds,
        ...patchClientIds,
        ...pushClientIds,
        ...requestClientIds,
        ...binaryClientIds,
    ])).sort((a, b) => a.localeCompare(b));
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

async function readLegacyMetadata(dataDir: string, clientId: string): Promise<SyncMetadata | null> {
    try {
        return await readJsonFile<SyncMetadata>(path.join(dataDir, `${clientId}.metadata.json`));
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function readLegacySnapshot(dataDir: string, clientId: string): Promise<unknown | null> {
    try {
        return await readJsonFile<unknown>(path.join(dataDir, `${clientId}.snapshot.json`));
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function readLegacyPushSubscription(dataDir: string, clientId: string): Promise<Record<string, unknown> | null> {
    try {
        const payload = await readJsonFile<unknown>(path.join(dataDir, `${clientId}.json`));
        if (!isPushSubscriptionObject(payload)) {
            throw new Error(`[${clientId}] invalid push subscription payload`);
        }
        return payload;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
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

async function readLegacyRequests(dataDir: string, clientId: string): Promise<LLMRequest[]> {
    const requestDir = path.join(dataDir, 'requests', clientId);
    try {
        const entries = await fsp.readdir(requestDir, { withFileTypes: true });
        const names = entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));
        const requests: LLMRequest[] = [];
        for (const name of names) {
            requests.push(await readJsonFile<LLMRequest>(path.join(requestDir, name)));
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

async function readLegacyBinaries(dataDir: string, clientId: string): Promise<LegacyBinaryDigestRecord[]> {
    const clientDir = path.join(dataDir, 'binaries', clientId);
    try {
        const entries = await fsp.readdir(clientDir, { withFileTypes: true });
        const names = entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.meta.json'))
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));
        const out: LegacyBinaryDigestRecord[] = [];
        for (const metaName of names) {
            const encodedKey = metaName.slice(0, -'.meta.json'.length);
            const meta = await readJsonFile<{ storageKey?: string; mimeType?: string }>(path.join(clientDir, metaName));
            if (typeof meta.storageKey !== 'string' || typeof meta.mimeType !== 'string') {
                throw new Error(`[${clientId}] Invalid binary metadata ${metaName}`);
            }
            const binPath = path.join(clientDir, `${encodedKey}.bin`);
            const bytes = new Uint8Array(await fsp.readFile(binPath));
            out.push({ storageKey: meta.storageKey, mimeType: meta.mimeType, bytes });
        }
        out.sort((a, b) => a.storageKey.localeCompare(b.storageKey));
        return out;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

function digestPatches(patches: Patch[]): string {
    return sha256(stableStringify(patches));
}

function digestRequests(requests: LLMRequest[]): string {
    return sha256(stableStringify(requests));
}

function digestBinaries(binaries: LegacyBinaryDigestRecord[]): string {
    const chunks: string[] = [];
    for (const binary of binaries) {
        chunks.push(`${binary.storageKey}\n${binary.mimeType}\n${binary.bytes.byteLength}\n${sha256(binary.bytes)}`);
    }
    return sha256(chunks.join('\n---\n'));
}

export async function verifySqliteMigration(options: VerifySqliteMigrationOptions): Promise<VerificationReport> {
    const db = await openSqliteDatabase(options.sqlitePath);
    initSqliteSchema(db);

    try {
        const legacyClientIds = await listLegacyClientIds(options.dataDir);
        const sqliteClientRows = db.query('SELECT client_id FROM clients ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;
        const sqlitePushRows = db.query('SELECT client_id FROM push_subscriptions ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;
        const sqliteRequestRows = db.query('SELECT DISTINCT client_id FROM llm_requests ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;
        const sqliteBinaryRows = db.query('SELECT DISTINCT client_id FROM binaries ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;
        const sqliteSnapshotRows = db.query('SELECT DISTINCT client_id FROM snapshots ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;
        const sqlitePatchRowsAll = db.query('SELECT DISTINCT client_id FROM patches ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;
        const sqliteClientIds = Array.from(new Set([
            ...sqliteClientRows.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
            ...sqlitePushRows.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
            ...sqliteRequestRows.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
            ...sqliteBinaryRows.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
            ...sqliteSnapshotRows.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
            ...sqlitePatchRowsAll.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
        ])).sort((a, b) => a.localeCompare(b));

        const mismatches: VerificationMismatch[] = [];

        for (const sqliteClientId of sqliteClientIds) {
            if (!legacyClientIds.includes(sqliteClientId)) {
                mismatches.push({
                    clientId: sqliteClientId,
                    category: 'client-presence',
                    expected: 'missing',
                    actual: 'present-in-sqlite',
                    message: `Client ${sqliteClientId} exists in sqlite domain tables but no legacy client files were found`,
                });
            }
        }

        for (const clientId of legacyClientIds) {
            const snapshot = await readLegacySnapshot(options.dataDir, clientId);
            const patches = await readLegacyPatches(options.dataDir, clientId);
            const requests = await readLegacyRequests(options.dataDir, clientId);
            const binaries = await readLegacyBinaries(options.dataDir, clientId);
            const subscription = await readLegacyPushSubscription(options.dataDir, clientId);
            const legacyMetadata = await readLegacyMetadata(options.dataDir, clientId);

            const metadataRow = db.query('SELECT metadata_json FROM clients WHERE client_id = ?').get(clientId) as { metadata_json?: unknown } | null;
            const sqliteSubscriptionRow = db.query(
                'SELECT data_json FROM push_subscriptions WHERE client_id = ?',
            ).get(clientId) as { data_json?: unknown } | null;

            if (subscription && (!sqliteSubscriptionRow || typeof sqliteSubscriptionRow.data_json !== 'string')) {
                mismatches.push({
                    clientId,
                    category: 'push-subscription',
                    expected: 'present',
                    actual: 'missing',
                    message: `Push subscription missing in sqlite for ${clientId}`,
                });
            } else if (!subscription && sqliteSubscriptionRow && typeof sqliteSubscriptionRow.data_json === 'string') {
                mismatches.push({
                    clientId,
                    category: 'push-subscription',
                    expected: 'missing',
                    actual: 'present',
                    message: `Push subscription unexpectedly present in sqlite for ${clientId}`,
                });
            } else if (subscription && sqliteSubscriptionRow && typeof sqliteSubscriptionRow.data_json === 'string') {
                const subscriptionDigestExpected = sha256(stableStringify(subscription));
                const subscriptionDigestActual = sha256(stableStringify(JSON.parse(sqliteSubscriptionRow.data_json)));
                if (subscriptionDigestExpected !== subscriptionDigestActual) {
                    mismatches.push({
                        clientId,
                        category: 'push-subscription',
                        expected: subscriptionDigestExpected,
                        actual: subscriptionDigestActual,
                        message: `Push subscription mismatch for ${clientId}`,
                    });
                }
            }

            if (legacyMetadata && (!metadataRow || typeof metadataRow.metadata_json !== 'string')) {
                mismatches.push({
                    clientId,
                    category: 'client-presence',
                    expected: 'present-in-sqlite',
                    actual: 'missing',
                    message: `Client ${clientId} is missing in sqlite clients table`,
                });
            } else if (!legacyMetadata && metadataRow && typeof metadataRow.metadata_json === 'string') {
                mismatches.push({
                    clientId,
                    category: 'client-presence',
                    expected: 'no-sync-client',
                    actual: 'present-in-sqlite',
                    message: `Client ${clientId} exists in sqlite clients table but has no legacy metadata`,
                });
            } else if (legacyMetadata && metadataRow && typeof metadataRow.metadata_json === 'string') {
                const sqliteMetadata = JSON.parse(metadataRow.metadata_json) as SyncMetadata;
                const metadataExpected = stableStringify(legacyMetadata);
                const metadataActual = stableStringify(sqliteMetadata);
                if (metadataExpected !== metadataActual) {
                    mismatches.push({
                        clientId,
                        category: 'metadata',
                        expected: metadataExpected,
                        actual: metadataActual,
                        message: `Metadata mismatch for ${clientId}`,
                    });
                }

                if (snapshot === null) {
                    mismatches.push({
                        clientId,
                        category: 'snapshot-digest',
                        expected: 'snapshot-present',
                        actual: 'snapshot-missing',
                        message: `Snapshot missing for ${clientId} in legacy files`,
                    });
                } else {
                    const snapshotRow = db.query(
                        'SELECT data_json FROM snapshots WHERE client_id = ? AND snapshot_seq = ? LIMIT 1',
                    ).get(clientId, legacyMetadata.snapshotSeq) as { data_json?: unknown } | null;
                    if (!snapshotRow || typeof snapshotRow.data_json !== 'string') {
                        mismatches.push({
                            clientId,
                            category: 'snapshot-digest',
                            expected: 'snapshot-present',
                            actual: 'snapshot-missing-in-sqlite',
                            message: `Snapshot missing in sqlite for ${clientId} at seq=${legacyMetadata.snapshotSeq}`,
                        });
                    } else {
                        const snapshotDigestExpected = sha256(stableStringify(snapshot));
                        const snapshotDigestActual = sha256(stableStringify(JSON.parse(snapshotRow.data_json)));
                        if (snapshotDigestExpected !== snapshotDigestActual) {
                            mismatches.push({
                                clientId,
                                category: 'snapshot-digest',
                                expected: snapshotDigestExpected,
                                actual: snapshotDigestActual,
                                message: `Snapshot digest mismatch for ${clientId}`,
                            });
                        }
                    }
                }
            }

            const sqlitePatchRows = db.query(
                'SELECT data_json FROM patches WHERE client_id = ? ORDER BY seq ASC',
            ).all(clientId) as Array<{ data_json?: unknown }>;
            const sqlitePatches = sqlitePatchRows
                .map(row => row.data_json)
                .filter((raw): raw is string => typeof raw === 'string')
                .map(raw => JSON.parse(raw) as Patch);

            if (patches.length !== sqlitePatches.length) {
                mismatches.push({
                    clientId,
                    category: 'patch-count',
                    expected: patches.length,
                    actual: sqlitePatches.length,
                    message: `Patch count mismatch for ${clientId}`,
                });
            }

            const patchDigestExpected = digestPatches(patches);
            const patchDigestActual = digestPatches(sqlitePatches);
            if (patchDigestExpected !== patchDigestActual) {
                mismatches.push({
                    clientId,
                    category: 'patch-digest',
                    expected: patchDigestExpected,
                    actual: patchDigestActual,
                    message: `Patch digest mismatch for ${clientId}`,
                });
            }

            const sqliteRequestRows = db.query(
                'SELECT data_json FROM llm_requests WHERE client_id = ? ORDER BY created_at ASC, id ASC',
            ).all(clientId) as Array<{ data_json?: unknown }>;
            const sqliteRequests = sqliteRequestRows
                .map(row => row.data_json)
                .filter((raw): raw is string => typeof raw === 'string')
                .map(raw => JSON.parse(raw) as LLMRequest);

            if (requests.length !== sqliteRequests.length) {
                mismatches.push({
                    clientId,
                    category: 'request-count',
                    expected: requests.length,
                    actual: sqliteRequests.length,
                    message: `LLM request count mismatch for ${clientId}`,
                });
            }

            const requestDigestExpected = digestRequests(requests);
            const requestDigestActual = digestRequests(sqliteRequests);
            if (requestDigestExpected !== requestDigestActual) {
                mismatches.push({
                    clientId,
                    category: 'request-digest',
                    expected: requestDigestExpected,
                    actual: requestDigestActual,
                    message: `LLM request digest mismatch for ${clientId}`,
                });
            }

            const sqliteBinaryRows = db.query(
                'SELECT storage_key, mime_type, data_blob FROM binaries WHERE client_id = ? ORDER BY storage_key ASC',
            ).all(clientId) as Array<{ storage_key?: unknown; mime_type?: unknown; data_blob?: unknown }>;
            const sqliteBinaries: LegacyBinaryDigestRecord[] = sqliteBinaryRows
                .filter(
                    row => typeof row.storage_key === 'string'
                        && typeof row.mime_type === 'string'
                        && row.data_blob instanceof Uint8Array,
                )
                .map(row => ({
                    storageKey: row.storage_key as string,
                    mimeType: row.mime_type as string,
                    bytes: row.data_blob as Uint8Array,
                }));

            if (binaries.length !== sqliteBinaries.length) {
                mismatches.push({
                    clientId,
                    category: 'binary-count',
                    expected: binaries.length,
                    actual: sqliteBinaries.length,
                    message: `Binary count mismatch for ${clientId}`,
                });
            }

            const legacyBinaryBytes = binaries.reduce((sum, binary) => sum + binary.bytes.byteLength, 0);
            const sqliteBinaryBytes = sqliteBinaries.reduce((sum, binary) => sum + binary.bytes.byteLength, 0);
            if (legacyBinaryBytes !== sqliteBinaryBytes) {
                mismatches.push({
                    clientId,
                    category: 'binary-bytes',
                    expected: legacyBinaryBytes,
                    actual: sqliteBinaryBytes,
                    message: `Binary byte total mismatch for ${clientId}`,
                });
            }

            const binaryDigestExpected = digestBinaries(binaries);
            const binaryDigestActual = digestBinaries(sqliteBinaries);
            if (binaryDigestExpected !== binaryDigestActual) {
                mismatches.push({
                    clientId,
                    category: 'binary-digest',
                    expected: binaryDigestExpected,
                    actual: binaryDigestActual,
                    message: `Binary digest mismatch for ${clientId}`,
                });
            }

        }

        return {
            ok: mismatches.length === 0,
            checkedClients: legacyClientIds.length,
            mismatches,
        };
    } finally {
        db.close(false);
    }
}

if (import.meta.main) {
    verifySqliteMigration(parseArgs(process.argv.slice(2)))
        .then(report => {
            if (!report.ok) {
                console.error(`[verify-sqlite-migration] failed mismatches=${report.mismatches.length}`);
                for (const mismatch of report.mismatches) {
                    console.error(
                        `[verify-sqlite-migration] client=${mismatch.clientId} category=${mismatch.category} expected=${mismatch.expected} actual=${mismatch.actual} message=${mismatch.message}`,
                    );
                }
                process.exitCode = 1;
                return;
            }

            console.log(`[verify-sqlite-migration] ok checkedClients=${report.checkedClients}`);
        })
        .catch(error => {
            console.error('[verify-sqlite-migration] failed', error);
            process.exitCode = 1;
        });
}
