import { Router, type Request, type Response } from 'express';
import { sanitizeClientId } from '../index';

const router = Router();

const connectionsByClientId = new Map<string, Set<Response>>();

function addConnection(clientId: string, res: Response): void {
    const existing = connectionsByClientId.get(clientId);
    if (existing) {
        existing.add(res);
        return;
    }

    connectionsByClientId.set(clientId, new Set([res]));
}

function removeConnection(clientId: string, res: Response): void {
    const existing = connectionsByClientId.get(clientId);
    if (!existing) return;

    existing.delete(res);
    if (existing.size === 0) {
        connectionsByClientId.delete(clientId);
    }
}

export function broadcastLLMComplete(clientId: string, data: Record<string, unknown>): void {
    const existing = connectionsByClientId.get(clientId);
    if (!existing || existing.size === 0) return;

    const payload = `data: ${JSON.stringify({ type: 'llm-complete', ...data })}\n\n`;
    for (const res of existing) {
        try {
            res.write(payload);
        } catch {
            removeConnection(clientId, res);
        }
    }
}

export function hasActiveConnection(clientId: string): boolean {
    const existing = connectionsByClientId.get(clientId);
    return Boolean(existing && existing.size > 0);
}

router.get('/:clientId/llm/events', (req: Request, res: Response) => {
    const clientIdParam = req.params.clientId;
    const safeClientId = sanitizeClientId(Array.isArray(clientIdParam) ? clientIdParam[0] : clientIdParam);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    addConnection(safeClientId, res);

    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 30_000);

    req.on('close', () => {
        clearInterval(heartbeat);
        removeConnection(safeClientId, res);
        res.end();
    });
});

export default router;
