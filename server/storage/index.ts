import path from 'path';
import { FileStorageAdapter } from './file-adapter';
import { SqliteStorageAdapter } from './sqlite/adapter';
import type { CreateStorageAdapterOptions, StorageAdapter, StorageBackend } from './types';

let storageSingleton: StorageAdapter | null = null;

export function resolveStorageBackend(rawBackend = process.env.SERVER_STORAGE_BACKEND): StorageBackend {
    return rawBackend === 'sqlite' ? 'sqlite' : 'file';
}

export function createStorageAdapter(options: CreateStorageAdapterOptions): StorageAdapter {
    if (options.backend === 'sqlite') {
        return new SqliteStorageAdapter({ databasePath: options.sqlitePath });
    }

    return new FileStorageAdapter({
        dataDir: options.dataDir,
        binaryDir: options.binaryDir,
    });
}

export async function initializeStorage(options: {
    dataDir: string;
    binaryDir: string;
    backend?: StorageBackend;
    sqlitePath?: string;
}): Promise<StorageAdapter> {
    if (storageSingleton) {
        return storageSingleton;
    }

    const backend = options.backend ?? resolveStorageBackend();
    const sqlitePath = options.sqlitePath ?? path.join(options.dataDir, 'yejingram.db');
    storageSingleton = createStorageAdapter({
        backend,
        dataDir: options.dataDir,
        binaryDir: options.binaryDir,
        sqlitePath,
    });
    await storageSingleton.init();

    return storageSingleton;
}

export function getStorage(): StorageAdapter {
    if (!storageSingleton) {
        throw new Error('Storage has not been initialized');
    }

    return storageSingleton;
}

export function resetStorageForTests(): void {
    storageSingleton?.close();
    storageSingleton = null;
}
