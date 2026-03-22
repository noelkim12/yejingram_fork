import { Router, type Response } from 'express';
import express from 'express';
import multer from 'multer';
import { stateCache, sanitizeClientId } from '../index';
import type { ClientSyncResponse, Patch, ServerState, SyncMetadata } from '../../src/entities/sync/types';
import { applyPatch } from '../../src/utils/diff';
import { getStorage } from '../storage';

const router = Router();
const upload = multer({ limits: { fieldSize: 100 * 1024 * 1024 } }); // 100MB

/* =====================================================
   State loader
===================================================== */
async function readServerState(clientId: string): Promise<ServerState | null> {
    if (stateCache.has(clientId)) {
        return stateCache.get(clientId)!;
    }

    const state = await getStorage().sync.readState(clientId);
    if (!state) return null;

    stateCache.set(clientId, state);
    return state;
}

/* =====================================================
   Validation
===================================================== */
function validatePatchSequence(
    patch: Patch,
    state: ServerState,
    res: Response
): boolean {
    if (patch.baseSnapshotSeq !== state.metadata.snapshotSeq) {
        res.status(410).json({ error: 'Snapshot sequence mismatch' });
        return false;
    }

    if (patch.seq !== state.metadata.patchSeq) {
        res.status(409).json({
            error: 'Patch sequence out of order',
            seq: state.metadata.patchSeq,
            timestamp: state.patches.length
                ? state.patches[state.patches.length - 1].timestamp
                : Date.now()
        });
        return false;
    }

    return true;
}

/* =====================================================
   Routes
===================================================== */

/* ---------- sync check ---------- */
router.post('/:clientId/sync/check', async (req, res, next) => {
    try {
        const clientId = sanitizeClientId(String(req.params.clientId));
        const state = await readServerState(clientId);
        if (!state) return res.status(404).json({ error: 'State not found' });

        const patch = req.body as Patch;
        if (!validatePatchSequence(patch, state, res)) return;

        res.json({ valid: true });
    } catch (err) {
        next(err);
    }
});

/* ---------- sync fetch ---------- */
router.get('/:clientId/sync', async (req, res, next) => {
    try {
        const clientId = sanitizeClientId(req.params.clientId);
        const state = await readServerState(clientId);
        if (!state) return res.status(404).json({ error: 'State not found' });

        const sinceSnapshotSeq = Number(req.query.sinceSnapshotSeq ?? 0);
        const sincePatchSeq = Number(req.query.sincePatchSeq ?? 0);

        if (req.query.full === 'true' || sinceSnapshotSeq < state.metadata.snapshotSeq) {
            return res.json({
                snapshotSeq: state.metadata.snapshotSeq,
                patchSeq: state.metadata.patchSeq,
                version: state.metadata.version,
                patches: state.patches
            } as ClientSyncResponse);
        }

        return res.json({
            type: 'patch',
            snapshotSeq: state.metadata.snapshotSeq,
            patchSeq: state.metadata.patchSeq,
            version: state.metadata.version,
            patches: state.patches.filter(p => p.seq >= sincePatchSeq)
        } as ClientSyncResponse);
    } catch (err) {
        next(err);
    }
});

/* ---------- snapshot download ---------- */
router.get('/:clientId/snapshot', async (req, res, next) => {
    try {
        const clientId = sanitizeClientId(req.params.clientId);
        const snapshot = await getStorage().sync.readSnapshot(clientId);
        if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="snapshot.json"');
        res.send(snapshot);
    } catch (err) {
        next(err);
    }
});

/* ---------- snapshot upload ---------- */
router.post('/:clientId/snapshot', upload.none(), async (req, res, next) => {
    try {
        if (typeof req.params.clientId !== 'string') {
            return res.status(400).json({ error: 'Invalid clientId' });
        }

        const clientId = sanitizeClientId(req.params.clientId);

        const metadata = {
            snapshotSeq: 0,
            patchSeq: 0,
            version: Number(req.body.version)
        };

        const state: ServerState = {
            metadata,
            patches: []
        };

        await getStorage().sync.replaceState(clientId, {
            snapshot: String(req.body.snapshot ?? ''),
            metadata,
            clearBinaries: true,
        });

        stateCache.set(clientId, state);

        res.json({
            snapshotSeq: 0,
            patchSeq: 0
        } as SyncMetadata);
    } catch (err) {
        next(err);
    }
});

