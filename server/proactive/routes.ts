import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import type { PushSubscription } from 'web-push';
import { getBlob } from '../../src/services/binaryStore';
import type { RootState } from '../../src/app/store';
import { selectCharacterById } from '../../src/entities/character/selectors.ts';
import { sanitizeClientId } from '../index.ts';

interface SubscriptionBody extends PushSubscription {
    clientId: string;
}

const SUBSCRIPTION_DIR = path.resolve(process.cwd(), 'data');

export const avatarCache = new Map<string, Buffer>();

export async function prepareAvatarCache(state: RootState, clientId: string, authorId: number) {
    try {
        const character = selectCharacterById(state, authorId);
        if (!character?.avatar) return;

        const blob = await getBlob(character.avatar.storageKey);
        if (!blob) return;

        const buffer = await blob.arrayBuffer();
        const resizedPng = await sharp(buffer)
            .resize(192, 192, { fit: 'cover' })
            .png()
            .toBuffer();

        const key = `${clientId}:${authorId}`;
        avatarCache.set(key, resizedPng);

        // 10분 후 캐시 삭제
        setTimeout(() => {
            avatarCache.delete(key);
        }, 10 * 60 * 1000);
    } catch (err) {
        console.error(`[${clientId}] Failed to cache avatar for ${authorId}:`, err);
    }
}

export async function readSubscriptions(clientId?: string): Promise<PushSubscription | { [key: string]: PushSubscription }> {
    await fs.mkdir(SUBSCRIPTION_DIR, { recursive: true });

    if (clientId) {
        const safeClientId = sanitizeClientId(clientId);
        const filePath = path.join(SUBSCRIPTION_DIR, `${safeClientId}.json`);
        const json = await fs.readFile(filePath, 'utf-8');
        const parsed: PushSubscription = JSON.parse(json);
        return parsed;
    } else {
        const entries = await fs.readdir(SUBSCRIPTION_DIR, { withFileTypes: true });
        const subs: { [key: string]: PushSubscription } = {};

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            try {
                const json = await fs.readFile(path.join(SUBSCRIPTION_DIR, entry.name), 'utf-8');
                subs[entry.name.replace('.json', '')] = JSON.parse(json);
            } catch {
                // 개별 파일 오류는 무시하고 나머지 파일만 사용
                continue;
            }
        }
        return subs;
    }
}

export async function saveSubscription(subscription: SubscriptionBody): Promise<void> {
    if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth || !subscription.clientId) {
        throw new Error('Invalid subscription object');
    }

    const safeClientId = sanitizeClientId(subscription.clientId);
    const { clientId, ...pure } = subscription;
    const filePath = path.join(SUBSCRIPTION_DIR, `${safeClientId}.json`);
    await fs.mkdir(SUBSCRIPTION_DIR, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(pure, null, 2));
}

const router = Router();

router.post('/:clientId/push/subscription', async (req, res) => {
    try {
        const clientId = sanitizeClientId(req.params.clientId);
        const subscription = { ...req.body, clientId };
        await saveSubscription(subscription as SubscriptionBody);
        res.json({ ok: true });
    } catch (err: any) {
        console.error('[Subscription API Error]', err);
        res.status(400).json({ error: err?.message ?? 'Invalid subscription' });
    }
});

router.post('/:clientId/push/unsubscribe', async (req, res) => {
    try {
        const clientId = sanitizeClientId(req.params.clientId);
        const filePath = path.join(SUBSCRIPTION_DIR, `${clientId}.json`);
        if (!(await fs.stat(filePath).catch(() => false))) {
            return res.status(404).json({ error: 'Subscription not found' });
        } else {
            await fs.unlink(filePath);
        }
        res.json({ ok: true });
    } catch (err: any) {
        console.error('[Unsubscription API Error]', err);
        res.status(500).json({ error: err?.message ?? 'Internal server error' });
    }
});

router.get('/:clientId/push/icon/:authorId', async (req, res) => {
    try {
        const clientId = sanitizeClientId(req.params.clientId);
        const authorId = Number(req.params.authorId);
        if (Number.isNaN(authorId)) {
            return res.status(400).json({ error: 'Invalid authorId' });
        }

        const cacheKey = `${clientId}:${authorId}`;
        if (avatarCache.has(cacheKey)) {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.end(avatarCache.get(cacheKey));
        } else {
            res.status(404).json({ error: 'Not found' });
        }
    } catch (err: any) {
        console.error('[Icon API Error]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
