# gjc provider — 구현 청사진 (Gajae App, 2026-07-09)

Gajae App에 provider `gjc`(Gajae Code) 추가. **1단계 = read-only**(세션 목록 + 대화 열람). 구현 참조 = **codex**(JSONL 스캐너 계열). 업스트림 PR 금지 — Gajae App에서 개발.

## 세션 스토어 (실측)
- 위치: `$HOME/.gjc/agent/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl`
  - `<cwd-slug>` = 절대 cwd에서 `$HOME` 스트립 후 `/`→`-`. 예 `/workspace/gajae-app` → `-workspace-gajae-app`. (표시용; **권위 있는 cwd는 JSONL 헤더**.)
  - 세션당 동명 사이드카 디렉터리(`<...>_<uuid>/`)에 artifacts/resident-cache. **인덱싱은 `.jsonl` 파일만**(사이드카 하위 blob은 확장자 없어 자동 제외).
  - 서브에이전트 세션 = 같은 디렉터리의 형제 `.jsonl`.
- **JSONL 라인 스키마** (한 줄=한 이벤트, `id`/`parentId` 트리):
  - 헤더(1행): `{"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>","cwd":"<절대경로>"}` — codex의 `payload.id/payload.cwd`와 달리 **최상위 `id`/`cwd` 직접**.
  - 메시지: `{"type":"message","id":..,"parentId":..,"timestamp":..,"message":{"role":"user|assistant|toolResult","content":[...]}}`
    - `content[]` 파트: `{type:"text",text}`, `{type:"thinking",..}`, `{type:"toolCall",..}`, `{type:"toolResult",..}` (usage/cost/model 메타 동반 가능).
  - 기타 이벤트: `model_change`, `thinking_level_change`, `custom`(customType: skill-prompt/workflow-intent-diff 등) — 대화 표시엔 무시.
  - **title 전용 필드 없음** → 첫 `type:message` `role:user`의 text 파트에서 파생(claude/codex 방식). 보조로 `~/.gjc/agent/history.db`(`history(prompt,cwd,created_at)`) 최근 prompt.
- agent.db/history.db/models.db는 세션 아님(auth/cache/usage/settings, 프롬프트 입력이력, 모델카탈로그). **읽기 전용만**(WAL, 라이브 프로세스 사용중).

## 파일 (codex 원형 복제 → gjc 맞춤)
`server/modules/providers/list/gjc/`:
- `gjc.provider.ts` — wrapper. `AbstractProvider` 확장, `super('gjc')`, facet: models/mcp/auth/skills/sessions/sessionSynchronizer.
- `gjc-session-synchronizer.provider.ts` — 원형 `codex-session-synchronizer`. `gjcHome=~/.gjc/agent`, 스캔 `path.join(gjcHome,'sessions')`. `extractFirstValidJsonlData`로 첫 줄 파싱: **`data.id`/`data.cwd` 직접**(codex처럼 payload 아님). title=첫 user message 파생(`extractFirstUserMessageFromStart`를 gjc `type:message,role:user` content-text로 재작성) → 없으면 history.db → 없으면 `Untitled gjc Session`. `sessionsDb.createSession(id, 'gjc', cwd, name, createdAt, updatedAt, filePath)`.
- `gjc-sessions.provider.ts` — 원형 `codex-sessions`. `getSessionById(id).jsonl_path` → readline → **`entry.type==='message'`만** normalize: `message.role` + `message.content[]` 파트별 → user/assistant/thinking/tool_use/tool_result (codex의 event_msg/response_item 분기를 gjc content-part 타입으로 교체). timestamp 정렬 + `sliceTailPage` 페이지네이션(`createNormalizedMessage`/`generateMessageId`, 멀티 text 파트 id 충돌 방지 discriminator).
- `gjc-auth.provider.ts` — `command -v gjc` + 로그인 상태(agent.db:auth_credentials 존재 or `gjc` CLI). 미설치/미인증은 데이터로 반환(예외 아님).
- `gjc-skills.provider.ts` — `SkillsProvider` 확장. 루트: user `~/.gjc/agent/skills`, project `<ws>/.gjc/skills`. prefix: 스킬은 트리거 자동활성(명령형 아님) — codex `$`/claude `/` 참고해 gjc 표기 확정(잠정 `/`).
- `gjc-mcp.provider.ts` — gjc MCP 설정 위치 확정 필요(미조사). 최소 안전 stub(빈 목록) 또는 조사 후.
- `gjc-models.provider.ts` — codex-models 원형. models.db 카탈로그 or 정적 fallback.

## 등록 (README 8단계)
- `server/shared/types.ts` `LLMProvider` union에 `'gjc'`.
- `src/types/app.ts` `LLMProvider`(프론트).
- `server/modules/providers/provider.registry.ts` — `GjcProvider` 등록.
- `server/modules/providers/provider.routes.ts` — provider 파싱.
- 프론트: `src/components/chat/hooks/useChatProviderState.ts`, `ProviderSelectionEmptyState.tsx`, `ProviderLoginModal.tsx`, `src/components/mcp/constants.ts`, `public/api-docs.html` PROVIDER_ORDER.
- **live 단계(체크포인트1 이후, 이번 범위 아님)**: `server/routes/agent.js`/`server/index.js` spawnFns/abortFns — gjc `-p`/`-r`/resume 플래그 정본(`/tmp/gajae-code` `cli/args.ts`) 확정 후.

## 테스트
`server/modules/providers/tests/gjc-sessions.test.ts` — `opencode-sessions.test.ts`/`codex-sessions.test.ts` 참조. 합성 JSONL fixture(헤더+message 라인)로 synchronizer 인덱싱 + sessions fetchHistory normalize 검증.

## 게이트
- 실 `$HOME/.gjc` 읽기 전용. 쓰기 실험은 격리 HOME.
- 프로덕션 인스턴스 손대지 말 것 — 별도 포트 dev.
- 체크포인트1 = read-only(목록+열람) 되면 스크린샷 + 관제 큐 보고 → 리뷰 후 live.
- 기존 4 provider 무회귀.
