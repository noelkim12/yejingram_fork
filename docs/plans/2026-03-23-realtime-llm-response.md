# Real-time LLM Response Delivery + Push Notification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** LLM 응답 완료 시 (1) SSE를 통해 프론트엔드에 실시간 전달하고, (2) 브라우저 Push 알림을 올바르게 발송하여 사용자가 응답을 즉시 확인할 수 있게 한다.

**Architecture:** 서버에 SSE(Server-Sent Events) 엔드포인트를 추가하여 LLM 워커가 응답을 완료하면 연결된 클라이언트에 이벤트를 보낸다. 프론트엔드에서는 채팅 페이지가 열려있을 때 SSE에 구독하고, 이벤트 수신 시 기존 `restoreStateFromServer()`를 호출하여 Redux 상태를 갱신한다. Push 알림은 이미 구현된 인프라를 활용하되, 서비스 워커의 알림 클릭 핸들러를 수정하여 올바른 채팅방으로 네비게이션되도록 한다.

**Tech Stack:** Express (SSE endpoint), EventSource API (browser), web-push (existing), Redux, React hooks

**Why SSE over WebSocket:** 서버→클라이언트 단방향 통신만 필요하고, 브라우저 내장 EventSource API가 자동 재연결을 지원하며, 별도 의존성 없이 Express에서 바로 구현 가능하다.

---

## Overview

### 현재 상태
- LLM 워커(`server/llm/worker.ts`)가 2초 폴링으로 큐를 처리하고 응답을 서버에 저장
- Push 알림 인프라 존재하나 `sw-push.js`의 알림 클릭 시 올바른 채팅방으로 이동하지 않음
- 프론트엔드는 서버의 새 응답을 감지하는 메커니즘이 없음 (수동 새로고침 필요)

### 변경 파일 요약
| 구분 | 파일 | 변경 내용 |
|------|------|-----------|
| 새 파일 | `server/llm/events.ts` | SSE 연결 관리자 + Express 라우터 |
| 새 파일 | `src/hooks/useLLMEvents.ts` | SSE 구독 React 훅 |
| 수정 | `server/llm/worker.ts` | LLM 완료 시 SSE 이벤트 발송 |
| 수정 | `server/index.ts` | SSE 라우터 등록 |
| 수정 | `public/sw-push.js` | 알림 클릭 시 채팅방 네비게이션 + tag 지원 |
| 수정 | `server/llm/worker.ts` | Push payload에 `data.url` 추가 |
| 수정 | `src/components/mainchat/MainChat.tsx` | `useLLMEvents` 훅 연동 |

---

## Task 1: SSE 연결 관리자 + 라우터 (서버)

**Files:**
- Create: `server/llm/events.ts`

**Step 1: SSE 연결 관리자 모듈 작성**

```typescript
// server/llm/events.ts
import { Router, type Request, type Response } from 'express';
import { sanitizeClientId } from '../index';

const router = Router();

/**
 * Active SSE connections, keyed by clientId.
 * Each client can have multiple connections (multiple tabs).
 */
const connections = new Map<string, Set<Response>>();

/**
 * Register an SSE connection for a client.
 */
function addConnection(clientId: string, res: Response): void {
    if (!connections.has(clientId)) {
        connections.set(clientId, new Set());
    }
    connections.get(clientId)!.add(res);
    console.log(`[llm-events] Client '${clientId}' connected (total: ${connections.get(clientId)!.size})`);
}

/**
 * Remove an SSE connection for a client.
 */
function removeConnection(clientId: string, res: Response): void {
    const clientConns = connections.get(clientId);
    if (!clientConns) return;
    clientConns.delete(res);
    if (clientConns.size === 0) {
        connections.delete(clientId);
    }
    console.log(`[llm-events] Client '${clientId}' disconnected (remaining: ${clientConns?.size ?? 0})`);
}

/**
 * Broadcast an event to all connected clients for a given clientId.
 * Called by the LLM worker when processing completes.
 */
export function broadcastLLMComplete(clientId: string, data: {
    requestId: string;
    roomId: string;
    snapshotSeq: number;
    patchSeq: number;
}): void {
    const clientConns = connections.get(clientId);
    if (!clientConns || clientConns.size === 0) return;

    const payload = `data: ${JSON.stringify({ type: 'llm-complete', ...data })}\n\n`;
    for (const res of clientConns) {
        try {
            res.write(payload);
        } catch {
            removeConnection(clientId, res);
        }
    }
    console.log(`[llm-events] Broadcast llm-complete to ${clientConns.size} connection(s) for '${clientId}'`);
}

/**
 * Check if a client has any active SSE connections.
 * Can be used to skip push notifications when the client is actively connected.
 */
export function hasActiveConnection(clientId: string): boolean {
    const clientConns = connections.get(clientId);
    return !!clientConns && clientConns.size > 0;
}

/* ---------- GET /:clientId/llm/events ---------- */
router.get('/:clientId/llm/events', (req: Request, res: Response) => {
    const clientId = sanitizeClientId(req.params.clientId);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx proxy buffering off
    res.flushHeaders();

    // Send initial heartbeat so client knows connection is alive
    res.write(': connected\n\n');

    addConnection(clientId, res);

    // Heartbeat every 30s to keep connection alive through proxies
    const heartbeat = setInterval(() => {
        try {
            res.write(': heartbeat\n\n');
        } catch {
            clearInterval(heartbeat);
            removeConnection(clientId, res);
        }
    }, 30_000);

    // Cleanup on disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        removeConnection(clientId, res);
    });
});

export default router;
```

