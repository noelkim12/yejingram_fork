import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import webpush from 'web-push';
import { selectAllRooms } from '../../src/entities/room/selectors';
import { selectCharacterById } from '../../src/entities/character/selectors.ts';
import { headlessLoadState, headlessSendMessage, printMessages } from '../../src/lib/headlessUtils.ts';
import type { ProactiveTimeRestriction, ProactivePeriodicSettings, ProactiveProbabilisticSettings } from '../../src/entities/setting/types.ts';
import { readSubscriptions, prepareAvatarCache, avatarCache } from './routes.ts';
import { broadcastLLMComplete } from '../llm/events';
import { stateCache } from '../index';
import { getStorage } from '../storage';
import { persistConfig } from '../../src/app/store';
import type { ServerState, SyncMetadata } from '../../src/entities/sync/types';
import en from '../../src/i18n/locales/en.ts';
import ko from '../../src/i18n/locales/ko.ts';
import ja from '../../src/i18n/locales/ja.ts';

/* =====================================================
   i18n initialization (shared across entry points)
===================================================== */
const i18nResources = {
    ko: { translation: ko },
    en: { translation: en },
    ja: { translation: ja }
};

export async function initI18n(): Promise<void> {
    if (i18next.isInitialized) return;
    await i18next
        .use(initReactI18next)
        .init({
            resources: i18nResources,
            lng: 'en',
            fallbackLng: 'en',
            interpolation: { escapeValue: false },
        });
}

/* =====================================================
   Trigger logic
===================================================== */

/**
 * 현재 시간이 제한 시간대에 해당하는지 확인
 * 제한 시간대라면 true 반환 (선톡 불가)
 */
