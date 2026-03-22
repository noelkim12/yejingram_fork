import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Patch, SyncMetadata } from '../../src/entities/sync/types';
import type { LLMRequest } from '../types';
import { openSqliteDatabase } from '../storage/sqlite/client';
import { initSqliteSchema } from '../storage/sqlite/schema';

export interface ExportSqliteToJsonOptions {
    sqlitePath: string;
    outputDataDir: string;
}

export interface ExportClientSummary {
    clientId: string;
    patchCount: number;
    requestCount: number;
    binaryCount: number;
}

export interface ExportSqliteToJsonReport {
    clientCount: number;
    clients: ExportClientSummary[];
}

function toBase64Url(input: string): string {
    return Buffer.from(input, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function parseArgs(argv: string[]): ExportSqliteToJsonOptions {
    let outputDataDir = path.resolve(process.cwd(), 'data-export');
    let sqlitePath = path.resolve(process.cwd(), 'data', 'yejingram.db');

    for (const arg of argv) {
        if (arg.startsWith('--output-data-dir=')) {
            outputDataDir = path.resolve(arg.slice('--output-data-dir='.length));
            continue;
        }
        if (arg.startsWith('--sqlite-path=')) {
            sqlitePath = path.resolve(arg.slice('--sqlite-path='.length));
            continue;
        }
    }

    return { sqlitePath, outputDataDir };
}

async function ensureCleanOutputDir(outputDataDir: string): Promise<void> {
    await fsp.rm(outputDataDir, { recursive: true, force: true });
    await fsp.mkdir(outputDataDir, { recursive: true });
    await fsp.mkdir(path.join(outputDataDir, 'requests'), { recursive: true });
    await fsp.mkdir(path.join(outputDataDir, 'binaries'), { recursive: true });
}

export async function exportSqliteToJson(options: ExportSqliteToJsonOptions): Promise<ExportSqliteToJsonReport> {
    const db = await openSqliteDatabase(options.sqlitePath);
    initSqliteSchema(db);

    await ensureCleanOutputDir(options.outputDataDir);

    try {
        const clientRows = db.query('SELECT client_id, metadata_json FROM clients ORDER BY client_id ASC').all() as Array<{ client_id?: unknown; metadata_json?: unknown }>;
        const pushRows = db.query('SELECT client_id FROM push_subscriptions ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;
        const requestRows = db.query('SELECT DISTINCT client_id FROM llm_requests ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;
        const binaryRowsByClient = db.query('SELECT DISTINCT client_id FROM binaries ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;
        const snapshotRows = db.query('SELECT DISTINCT client_id FROM snapshots ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;
        const patchRows = db.query('SELECT DISTINCT client_id FROM patches ORDER BY client_id ASC').all() as Array<{ client_id?: unknown }>;

        const clientIds = Array.from(
            new Set([
                ...clientRows.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
                ...pushRows.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
                ...requestRows.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
                ...binaryRowsByClient.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
                ...snapshotRows.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
                ...patchRows.map(row => row.client_id).filter((id): id is string => typeof id === 'string'),
            ]),
        ).sort((a, b) => a.localeCompare(b));
        const metadataByClient = new Map(
            clientRows
                .filter(row => typeof row.client_id === 'string' && typeof row.metadata_json === 'string')
                .map(row => [row.client_id as string, row.metadata_json as string]),
        );

        const summaries: ExportClientSummary[] = [];

        for (const clientId of clientIds) {
            const metadataRaw = metadataByClient.get(clientId);
            let patches: Patch[] = [];

            if (metadataRaw) {
                const metadata = JSON.parse(metadataRaw) as SyncMetadata;
                const metadataPath = path.join(options.outputDataDir, `${clientId}.metadata.json`);
                await fsp.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

                const snapshotRow = db.query(
                    `SELECT data_json
                     FROM snapshots
                     WHERE client_id = ? AND snapshot_seq = ?
                     LIMIT 1`,
                ).get(clientId, metadata.snapshotSeq) as { data_json?: unknown } | null;

                if (!snapshotRow || typeof snapshotRow.data_json !== 'string') {
                    throw new Error(`Missing snapshot row for client=${clientId} snapshotSeq=${metadata.snapshotSeq}`);
                }

                await fsp.writeFile(path.join(options.outputDataDir, `${clientId}.snapshot.json`), snapshotRow.data_json);

                const patchRows = db.query(
                    'SELECT data_json FROM patches WHERE client_id = ? ORDER BY seq ASC',
                ).all(clientId) as Array<{ data_json?: unknown }>;
                patches = patchRows
                    .map(patchRow => patchRow.data_json)
                    .filter((raw): raw is string => typeof raw === 'string')
                    .map(raw => JSON.parse(raw) as Patch);
                const patchLog = patches.map(patch => JSON.stringify(patch)).join('\n');
                await fsp.writeFile(
                    path.join(options.outputDataDir, `${clientId}.patches.log`),
                    patchLog.length > 0 ? `${patchLog}\n` : '',
                );
            }

            const subscriptionRow = db.query(
                'SELECT data_json FROM push_subscriptions WHERE client_id = ?',
            ).get(clientId) as { data_json?: unknown } | null;
            if (subscriptionRow && typeof subscriptionRow.data_json === 'string') {
                await fsp.writeFile(
                    path.join(options.outputDataDir, `${clientId}.json`),
                    JSON.stringify(JSON.parse(subscriptionRow.data_json), null, 2),
                );
            }

            const binaryRows = db.query(
                'SELECT storage_key, mime_type, data_blob FROM binaries WHERE client_id = ? ORDER BY storage_key ASC',
            ).all(clientId) as Array<{ storage_key?: unknown; mime_type?: unknown; data_blob?: unknown }>;
            const clientBinaryDir = path.join(options.outputDataDir, 'binaries', clientId);
            await fsp.mkdir(clientBinaryDir, { recursive: true });

            for (const binaryRow of binaryRows) {
                if (
                    typeof binaryRow.storage_key !== 'string'
                    || typeof binaryRow.mime_type !== 'string'
                    || !(binaryRow.data_blob instanceof Uint8Array)
                ) {
                    continue;
                }

                const encodedKey = toBase64Url(binaryRow.storage_key);
                await fsp.writeFile(path.join(clientBinaryDir, `${encodedKey}.bin`), Buffer.from(binaryRow.data_blob));
                await fsp.writeFile(
                    path.join(clientBinaryDir, `${encodedKey}.meta.json`),
                    JSON.stringify({ storageKey: binaryRow.storage_key, mimeType: binaryRow.mime_type }, null, 2),
                );
            }

            const requestRows = db.query(
                'SELECT id, data_json FROM llm_requests WHERE client_id = ? ORDER BY created_at ASC, id ASC',
            ).all(clientId) as Array<{ id?: unknown; data_json?: unknown }>;
            const requestDir = path.join(options.outputDataDir, 'requests', clientId);
            await fsp.mkdir(requestDir, { recursive: true });
            const requests: LLMRequest[] = [];
            for (const requestRow of requestRows) {
                if (typeof requestRow.id !== 'string' || typeof requestRow.data_json !== 'string') {
                    continue;
                }
                const request = JSON.parse(requestRow.data_json) as LLMRequest;
                requests.push(request);
                await fsp.writeFile(path.join(requestDir, `${requestRow.id}.json`), JSON.stringify(request, null, 2));
            }

            if (!metadataRaw && (patches.length > 0)) {
                throw new Error(`Inconsistent sqlite state: client=${clientId} has patches but no metadata row`);
            }

            summaries.push({
                clientId,
                patchCount: patches.length,
                requestCount: requests.length,
                binaryCount: binaryRows.length,
            });
            console.log(
                `[export-sqlite-to-json] client=${clientId} patches=${patches.length} requests=${requests.length} binaries=${binaryRows.length} subscription=${subscriptionRow ? 'present' : 'absent'}`,
            );
        }

        return {
            clientCount: summaries.length,
            clients: summaries,
        };
    } finally {
        db.close(false);
    }
}

if (import.meta.main) {
    exportSqliteToJson(parseArgs(process.argv.slice(2)))
        .then(report => {
            console.log(`[export-sqlite-to-json] completed clients=${report.clientCount}`);
        })
        .catch(error => {
            console.error('[export-sqlite-to-json] failed', error);
            process.exitCode = 1;
        });
}