**Step 2: SSE 라우터를 서버에 등록**

`server/index.ts`에 다음을 추가:

```typescript
// 기존 import 근처에 추가
import llmEventsRouter from './llm/events';

// 기존 app.use('/api', llmRouter); 아래에 추가
app.use('/api', llmEventsRouter);
```

**Step 3: 검증**

Run: `npx tsc --noEmit --project tsconfig.server.json` (또는 서버 빌드 명령)
Expected: 컴파일 에러 없음

**Step 4: Commit**

```bash
git add server/llm/events.ts server/index.ts
git commit -m "feat: add SSE endpoint for real-time LLM response delivery"
```

---

## Task 2: LLM 워커에서 SSE 이벤트 발송

**Files:**
- Modify: `server/llm/worker.ts`

**Step 1: broadcastLLMComplete import 추가**

`server/llm/worker.ts` 상단에 import 추가:

```typescript
import { broadcastLLMComplete } from './events';
```

**Step 2: processRequest에서 SSE 브로드캐스트 호출**

`processRequest()` 함수 내에서 스냅샷 저장 이후, Push 알림 전송 전에 SSE 이벤트를 브로드캐스트한다.

**위치**: `worker.ts` 240행 근처, `if (generatedMessages.length > 0)` 블록 시작 부분.

기존:
```typescript
if (generatedMessages.length > 0) {
    await sendCompletionPush(
```

변경:
```typescript
if (generatedMessages.length > 0) {
    // Notify connected frontends via SSE
    const currentServerState = stateCache.get(safeClientId) as ServerState | undefined;
    broadcastLLMComplete(safeClientId, {
        requestId: request.id,
        roomId: request.roomId,
        snapshotSeq: currentServerState?.metadata.snapshotSeq ?? 0,
        patchSeq: currentServerState?.metadata.patchSeq ?? 0,
    });

    await sendCompletionPush(
```

**Step 3: 검증**

Run: 서버 빌드/타입체크
Expected: 컴파일 에러 없음

**Step 4: Commit**

```bash
git add server/llm/worker.ts
git commit -m "feat: broadcast SSE event on LLM response completion"
```

---

## Task 3: 프론트엔드 SSE 구독 훅

**Files:**
- Create: `src/hooks/useLLMEvents.ts`

**Step 1: useLLMEvents 훅 작성**

