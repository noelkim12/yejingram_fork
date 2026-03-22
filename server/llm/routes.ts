import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { sanitizeClientId, stateCache, DATA_DIR } from '../index';
import { queue } from './queue';
import type { LLMRequest } from '../types';

const router = Router();

/* ---------- POST /:clientId/llm/send ---------- */
router.post('/:clientId/llm/send', async (req, res, next) => {
    try {
        const clientId = sanitizeClientId(req.params.clientId);
        const { roomId, userMessages } = req.body ?? {};

        if (!roomId || typeof roomId !== 'string') {
            return res.status(400).json({ error: 'roomId is required and must be a string' });
        }

        if (userMessages && !Array.isArray(userMessages)) {
            return res.status(400).json({ error: 'userMessages must be an array' });
        }

        if (!stateCache.has(clientId)) {
            const metadataFile = path.join(DATA_DIR, `${clientId}.metadata.json`);
            try {
                fs.accessSync(metadataFile);
            } catch {
                console.log(`[llm-routes] ❌ Client '${clientId}' not found`);
                return res.status(404).json({ error: `Client '${clientId}' not found` });
            }
        }

        const request: LLMRequest = {
            id: nanoid(),
            clientId,
            roomId,
            userMessages: userMessages || [],
            status: 'pending',
            createdAt: new Date().toISOString(),
        };

        await queue.enqueue(request);
        console.log(`[llm-routes] 📨 Enqueued request ${request.id} for client ${clientId}, room ${roomId}`);

        return res.status(202).json({
            requestId: request.id,
            status: 'queued',
        });
    } catch (err) {
        next(err);
    }
});

/* ---------- GET /:clientId/llm/pending ---------- */
router.get('/:clientId/llm/pending', async (req, res, next) => {
    try {
        const clientId = sanitizeClientId(req.params.clientId);
        const allRequests = await queue.getByClientId(clientId);
        const requests = allRequests.filter(
            r => r.status === 'pending' || r.status === 'processing'
        );

        return res.json({ requests });
    } catch (err) {
        next(err);
    }
});

export default router;
