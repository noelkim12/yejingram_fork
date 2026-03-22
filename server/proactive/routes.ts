import { Router } from 'express';
import sharp from 'sharp';
import type { PushSubscription } from 'web-push';
import { getBlob } from '../../src/services/binaryStore';
import type { RootState } from '../../src/app/store';
import { selectCharacterById } from '../../src/entities/character/selectors.ts';
import { sanitizeClientId } from '../index.ts';
import { getStorage } from '../storage';

interface SubscriptionBody extends PushSubscription {
    clientId: string;
}

export const avatarCache = new Map<string, Buffer>();

function toPushSubscription(raw: Record<string, unknown>): PushSubscription {
    const endpoint = raw.endpoint;
    const keys = raw.keys;
    const p256dh = typeof keys === 'object' && keys ? (keys as { p256dh?: unknown }).p256dh : undefined;
    const auth = typeof keys === 'object' && keys ? (keys as { auth?: unknown }).auth : undefined;

    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
        throw new Error('Invalid subscription object');
    }

    return {
        endpoint,
        keys: {
            p256dh,
            auth,
        },
    };
}

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

export async function readSubscriptions(clientId: string): Promise<PushSubscription>;
export async function readSubscriptions(): Promise<Record<string, PushSubscription>>;
export async function readSubscriptions(clientId?: string): Promise<PushSubscription | Record<string, PushSubscription>> {
    const pushSubscriptions = getStorage().pushSubscriptions;

    if (clientId) {
        const safeClientId = sanitizeClientId(clientId);
        const subscription = await pushSubscriptions.read(safeClientId);
        if (!subscription) {
            throw new Error('Subscription not found');
        }

        return toPushSubscription(subscription);
    } else {
        const subs: { [key: string]: PushSubscription } = {};
        const subscriptions = await pushSubscriptions.readAll();

        for (const [subscriptionClientId, subscription] of Object.entries(subscriptions)) {
            try {
                subs[subscriptionClientId] = toPushSubscription(subscription);
            } catch {
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
    await getStorage().pushSubscriptions.save(safeClientId, pure as unknown as Record<string, unknown>);
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
        const removed = await getStorage().pushSubscriptions.delete(clientId);
        if (!removed) {
            return res.status(404).json({ error: 'Subscription not found' });
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