```typescript
// src/hooks/useLLMEvents.ts
import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../app/store';
import { restoreStateFromServer } from '../utils/backup';

interface LLMCompleteEvent {
    type: 'llm-complete';
    requestId: string;
    roomId: string;
    snapshotSeq: number;
    patchSeq: number;
}

/**
 * SSE를 통해 LLM 응답 완료 이벤트를 실시간으로 수신하고,
 * 서버와 동기화하여 Redux 상태를 갱신하는 훅.
 *
 * @param activeRoomId - 현재 보고 있는 채팅방 ID (선택적, 필터링에 사용)
 */
export function useLLMEvents(activeRoomId?: string): void {
    const syncEnabled = useSelector((s: RootState) => s.settings.syncSettings.syncEnabled);
    const clientId = useSelector((s: RootState) => s.settings.syncSettings.syncClientId);
    const baseUrl = useSelector((s: RootState) => s.settings.syncSettings.syncBaseUrl);
    const syncingRef = useRef(false);

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

            // Optionally filter by room
            if (activeRoomId && data.roomId !== activeRoomId) return;

            // Prevent concurrent sync calls
            if (syncingRef.current) return;
            syncingRef.current = true;

            try {
                console.log(`[useLLMEvents] Received llm-complete for room ${data.roomId}, syncing...`);
                await restoreStateFromServer(clientId, baseUrl, true);
                console.log(`[useLLMEvents] Sync completed for room ${data.roomId}`);
            } catch (err) {
                console.error('[useLLMEvents] Sync failed:', err);
            } finally {
                syncingRef.current = false;
            }
        };

        es.onerror = () => {
            // EventSource auto-reconnects; just log
            console.warn('[useLLMEvents] SSE connection error (will auto-reconnect)');
        };

        return () => {
            es.close();
        };
    }, [syncEnabled, clientId, baseUrl, activeRoomId]);
}
```

**Step 2: 검증**

Run: `npx tsc --noEmit` (프론트엔드 타입체크)
Expected: 컴파일 에러 없음

**Step 3: Commit**

```bash
git add src/hooks/useLLMEvents.ts
git commit -m "feat: add useLLMEvents hook for SSE-based real-time sync"
```

---

## Task 4: MainChat에 SSE 훅 연동

**Files:**
- Modify: `src/components/mainchat/MainChat.tsx`

**Step 1: useLLMEvents 훅 사용**

`MainChat.tsx`에서 현재 활성 roomId를 알 수 있는 위치에 훅을 추가한다.

```typescript
// import 추가
import { useLLMEvents } from '../../hooks/useLLMEvents';

// 컴포넌트 내부, 기존 hooks 근처에 추가
// roomId는 MainChat 컴포넌트 내에서 이미 사용 중인 현재 활성 room의 ID
useLLMEvents(roomId);
```

> **Note**: `roomId` 변수명은 MainChat.tsx에서 실제 사용하는 변수명에 맞춰 조정해야 한다. 탐색 결과 컴포넌트 내에서 room 관련 state를 사용 중이므로, 정확한 변수명은 구현 시 확인이 필요하다.

**Step 2: 검증**

Run: 프론트엔드 빌드
Expected: 빌드 성공

**Step 3: Commit**

```bash
git add src/components/mainchat/MainChat.tsx
git commit -m "feat: integrate SSE real-time sync into MainChat"
```

---

## Task 5: Push 알림 페이로드 수정 (서버)

**Files:**
- Modify: `server/llm/worker.ts`

**Step 1: sendCompletionPush의 payload 수정**

현재 `sendCompletionPush` 함수의 `sendNotification` 호출에서 payload를 수정하여, 서비스 워커에서 사용할 수 있는 `data` 필드를 포함시킨다.

기존 (`worker.ts` 140-152행):
```typescript
await webpush.sendNotification(
    subscription,
    JSON.stringify({
        title: 'Reply ready',
        icon: latestAuthorId == null ? '/yejingram.png' : `/api/${clientId}/push/icon/${latestAuthorId}`,
        badge: '/yejingram.png',
        body: `${characterName}: ${body}`,
        tag: roomId,
        roomId,
        clientId,
        vapidPublicKey,
    })
);
```

변경:
```typescript
await webpush.sendNotification(
    subscription,
    JSON.stringify({
        title: 'Reply ready',
        icon: latestAuthorId == null ? '/yejingram.png' : `/api/${clientId}/push/icon/${latestAuthorId}`,
        badge: '/yejingram.png',
        body: `${characterName}: ${body}`,
        tag: `llm-${roomId}`,
        data: {
            url: `/?roomId=${roomId}`,
            roomId,
            clientId,
        },
    })
);
```

**변경 포인트:**
- `tag`에 prefix 추가 (`llm-`)하여 proactive push와 구분
- `roomId`, `clientId`, `vapidPublicKey` 최상위 → `data` 필드 안으로 이동
- `data.url` 추가: 알림 클릭 시 네비게이션 대상 URL

