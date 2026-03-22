import type { LLMRequest } from '../../types';
import type {
    BinaryRecord,
    BinaryStorage,
    PushSubscriptionStorage,
    QueueStorage,
    StorageAdapter,
    SyncStorage,
} from '../types';
import type { Patch, ServerState, SyncMetadata } from '../../../src/entities/sync/types';
import { openSqliteDatabase, type SqliteDatabase } from './client';
import { initSqliteSchema } from './schema';

interface SqliteStorageAdapterOptions {
    databasePath?: string;
    db?: SqliteDatabase;
}

function parseJsonOrThrow<T>(value: unknown): T {
    if (typeof value !== 'string') {
        throw new Error('Expected sqlite JSON column to be a string');
    }

    return JSON.parse(value) as T;
}

class SqliteSyncStorage implements SyncStorage {
    constructor(private readonly getDb: () => SqliteDatabase) { }

    async readMetadata(clientId: string): Promise<SyncMetadata | null> {
        const row = this.getDb().query(
            'SELECT metadata_json FROM clients WHERE client_id = ?',
        ).get(clientId) as { metadata_json?: unknown } | null;

        if (!row || row.metadata_json == null) {
            return null;
        }

        return parseJsonOrThrow<SyncMetadata>(row.metadata_json);
    }

    async writeMetadata(clientId: string, metadata: SyncMetadata): Promise<void> {
        this.getDb().query(
            `INSERT INTO clients (client_id, metadata_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(client_id) DO UPDATE
             SET metadata_json = excluded.metadata_json,
                 updated_at = excluded.updated_at`,
        ).run(clientId, JSON.stringify(metadata), Date.now());
    }

    async readSnapshot(clientId: string): Promise<string | null> {
        const metadata = await this.readMetadata(clientId);
        if (!metadata) {
            return null;
        }

        const row = this.getDb().query(
            `SELECT data_json
             FROM snapshots
             WHERE client_id = ? AND snapshot_seq = ?
             LIMIT 1`,
        ).get(clientId, metadata.snapshotSeq) as { data_json?: unknown } | null;

        if (!row || typeof row.data_json !== 'string') {
            return null;
        }

        return row.data_json;
    }

    async writeSnapshot(clientId: string, snapshot: string, snapshotSeq: number): Promise<void> {
        this.getDb().query(
            `INSERT INTO snapshots (client_id, snapshot_seq, data_json, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(client_id, snapshot_seq) DO UPDATE
             SET data_json = excluded.data_json,
                 created_at = excluded.created_at`,
        ).run(clientId, snapshotSeq, snapshot, Date.now());
    }

    async readPatchLog(clientId: string): Promise<Patch[]> {
        const rows = this.getDb().query(
            `SELECT data_json
             FROM patches
             WHERE client_id = ?
             ORDER BY seq ASC`,
        ).all(clientId) as Array<{ data_json?: unknown }>;

        return rows
            .filter(row => typeof row.data_json === 'string')
            .map(row => parseJsonOrThrow<Patch>(row.data_json));
    }

    async appendPatch(clientId: string, patch: Patch): Promise<void> {
        this.getDb().query(
            `INSERT OR REPLACE INTO patches (client_id, seq, base_snapshot_seq, data_json, created_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(clientId, patch.seq, patch.baseSnapshotSeq, JSON.stringify(patch), Date.now());
    }

    async resetPatchLog(clientId: string): Promise<void> {
        this.getDb().query('DELETE FROM patches WHERE client_id = ?').run(clientId);
    }

    async commitPatch(clientId: string, patch: Patch, metadata: SyncMetadata): Promise<void> {
        const db = this.getDb();
        const writeTransaction = db.transaction((txClientId: string, txPatch: Patch, txMetadata: SyncMetadata) => {
            db.query(
                `INSERT OR REPLACE INTO patches (client_id, seq, base_snapshot_seq, data_json, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
            ).run(txClientId, txPatch.seq, txPatch.baseSnapshotSeq, JSON.stringify(txPatch), Date.now());

            db.query(
                `INSERT INTO clients (client_id, metadata_json, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(client_id) DO UPDATE
                 SET metadata_json = excluded.metadata_json,
                     updated_at = excluded.updated_at`,
            ).run(txClientId, JSON.stringify(txMetadata), Date.now());
        });

