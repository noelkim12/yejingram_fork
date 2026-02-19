import { store } from '../app/store';
import { syncService } from './syncService';

const MIN_HIDDEN_DURATION = 5000;

export function initReconnectSync() {
    if (typeof document === 'undefined') return;

    let lastHiddenAt = 0;

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            lastHiddenAt = Date.now();
        } else {
            const hiddenDuration = Date.now() - lastHiddenAt;
            if (hiddenDuration >= MIN_HIDDEN_DURATION) {
                const state = store.getState();
                if (state.settings.syncSettings.syncEnabled) {
                    syncService.checkConflict();
                }
            }
        }
    });
}
