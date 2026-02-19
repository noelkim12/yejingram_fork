import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { promises as fsp } from 'fs';

interface ApiError extends Error {
    status?: number;
}

/* =====================================================
   App setup
===================================================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

export const PORT = Number(process.env.PORT ?? 3001);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.resolve(process.cwd(), 'data'));
export const BIN_DIR = path.join(DATA_DIR, 'binaries');

/* =====================================================
   Shared state cache & utilities
===================================================== */
export const stateCache = new Map<string, any>();

export function sanitizeClientId(input: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input)) {
        const err: ApiError = new Error('Invalid clientId format');
        err.status = 400;
        throw err;
    }
    return input;
}

export async function ensureDataDir(clientId?: string): Promise<void> {
    if (clientId) {
        const clientDir = path.join(DATA_DIR, sanitizeClientId(clientId));
        await fsp.mkdir(clientDir, { recursive: true });
        await fsp.mkdir(path.join(clientDir, 'patches'), { recursive: true });
    } else {
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.mkdir(BIN_DIR, { recursive: true });
    }
}

/* =====================================================
   Routes (placeholder mount points)
===================================================== */
// Mount points for route groups (will be uncommented in later tasks)
// import syncRouter from './sync/routes';
// import proactiveRouter from './proactive/routes';
// import llmRouter from './llm/routes';
// app.use('/api', syncRouter);
// app.use('/api', proactiveRouter);
// app.use('/api', llmRouter);

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

/* =====================================================
   Error handlers
===================================================== */
app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

app.use((err: ApiError, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error('[Server Error]', err);
    res.status(status).json({ error: err.message ?? 'Internal Server Error' });
});

/* =====================================================
   Startup
===================================================== */
async function start() {
    try {
        await ensureDataDir();
        app.listen(PORT, () => {
            console.log(`[unified-server] Listening on port ${PORT}`);
            console.log(`[unified-server] Data directory: ${DATA_DIR}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();

export default app;
