import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { openSqliteDatabase } from '../storage/sqlite/client';
import { initSqliteSchema } from '../storage/sqlite/schema';

type CheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE';

interface SqliteMaintenanceOptions {
    sqlitePath: string;
    checkpointMode: CheckpointMode;
    vacuum: boolean;
    analyze: boolean;
}

function parseArgs(argv: string[]): SqliteMaintenanceOptions {
    let sqlitePath = path.resolve(process.cwd(), 'data', 'yejingram.db');
    let checkpointMode: CheckpointMode = 'TRUNCATE';
    let vacuum = false;
    let analyze = false;

    for (const arg of argv) {
        if (arg.startsWith('--sqlite-path=')) {
            sqlitePath = path.resolve(arg.slice('--sqlite-path='.length));
            continue;
        }
        if (arg.startsWith('--checkpoint-mode=')) {
            const mode = arg.slice('--checkpoint-mode='.length).toUpperCase();
            if (mode === 'PASSIVE' || mode === 'FULL' || mode === 'RESTART' || mode === 'TRUNCATE') {
                checkpointMode = mode;
                continue;
            }
            throw new Error(`Invalid --checkpoint-mode: ${mode}`);
        }
        if (arg === '--vacuum') {
            vacuum = true;
            continue;
        }
        if (arg === '--analyze') {
            analyze = true;
            continue;
        }
    }

    return { sqlitePath, checkpointMode, vacuum, analyze };
}

async function fileSizeOrZero(filePath: string): Promise<number> {
    try {
        const stats = await fsp.stat(filePath);
        return stats.size;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0;
        }
        throw error;
    }
}

export async function runSqliteMaintenance(options: SqliteMaintenanceOptions): Promise<void> {
    const db = await openSqliteDatabase(options.sqlitePath);
    initSqliteSchema(db);

    try {
        const walPath = `${options.sqlitePath}-wal`;
        const beforeDbSize = await fileSizeOrZero(options.sqlitePath);
        const beforeWalSize = await fileSizeOrZero(walPath);

        const checkpointRows = db.query(`PRAGMA wal_checkpoint(${options.checkpointMode});`).all() as Array<{
            busy?: unknown;
            log?: unknown;
            checkpointed?: unknown;
        }>;

        if (options.vacuum) {
            db.exec('VACUUM;');
        }

        if (options.analyze) {
            db.exec('ANALYZE;');
        }

        const pageCountRow = db.query('PRAGMA page_count;').get() as { page_count?: unknown } | null;
        const freeListRow = db.query('PRAGMA freelist_count;').get() as { freelist_count?: unknown } | null;

        const afterDbSize = await fileSizeOrZero(options.sqlitePath);
        const afterWalSize = await fileSizeOrZero(walPath);
        const checkpoint = checkpointRows[0] ?? {};

        console.log(
            `[sqlite-maintenance] checkpointMode=${options.checkpointMode} checkpointBusy=${checkpoint.busy ?? 'n/a'} walFrames=${checkpoint.log ?? 'n/a'} checkpointedFrames=${checkpoint.checkpointed ?? 'n/a'}`,
        );
        console.log(
            `[sqlite-maintenance] dbSizeBefore=${beforeDbSize} dbSizeAfter=${afterDbSize} walSizeBefore=${beforeWalSize} walSizeAfter=${afterWalSize}`,
        );
        console.log(
            `[sqlite-maintenance] pageCount=${pageCountRow?.page_count ?? 'n/a'} freelistCount=${freeListRow?.freelist_count ?? 'n/a'} vacuum=${options.vacuum} analyze=${options.analyze}`,
        );
    } finally {
        db.close(false);
    }
}

if (import.meta.main) {
    runSqliteMaintenance(parseArgs(process.argv.slice(2)))
        .catch(error => {
            console.error('[sqlite-maintenance] failed', error);
            process.exitCode = 1;
        });
}
