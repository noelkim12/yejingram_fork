import { promises as fsp } from 'fs';
import path from 'path';

interface SqliteQuery {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
    exec(sql: string): void;
    query(sql: string): SqliteQuery;
    transaction<TArgs extends unknown[]>(
        callback: (...args: TArgs) => void,
    ): ((...args: TArgs) => void) & { immediate: (...args: TArgs) => void };
    close(throwOnError?: boolean): void;
}

interface SqliteDatabaseConstructor {
    new(filename: string, options?: { create?: boolean }): SqliteDatabase;
}

async function loadSqliteDatabaseConstructor(): Promise<SqliteDatabaseConstructor> {
    const dynamicImport = new Function('return import("bun:sqlite")') as () => Promise<{
        Database: SqliteDatabaseConstructor;
    }>;
    const sqliteModule = await dynamicImport();
    return sqliteModule.Database;
}

export function configureSqlitePragmas(db: SqliteDatabase): void {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
}

export async function openSqliteDatabase(databasePath: string): Promise<SqliteDatabase> {
    await fsp.mkdir(path.dirname(databasePath), { recursive: true });
    const Database = await loadSqliteDatabaseConstructor();
    const db = new Database(databasePath, { create: true });
    configureSqlitePragmas(db);
    return db;
}
