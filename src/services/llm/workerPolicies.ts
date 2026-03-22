import type { Message } from '../../entities/message/types';

export type LlmTransport = 'proxy' | 'local';

export function resolveLlmTransport({
    syncEnabled,
    syncBaseUrl,
    preferProxy,
}: {
    syncEnabled: boolean;
    syncBaseUrl?: string | null;
    preferProxy: boolean;
}): LlmTransport {
    return preferProxy && syncEnabled && Boolean(syncBaseUrl) ? 'proxy' : 'local';
}

export function shouldPersistWorkerSnapshot({
    snapshotChanged,
    acceptedUserMessageCount,
    generatedMessageCount,
}: {
    snapshotChanged: boolean;
    acceptedUserMessageCount: number;
    generatedMessageCount: number;
}): boolean {
    return snapshotChanged && (acceptedUserMessageCount > 0 || generatedMessageCount > 0);
}

export function shouldWorkerHandleMessage(_message: Message): boolean {
    return true;
}