export function isInRestrictedTime(timeRestriction: ProactiveTimeRestriction): boolean {
    if (!timeRestriction.enabled || !timeRestriction.startHour || !timeRestriction.startMinute || !timeRestriction.endHour || !timeRestriction.endMinute) return false;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = timeRestriction.startHour * 60 + timeRestriction.startMinute;
    const endMinutes = timeRestriction.endHour * 60 + timeRestriction.endMinute;

    // 시작 시간이 종료 시간보다 클 경우 (예: 23:00 ~ 07:00 = 밤 시간대)
    if (startMinutes > endMinutes) {
        // 자정을 넘기는 경우
        return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    } else {
        // 자정을 넘기지 않는 경우 (예: 13:00 ~ 15:00)
        return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
}

/**
 * 오늘 날짜를 YYYY-MM-DD 형식으로 반환
 */
function getTodayDateString(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 클라이언트별 확률적 선톡 카운트 관리 (서버 메모리)
interface ProbabilisticTriggerState {
    date: string;
    count: number;
}
const probabilisticTriggerCounts: Map<string, ProbabilisticTriggerState> = new Map();

/**
 * 확률적 선톡을 트리거할지 결정
 * 하루에 최대 N번까지 트리거되며, 설정된 확률에 따라 결정
 * 카운트는 서버 측에서 관리
 */
export function shouldTriggerProbabilistic(clientId: string, settings: ProactiveProbabilisticSettings): boolean {
    if (!settings.enabled || !settings.maxTriggersPerDay || !settings.probability) return false;

    const today = getTodayDateString();
    let triggerState = probabilisticTriggerCounts.get(clientId);

    // 날짜가 바뀌었거나 처음이면 리셋
    if (!triggerState || triggerState.date !== today) {
        triggerState = { date: today, count: 0 };
        probabilisticTriggerCounts.set(clientId, triggerState);
    }

    // 오늘 최대 횟수에 도달했다면 더 이상 트리거하지 않음
    const maxTriggers = settings.maxTriggersPerDay;
    if (triggerState.count >= maxTriggers) {
        console.log(`[${clientId}] ${i18next.t('proactiveServer.probabilisticMaxReached', { max: maxTriggers, current: triggerState.count })}`);
        return false;
    }

    // 확률 계산 (0-100 사이의 값)
    const roll = Math.random() * 100;
    const shouldTrigger = roll < settings.probability;

    console.log(`[${clientId}] ${i18next.t('proactiveServer.probabilisticRoll', { roll: roll.toFixed(2), probability: settings.probability, current: triggerState.count, max: maxTriggers })}`);

    if (shouldTrigger) {
        triggerState.count++;
        probabilisticTriggerCounts.set(clientId, triggerState);
        return true;
    }

    return false;
}

// 클라이언트별 마지막 주기적 선톡 시간 기록
const lastPeriodicTriggerTime: Map<string, number> = new Map();

/**
 * 주기적 선톡을 트리거할지 결정
 */
export function shouldTriggerPeriodic(clientId: string, settings: ProactivePeriodicSettings): boolean {
    if (!settings.enabled || !settings.intervalMinutes) return false;

    const now = Date.now();
    const lastTrigger = lastPeriodicTriggerTime.get(clientId) ?? 0;
    const intervalMs = settings.intervalMinutes * 60 * 1000;

    if (now - lastTrigger >= intervalMs) {
        lastPeriodicTriggerTime.set(clientId, now);
        return true;
    }

    return false;
}

/* =====================================================
   Proactive polling loop
===================================================== */
export interface ProactiveLoopConfig {
    syncBaseUrl: string;
}

export async function startProactiveLoop(config: ProactiveLoopConfig): Promise<void> {
    while (true) {
        const subscriptions = await readSubscriptions();

        for (const [clientId, push] of Object.entries(subscriptions)) {
            try {
                console.log(`[${clientId}] ${i18next.t('proactiveServer.restoreStart')}`);

                const store = await headlessLoadState({
                    savetype: 'sync',
                    baseUrl: config.syncBaseUrl,
                    clientId
                });

                console.log(i18next.t('proactiveServer.restoreComplete'));

                const state = store.getState();
                const proactiveSettings = state.settings.proactiveSettings;

                if (!proactiveSettings.proactiveChatEnabled) {
                    console.log(i18next.t('proactiveServer.featureDisabled'));
                    continue;
                }

                // 제한 시간대 체크
                if (proactiveSettings.timeRestriction && isInRestrictedTime(proactiveSettings.timeRestriction)) {
                    console.log(`[${clientId}] ${i18next.t('proactiveServer.restrictedTime')}`);
                    continue;
                }

                // 주기적 선톡 또는 확률적 선톡 중 하나라도 트리거 조건을 만족해야 함
                let shouldSendProactive = false;

                // 주기적 선톡 체크
                if (proactiveSettings.periodicSettings?.enabled) {
                    if (shouldTriggerPeriodic(clientId, proactiveSettings.periodicSettings)) {
                        console.log(`[${clientId}] ${i18next.t('proactiveServer.periodicTriggered')}`);
                        shouldSendProactive = true;
                    }
                }

                // 확률적 선톡 체크 (하루 N번)
                if (proactiveSettings.probabilisticSettings?.enabled && !shouldSendProactive) {
                    if (shouldTriggerProbabilistic(clientId, proactiveSettings.probabilisticSettings)) {
                        console.log(`[${clientId}] ${i18next.t('proactiveServer.probabilisticTriggered', { probability: proactiveSettings.probabilisticSettings.probability })}`);
                        shouldSendProactive = true;
                    }
                }

                // 둘 다 비활성화되어 있으면 기본적으로 선톡 실행
                if (!proactiveSettings.periodicSettings?.enabled && !proactiveSettings.probabilisticSettings?.enabled) {
                    shouldSendProactive = true;
                }

                if (!shouldSendProactive) {
                    console.log(`[${clientId}] ${i18next.t('proactiveServer.conditionNotMet')}`);
                    continue;
                }

                const allRooms = selectAllRooms(state);
                if (!allRooms || allRooms.length === 0) {
                    console.error(i18next.t('proactiveServer.noRooms'));
                    continue;
                }

                // 선톡 허용된 방만 필터링
                const proactiveEnabledRooms = allRooms.filter(room => room.proactiveEnabled === true);
                if (proactiveEnabledRooms.length === 0) {
                    console.log(`[${clientId}] ${i18next.t('proactiveServer.noProactiveRooms')}`);
                    continue;
                }

                const randomRoom = proactiveEnabledRooms[Math.floor(Math.random() * proactiveEnabledRooms.length)];

                await headlessSendMessage({
                    store,
                    room: randomRoom,
                    onMessage: async (newlyAdded) => {
                        const characterName = selectCharacterById(state, newlyAdded.authorId)?.name ?? 'Unknown';
                        printMessages([newlyAdded]);
                        if (!avatarCache.has(`${clientId}:${newlyAdded.authorId}`)) {
                            await prepareAvatarCache(state, clientId, newlyAdded.authorId);
                        }

                        try {
                            await webpush.sendNotification(
                                push,
                                JSON.stringify({
                                    icon: `${proactiveSettings.proactiveServerBaseUrl}/api/${clientId}/push/icon/${newlyAdded.authorId}`,
                                    badge: '/yejingram.png',
                                    body: characterName + ": " + (newlyAdded.content ?? i18next.t('proactiveServer.stickerOrImage')),
                                    tag: randomRoom.id
                                })
                            );
                        } catch (err) {
                            console.error(`[${clientId}] ${i18next.t('proactiveServer.pushError')}`, err);
                        }
                    },
                    onStart: (id) => {
                        if (id) {
                            console.log(i18next.t('proactiveServer.messageGenerating'), id);
                        } else {
                            console.log(i18next.t('proactiveServer.messageComplete'));
                        }
                    },
                    t: i18next.t,
                    mode: 'proactive',
                });

                const updatedState = store.getState();
                const currentSync = updatedState.sync;
                const buildSnapshot = (s: typeof updatedState) => ({
                    characters: s.characters,
                    rooms: s.rooms,
                    messages: s.messages,
                    settings: s.settings,
                    lastSaved: s.lastSaved,
                });
                const nextMetadata: SyncMetadata = {
                    snapshotSeq: currentSync.snapshotSeq + 1,
                    patchSeq: 0,
                    version: persistConfig.version,
                };

                try {
                    await getStorage().sync.replaceState(clientId, {
                        snapshot: JSON.stringify(buildSnapshot(updatedState)),
                        metadata: nextMetadata,
                    });
                    stateCache.set(clientId, { metadata: nextMetadata, patches: [] } as ServerState);
                    broadcastLLMComplete(clientId, {
                        requestId: 'proactive',
                        roomId: randomRoom.id,
                        snapshotSeq: nextMetadata.snapshotSeq,
                        patchSeq: 0,
                    });
                    console.log(`[${clientId}] Proactive snapshot saved (seq: ${nextMetadata.snapshotSeq}) and SSE broadcast sent`);
                } catch (saveErr) {
                    console.error(`[${clientId}] Failed to save proactive snapshot:`, saveErr);
                }
            } catch (err) {
                console.error(`[${clientId}] Unhandled error during proactive processing:`, err);
            }
        }
        // 체크 주기: 1분
        await new Promise(resolve => setTimeout(resolve, 60 * 1000));
    }
}
