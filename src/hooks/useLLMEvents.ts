import { useEffect, useRef, useCallback } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../app/store';
import { pullLatestState } from '../utils/backup';

interface LLMCompleteEvent {
    type: 'llm-complete';
    requestId: string;
    roomId: string;
    snapshotSeq: number;
    patchSeq: number;
}

export function useLLMEvents(activeRoomId?: string): void {
    const syncEnabled = useSelector((s: RootState) => s.settings.syncSettings.syncEnabled);
    const clientId = useSelector((s: RootState) => s.settings.syncSettings.syncClientId);
    const baseUrl = useSelector((s: RootState) => s.settings.syncSettings.syncBaseUrl);
    const syncingRef = useRef(false);

    const sync = useCallback(async () => {
        if (!clientId || !baseUrl) return;
        if (syncingRef.current) return;
        syncingRef.current = true;
        try {
            await pullLatestState(clientId, baseUrl);
        } catch (err) {
            console.error('[useLLMEvents] Sync failed:', err);
        } finally {
            syncingRef.current = false;
        }
    }, [clientId, baseUrl]);

    useEffect(() => {
        if (!syncEnabled || !clientId || !baseUrl) return;

        const eventUrl = `${baseUrl}/api/${clientId}/llm/events`;
        let es: EventSource;

        try {
            es = new EventSource(eventUrl);
        } catch {
            console.warn('[useLLMEvents] Failed to create EventSource');
            return;
        }

        es.onmessage = async (event) => {
            let data: LLMCompleteEvent;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }

            if (data.type !== 'llm-complete') return;
            if (activeRoomId && data.roomId !== activeRoomId) return;

            await sync();
        };

        es.onerror = () => {
            console.warn('[useLLMEvents] SSE connection error (will auto-reconnect)');
        };

        return () => {
            es.close();
        };
    }, [syncEnabled, clientId, baseUrl, activeRoomId, sync]);

    useEffect(() => {
        if (!syncEnabled || !clientId || !baseUrl) return;

        void sync();

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                void sync();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [syncEnabled, clientId, baseUrl, sync]);
}
