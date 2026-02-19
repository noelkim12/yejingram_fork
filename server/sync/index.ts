import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import syncRouter from './routes';
import { ensureDataDir, PORT, DATA_DIR } from '../index';

interface ApiError extends Error {
    status?: number;
}

/* =====================================================
   Standalone sync server
   Run directly: bun run server/sync/index.ts
===================================================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

app.use('/api', syncRouter);

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
   Startup (only when run directly)
===================================================== */
if (import.meta.main) {
    ensureDataDir().then(() => {
        app.listen(PORT, () => {
            console.log(`[sync-standalone] Listening on port ${PORT}`);
            console.log(`[sync-standalone] Data directory: ${DATA_DIR}`);
            console.log('Press Ctrl+C to stop the server');
        });
    });
}