        writeTransaction.immediate(clientId, patch, metadata);
    }

    async replaceState(
        clientId: string,
        payload: {
            snapshot: string;
            metadata: SyncMetadata;
            clearBinaries?: boolean;
        },
    ): Promise<void> {
        const db = this.getDb();
        const replaceTransaction = db.transaction((txClientId: string, txPayload: typeof payload) => {
            db.query(
                `INSERT INTO snapshots (client_id, snapshot_seq, data_json, created_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(client_id, snapshot_seq) DO UPDATE
                 SET data_json = excluded.data_json,
                     created_at = excluded.created_at`,
            ).run(txClientId, txPayload.metadata.snapshotSeq, txPayload.snapshot, Date.now());

            db.query(
                `INSERT INTO clients (client_id, metadata_json, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(client_id) DO UPDATE
                 SET metadata_json = excluded.metadata_json,
                     updated_at = excluded.updated_at`,
            ).run(txClientId, JSON.stringify(txPayload.metadata), Date.now());

            db.query('DELETE FROM patches WHERE client_id = ?').run(txClientId);

            if (txPayload.clearBinaries) {
                db.query('DELETE FROM binaries WHERE client_id = ?').run(txClientId);
            }
        });

        replaceTransaction.immediate(clientId, payload);
    }

    async readState(clientId: string): Promise<ServerState | null> {
        const metadata = await this.readMetadata(clientId);
        if (!metadata) {
            return null;
        }

        return {
            metadata,
            patches: await this.readPatchLog(clientId),
        };
    }
}

class SqliteQueueStorage implements QueueStorage {
    constructor(private readonly getDb: () => SqliteDatabase) { }

