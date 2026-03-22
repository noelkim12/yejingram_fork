import fs from 'fs/promises';
import { buildBackupPayload, backupStateToServer, restoreStateFromPayload, restoreStateFromServer } from '../utils/backup';
import { selectMessagesByRoomId } from '../entities/message/selectors';
import type { Message } from '../entities/message/types';
import type { Room } from '../entities/room/types';
import { SendMessage } from '../services/llm/LLMcaller';
import type { LlmTransport } from '../services/llm/workerPolicies';
import i18next from 'i18next';
import { store, type RootState, type store as RootStore } from '../app/store';

export type HeadlessSaveConfig =
    | {
        savetype: 'file'
        file: string
    }
    | {
        savetype: 'sync'
        baseUrl: string
        clientId: string
    }

export function printCharacters(state: RootState) {
    const characters = Object.values(state.characters.entities).filter(c => c) as { id: number; name: string }[];
    for (const char of characters) {
        console.log(`Character: ${char.name} (ID: ${char.id})`);
        printRoomInfo(state, char.id);
        console.log('');
    }
}

export function printRoomInfo(state: RootState, characterId: number) {
    const rooms = Object.values(state.rooms.entities).filter(r => r && r.memberIds.includes(characterId)) as Room[];

    for (const room of rooms) {
        console.log(`- ${room.name} (ID: ${room.id})`);
        const messages = selectMessagesByRoomId(state, room.id);
        console.log(`  Messages: ${messages.length}`); // 간단한 메시지 통계
        console.log(`  Last Message: ${messages.length > 0 ? messages[messages.length - 1].content : 'No messages'}`);
    }
}

export function printMessages(messages: Message[]) {
    for (const m of messages) {
        const baseInfo = `- [${m.type}] authorId=${m.authorId} at ${m.createdAt}`;
        if (m.type === 'TEXT') {
            console.log(baseInfo + `\n  ${m.content ?? ''}`);
        } else if (m.type === 'STICKER') {
            console.log(baseInfo + `\n  [Sticker] ${m.sticker?.name ?? m.sticker?.id ?? 'unknown'}`);
        } else if (m.type === 'IMAGE') {
            console.log(baseInfo + `\n  [Image] ${m.file?.name ?? m.file?.mimeType ?? 'image'}`);
        } else {
            console.log(baseInfo);
        }
    }
}

export async function headlessSendMessage({
    store,
    room,
    onMessage,
    onStart,
    onComplete,
    t = i18next.t,
    mode = 'normal',
    transport = 'local',
}: {
    store: typeof RootStore;
    room: any;
    onMessage?: (msg: Message) => void;
    onStart?: (id: number | null) => void;
    onComplete?: () => void;
    t?: typeof i18next.t;
    mode?: 'normal' | 'continuation' | 'proactive';
    transport?: LlmTransport;
}) {
    const beforeMessages = selectMessagesByRoomId(store.getState(), room.id);
    const beforeIds = new Set(beforeMessages.map(m => m.id));
    const sentNotificationIds = new Set<string>();

    printMessages(beforeMessages);

    const unsubscribe = store.subscribe(async () => {
        const allMessages = selectMessagesByRoomId(store.getState(), room.id);
        const newMessages = allMessages.filter(m => !beforeIds.has(m.id) && !sentNotificationIds.has(m.id));
        for (const newlyAdded of newMessages) {
            sentNotificationIds.add(newlyAdded.id);
            if (onMessage) onMessage(newlyAdded);
        }
    });

    try {
        store.dispatch({ type: 'messages/writingStart' });
        await SendMessage(
            room,
            (id) => {
                if (onStart) onStart(id);
            },
            t,
            mode,
            transport
        );
        if (onComplete) onComplete();
    } finally {
        unsubscribe();
    }
}


export async function headlessLoadState(
    saveMethod: HeadlessSaveConfig
): Promise<typeof RootStore> {
    if (saveMethod.savetype === 'sync') {
        const ok = await restoreStateFromServer(saveMethod.clientId, saveMethod.baseUrl, true);
        if (!ok) {
            console.error('Failed to load state from server.');
            return store;
        }
        console.log(`Remote sync state loaded: ${saveMethod.baseUrl} (clientId=${saveMethod.clientId})`);
    }
    else if (saveMethod.savetype === 'file') {
        const raw = await fs.readFile(saveMethod.file, 'utf-8');
        await restoreStateFromPayload(JSON.parse(raw));
        console.log(`Backup loaded: ${saveMethod.file}`);
    }

    return store;
}


export async function headlessSave(
    state: RootState,
    saveMethod: HeadlessSaveConfig
) {
    try {
        if (saveMethod.savetype === 'file') {
            console.log('Saving backup file');
            const payload = buildBackupPayload();
            await fs.writeFile(saveMethod.file, JSON.stringify(payload, null, 2));
            return true;
        } else if (saveMethod.savetype === 'sync' && !state.settings.syncSettings.syncEnabled) {
            console.log('Uploading remote sync state');
            try {
                await backupStateToServer(saveMethod.clientId, saveMethod.baseUrl);
                console.log(`Remote sync state saved: ${saveMethod.baseUrl} (clientId=${saveMethod.clientId})`);
                return true;
            } catch (e: any) {
                console.error('Failed to save remote sync state:', e?.message ?? e);
                return false;
            }
        }
    } catch (e: any) {
        console.error('Failed to save backup:', e?.message ?? e);
        return false;
    }
}