**Step 2: 검증**

Run: 서버 빌드/타입체크
Expected: 컴파일 에러 없음

**Step 3: Commit**

```bash
git add server/llm/worker.ts
git commit -m "fix: restructure push notification payload with proper data field"
```

---

## Task 6: 서비스 워커 Push 핸들러 수정

**Files:**
- Modify: `public/sw-push.js`

**Step 1: push 이벤트 핸들러에 tag와 data 매핑 수정**

기존 (`sw-push.js`):
```javascript
const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    data: data.data,
};
```

변경:
```javascript
const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    tag: data.tag,
    renotify: true,
    data: data.data || {},
};
```

**변경 포인트:**
- `tag` 추가: 같은 채팅방에서 연속 알림이 오면 이전 알림을 교체
- `renotify: true`: tag가 같더라도 알림 소리/진동이 다시 발생
- `data` fallback: data가 없을 때 빈 객체로 설정

**Step 2: notificationclick 핸들러에서 url 올바르게 읽기**

기존:
```javascript
const targetUrl = (event.notification.data && event.notification.data.url) || '/';
```

이 부분은 이미 `data.url`을 읽고 있으므로, Task 5에서 payload에 `data.url`을 추가했기 때문에 자동으로 작동한다. 변경 불필요.

**Step 3: 검증**

수동 테스트: 서버 시작 후 LLM 요청 처리 → Push 알림 수신 → 클릭 시 해당 채팅방으로 이동 확인

**Step 4: Commit**

```bash
git add public/sw-push.js
git commit -m "fix: add tag and proper data mapping to push notification handler"
```

---

## Task 7 (선택적): SSE 연결 시 Push 알림 억제

> 이 태스크는 선택적이다. 사용자가 채팅 페이지를 보고 있을 때 (SSE 연결됨) Push 알림까지 보내면 이중 알림이 되므로, SSE가 연결된 상태에서는 Push를 생략할 수 있다.

**Files:**
- Modify: `server/llm/worker.ts`

**Step 1: hasActiveConnection 체크 추가**

`worker.ts`의 `processRequest` 함수에서, Push 알림 전송 전에 SSE 연결 상태를 확인:

```typescript
import { broadcastLLMComplete, hasActiveConnection } from './events';
```

기존:
```typescript
if (generatedMessages.length > 0) {
    // SSE broadcast ...
    await sendCompletionPush(
```

변경:
```typescript
if (generatedMessages.length > 0) {
    // SSE broadcast ...

    // Skip push notification if client is actively connected via SSE
    if (!hasActiveConnection(safeClientId)) {
        await sendCompletionPush(
            config.webpush,
            config.vapidPublicKey,
            safeClientId,
            room.id,
            nextState,
            generatedMessages
        );
    } else {
        console.log(`[llm-worker:${safeClientId}] SSE connected, skipping push notification`);
    }
```

**Step 2: Commit**

```bash
git add server/llm/worker.ts
git commit -m "feat: skip push notification when client has active SSE connection"
```

---

## 검증 시나리오

### 시나리오 1: SSE 실시간 수신
1. 프론트엔드에서 sync 설정 활성화, 채팅방 진입
2. 백엔드 모드로 메시지 전송
3. LLM 응답 완료 시 채팅 UI에 메시지가 자동으로 표시되는지 확인
4. 브라우저 DevTools > Network 탭에서 SSE 연결 확인

### 시나리오 2: Push 알림
1. 프론트엔드에서 채팅방을 벗어나거나 브라우저 탭을 닫음
2. 백엔드 모드로 메시지 전송 (다른 탭이나 직접 API 호출)
3. Push 알림 수신 확인
4. 알림 클릭 시 해당 채팅방으로 이동하는지 확인

### 시나리오 3: 이중 알림 방지 (Task 7 구현 시)
1. 채팅방을 보고 있는 상태에서 LLM 응답 수신
2. SSE로 메시지가 표시되고, Push 알림은 오지 않는지 확인

---

## 의존성

- 새로운 npm 패키지 추가 없음
- 기존 Express, web-push, Redux 인프라 활용
- `restoreStateFromServer()` (src/utils/backup.ts) 재사용
