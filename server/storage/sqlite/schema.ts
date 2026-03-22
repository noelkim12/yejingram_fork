import type { SqliteDatabase } from './client';

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS snapshots (
        client_id TEXT NOT NULL,
        snapshot_seq INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, snapshot_seq)
    );`,
    `CREATE TABLE IF NOT EXISTS patches (
        client_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        base_snapshot_seq INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, seq)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_patches_client_base_seq
        ON patches (client_id, base_snapshot_seq, seq);`,
    `CREATE TABLE IF NOT EXISTS llm_requests (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        data_json TEXT NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_llm_requests_client_status_created
        ON llm_requests (client_id, status, created_at);`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
        client_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS binaries (
        client_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        data_blob BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, storage_key)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_binaries_client
        ON binaries (client_id);`,
] as const;

export function initSqliteSchema(db: SqliteDatabase): void {
    const transaction = db.transaction((statements: readonly string[]) => {
        for (const statement of statements) {
            db.exec(statement);
        }
    });

    transaction.immediate(SCHEMA_STATEMENTS);
}