/* ---------- binary upload/download/delete ---------- */
router.put(
    '/:clientId/binaries/:storageKey',
    express.raw({ type: '*/*', limit: '100mb' }),
    async (req, res, next) => {
        try {
            const clientId = sanitizeClientId(req.params.clientId);
            const storageKey = String(req.params.storageKey ?? '');
            if (!storageKey) return res.status(400).json({ error: 'Missing storageKey' });

            const buf = req.body as Buffer;
            if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
                return res.status(400).json({ error: 'Empty body' });
            }

            await getStorage().binaries.put(
                clientId,
                storageKey,
                req.header('content-type') ?? 'application/octet-stream',
                buf,
            );

            return res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    }
);

router.get('/:clientId/binaries/:storageKey', async (req, res, next) => {
    try {
        const clientId = sanitizeClientId(req.params.clientId);
        const storageKey = String(req.params.storageKey ?? '');
        if (!storageKey) return res.status(400).json({ error: 'Missing storageKey' });

        const binary = await getStorage().binaries.get(clientId, storageKey);
        if (!binary) return res.status(404).json({ error: 'Binary not found' });
        res.setHeader('Content-Type', binary.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', String(binary.data.byteLength));
        res.send(Buffer.from(binary.data));
    } catch (err) {
        next(err);
    }
});

router.delete('/:clientId/binaries/:storageKey', async (req, res, next) => {
    try {
        const clientId = sanitizeClientId(req.params.clientId);
        const storageKey = String(req.params.storageKey ?? '');
        if (!storageKey) return res.status(400).json({ error: 'Missing storageKey' });

        await getStorage().binaries.delete(clientId, storageKey);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/* ---------- sync push ---------- */
router.post('/:clientId/sync', async (req, res, next) => {
    try {
        const clientId = sanitizeClientId(req.params.clientId);

        const state = await readServerState(clientId);
        if (!state) return res.status(404).json({ error: 'State not found' });

        const patch = req.body as Patch;
        if (!validatePatchSequence(patch, state, res)) return;

        // Interpret binary deletes server-side.
        if (patch.binary?.del?.length) {
            await Promise.all(patch.binary.del.map(k => getStorage().binaries.delete(clientId, String(k))));
        }

        const nextPatches = [...state.patches, patch];
        const nextMetadata: SyncMetadata = {
            ...state.metadata,
            patchSeq: nextPatches.length,
        };

        /* snapshot every 100 patches */
        if (nextPatches.length >= 100) {
            const currentSnapshot = await getStorage().sync.readSnapshot(clientId);
            if (!currentSnapshot) return res.status(404).json({ error: 'Snapshot not found' });

            const newSnapshot = applyPatch(JSON.parse(currentSnapshot), nextPatches as Patch[]);
            const compactedMetadata: SyncMetadata = {
                ...nextMetadata,
                snapshotSeq: nextMetadata.snapshotSeq + 1,
                patchSeq: 0,
            };

            await getStorage().sync.replaceState(clientId, {
                snapshot: JSON.stringify(newSnapshot),
                metadata: compactedMetadata,
            });
            stateCache.set(clientId, { metadata: compactedMetadata, patches: [] } as ServerState);

            return res.json({
                snapshotSeq: compactedMetadata.snapshotSeq,
                patchSeq: compactedMetadata.patchSeq,
            } as SyncMetadata);
        }

        await getStorage().sync.commitPatch(clientId, patch, nextMetadata);
        stateCache.set(clientId, { metadata: nextMetadata, patches: nextPatches } as ServerState);

        return res.json({
            snapshotSeq: nextMetadata.snapshotSeq,
            patchSeq: nextMetadata.patchSeq,
        } as SyncMetadata);
    } catch (err) {
        next(err);
    }
});

export default router;
