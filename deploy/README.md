# Personal Deployment Notes

개인용 배포 메모입니다. 메인 `README.md`에는 넣지 않고 여기서만 관리합니다.

## Domain Layout

- `https://ygram.noelkim12.dev`: 빌드된 SPA 정적 파일 서빙
- `https://ygram-proxy.noelkim12.dev`: Bun/Express 백엔드 (`/api/*`) 전용 origin

현재 코드는 아래 URL 설정을 런타임에서 직접 사용합니다.

- `syncSettings.syncBaseUrl`: 동기화 + 백엔드 LLM 처리
- `proactiveSettings.proactiveServerBaseUrl`: 푸시 구독/해제 + 선톡 아이콘 URL
- 서버 환경변수 `SYNC_BASE_URL`: proactive loop의 서버측 self-fetch 기준 URL

## Files

- `Caddyfile`: 도메인 라우팅
- `deploy/caddy.env.example`: Caddy 런타임 환경변수 예시
- `deploy/server.env.example`: Bun/Express 런타임 환경변수 예시

## Recommended Values

- 앱 접속 주소: `https://ygram.noelkim12.dev`
- 앱 설정의 `syncBaseUrl`: `https://ygram-proxy.noelkim12.dev`
- 앱 설정의 `proactiveServerBaseUrl`: `https://ygram-proxy.noelkim12.dev`
- 서버 환경변수 `SYNC_BASE_URL`: `https://ygram-proxy.noelkim12.dev`

## Caddy Env

- `CADDY_ACME_EMAIL`: TLS 인증서 발급/갱신용 이메일
- `YGRAM_BASIC_AUTH_USER`: UI 도메인 Basic Auth 사용자명
- `YGRAM_BASIC_AUTH_HASH`: UI 도메인 Basic Auth 비밀번호 해시
- `YGRAM_DIST_ROOT`: `npm run build` 결과물인 `dist` 경로
- `YGRAM_API_UPSTREAM`: Bun 서버 업스트림 주소 (`127.0.0.1:28475` 등)

비밀번호 해시는 아래처럼 만들 수 있습니다.

```bash
caddy hash-password --plaintext 'your-password'
```

## Server Env

- `PORT`: Bun/Express 서버 포트
- `DATA_DIR`: 서버가 상태/바이너리/DB를 저장할 경로
- `SERVER_STORAGE_BACKEND`: 저장소 백엔드 (`sqlite` 권장)
- `SYNC_BASE_URL`: 서버가 자신을 공개적으로 참조할 백엔드 origin
- `push_public_key`, `push_private_key`: proactive push 기능용 VAPID 키

## Notes

- `ygram.noelkim12.dev`에는 Basic Auth를 걸고, `ygram-proxy.noelkim12.dev`에는 걸지 않는 구성을 권장합니다.
- 백엔드 origin까지 Basic Auth를 걸면 현재 앱의 sync/LLM/proactive fetch 흐름과 충돌할 수 있습니다.
- 현재 루트 `.env`의 `ACCESS_GATE_PASSWORD`는 이 워크트리의 실제 서버 코드에서는 사용되지 않습니다.