    async enqueue(request: LLMRequest): Promise<void> {
        this.getDb().query(
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

    async getPending(): Promise<LLMRequest[]> {
        const rows = this.getDb().query(
            `SELECT data_json
             FROM llm_requests
             WHERE status = 'pending'
             ORDER BY created_at ASC`,
        ).all() as Array<{ data_json?: unknown }>;

        return rows
            .filter(row => typeof row.data_json === 'string')
            .map(row => parseJsonOrThrow<LLMRequest>(row.data_json));
    }

    async dequeuePendingByClient(clientId: string): Promise<LLMRequest | null> {
        const row = this.getDb().query(
            `SELECT data_json
             FROM llm_requests
             WHERE client_id = ? AND status = 'pending'
             ORDER BY created_at ASC
             LIMIT 1`,
        ).get(clientId) as { data_json?: unknown } | null;

        if (!row || row.data_json == null) {
            return null;
        }

        return parseJsonOrThrow<LLMRequest>(row.data_json);
    }

    async recoverProcessingToPending(): Promise<void> {
        this.getDb().query(
            `UPDATE llm_requests
             SET status = 'pending',
                 data_json = json_set(data_json, '$.status', 'pending')
             WHERE status = 'processing'`,
        ).run();
    }

    async getByClientId(clientId: string): Promise<LLMRequest[]> {
        const rows = this.getDb().query(
            `SELECT data_json
             FROM llm_requests
             WHERE client_id = ?
             ORDER BY created_at ASC`,
        ).all(clientId) as Array<{ data_json?: unknown }>;

        return rows
            .filter(row => typeof row.data_json === 'string')
            .map(row => parseJsonOrThrow<LLMRequest>(row.data_json));
    }

    async findRequestById(requestId: string): Promise<LLMRequest | null> {
        const row = this.getDb().query(
            'SELECT data_json FROM llm_requests WHERE id = ?',
        ).get(requestId) as { data_json?: unknown } | null;

        if (!row || row.data_json == null) {
            return null;
        }

        return parseJsonOrThrow<LLMRequest>(row.data_json);
    }

    async update(request: LLMRequest): Promise<void> {
        await this.enqueue(request);
    }

    async delete(requestId: string): Promise<void> {
        this.getDb().query('DELETE FROM llm_requests WHERE id = ?').run(requestId);
    }
}

class SqlitePushSubscriptionStorage implements PushSubscriptionStorage {
    constructor(private readonly getDb: () => SqliteDatabase) { }

    async read(clientId: string): Promise<Record<string, unknown> | null> {
        const row = this.getDb().query(
            'SELECT data_json FROM push_subscriptions WHERE client_id = ?',
        ).get(clientId) as { data_json?: unknown } | null;

        if (!row || row.data_json == null) {
            return null;
        }

        return parseJsonOrThrow<Record<string, unknown>>(row.data_json);
    }

    async readAll(): Promise<Record<string, Record<string, unknown>>> {
        const rows = this.getDb().query(
            'SELECT client_id, data_json FROM push_subscriptions',
        ).all() as Array<{ client_id?: unknown; data_json?: unknown }>;

        const out: Record<string, Record<string, unknown>> = {};
        for (const row of rows) {
            if (typeof row.client_id !== 'string' || typeof row.data_json !== 'string') {
                continue;
            }

            out[row.client_id] = parseJsonOrThrow<Record<string, unknown>>(row.data_json);
        }

        return out;
    }

    async save(clientId: string, subscription: Record<string, unknown>): Promise<void> {
        this.getDb().query(
            `INSERT INTO push_subscriptions (client_id, data_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(client_id) DO UPDATE
             SET data_json = excluded.data_json,
                 updated_at = excluded.updated_at`,
        ).run(clientId, JSON.stringify(subscription), Date.now());
    }

    async delete(clientId: string): Promise<boolean> {
        const result = this.getDb().query('DELETE FROM push_subscriptions WHERE client_id = ?').run(clientId) as {
            changes?: number;
        };
        return (result.changes ?? 0) > 0;
    }
}

class SqliteBinaryStorage implements BinaryStorage {
    constructor(private readonly getDb: () => SqliteDatabase) { }

    async put(clientId: string, storageKey: string, mimeType: string, data: Uint8Array): Promise<void> {
        this.getDb().query(
            `INSERT INTO binaries (client_id, storage_key, mime_type, data_blob, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(client_id, storage_key) DO UPDATE
             SET mime_type = excluded.mime_type,
                 data_blob = excluded.data_blob,
                 updated_at = excluded.updated_at`,
        ).run(clientId, storageKey, mimeType, data, Date.now());
    }

    async get(clientId: string, storageKey: string): Promise<BinaryRecord | null> {
        const row = this.getDb().query(
            `SELECT mime_type, data_blob, updated_at
             FROM binaries
             WHERE client_id = ? AND storage_key = ?`,
        ).get(clientId, storageKey) as {
            mime_type?: unknown;
            data_blob?: unknown;
            updated_at?: unknown;
        } | null;

        if (!row) {
            return null;
        }

        if (typeof row.mime_type !== 'string' || !(row.data_blob instanceof Uint8Array)) {
            throw new Error('Unexpected binary row shape from sqlite');
        }

        return {
            storageKey,
            mimeType: row.mime_type,
            data: row.data_blob,
            updatedAt: typeof row.updated_at === 'number' ? row.updated_at : Date.now(),
        };
    }

    async delete(clientId: string, storageKey: string): Promise<void> {
        this.getDb().query(
            'DELETE FROM binaries WHERE client_id = ? AND storage_key = ?',
        ).run(clientId, storageKey);
    }

    async clearClient(clientId: string): Promise<void> {
        this.getDb().query('DELETE FROM binaries WHERE client_id = ?').run(clientId);
    }
}

export class SqliteStorageAdapter implements StorageAdapter {
    readonly backend = 'sqlite' as const;
    readonly sync: SyncStorage;
    readonly queue: QueueStorage;
    readonly pushSubscriptions: PushSubscriptionStorage;
    readonly binaries: BinaryStorage;

    private db: SqliteDatabase | null;
    private readonly ownsDb: boolean;

    constructor(private readonly options: SqliteStorageAdapterOptions = {}) {
        this.db = options.db ?? null;
        this.ownsDb = !options.db;
        this.sync = new SqliteSyncStorage(() => this.requireDb());
        this.queue = new SqliteQueueStorage(() => this.requireDb());
        this.pushSubscriptions = new SqlitePushSubscriptionStorage(() => this.requireDb());
        this.binaries = new SqliteBinaryStorage(() => this.requireDb());
    }

    private requireDb(): SqliteDatabase {
        if (!this.db) {
            throw new Error('SQLite database is not initialized');
        }

        return this.db;
    }

    async init(): Promise<void> {
        if (!this.db) {
            const databasePath = this.options.databasePath;
            if (!databasePath) {
                throw new Error('databasePath is required when db is not provided');
            }

            this.db = await openSqliteDatabase(databasePath);
        }

        initSqliteSchema(this.db);
    }

    close(): void {
        if (this.db && this.ownsDb) {
            this.db.close(false);
            this.db = null;
        }
    }
}
