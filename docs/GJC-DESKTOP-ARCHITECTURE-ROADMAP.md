# GJC desktop architecture roadmap

Status: implementation record and forward roadmap
Recorded: 2026-07-15

Implementation progress:

- **Checkpoint A complete.** GJC CLI/SDK lifecycle behavior is covered with
  injectable fake-child, controlled-ask, abort, disconnect, timeout, terminal
  race, and cleanup tests. Protocol v1 lives in
  `server/gjc-worker-protocol.ts` with strict 64 MiB NDJSON frames, response
  correlation, scope validation, and supplied-secret redaction.
- **Checkpoint B complete.** Production GJC starts and resumes now cross one
  long-lived Node/TypeScript worker supervised by `server/gjc-worker-client.ts`.
  `server/gjc-worker.ts` owns the GJC CLI/SDK runtime; the application process
  retains browser sockets, application session IDs, replay, persistence,
  notifications, permission mirrors, restart policy, and terminal reporting.
- Worker and run process ownership is explicit: the worker is a detached POSIX
  process group and GJC children remain attached to it. On Windows, a guard
  proves the live application owner, then creates the worker atomically inside a
  kill-on-close Job Object with `PROC_THREAD_ATTRIBUTE_JOB_LIST`. Validated
  tree-kill escalation fails closed before any replacement generation. Graceful
  shutdown drains active runs before escalation.
- Claude, Codex, Cursor, and OpenCode remain on their existing paths.
  **Checkpoint C has not started.**

## Purpose

Record the agreed direction for evolving Gajae App toward a Codex App-like desktop product without turning the recent Node.js compatibility fix into an unnecessary full rewrite.

## Confirmed decisions

1. Source development supports Node.js 22 and 24. The immutable production server artifact remains pinned to Node.js 22 until its release contract is changed separately.
2. A full Rust rewrite is not justified solely by Node.js installation or engine-version friction.
3. Rust is the preferred long-term core for desktop lifecycle, local process supervision, PTY ownership, durable jobs, Git/worktree operations, file watching, and native distribution.
4. The React UI remains reusable and must communicate through explicit APIs rather than directly owning filesystem, Git, database, or child-process behavior.
5. GJC is the only provider that will use the provider-worker architecture initially.
6. Claude, Codex, Cursor, and OpenCode keep their existing integration paths. They are not part of the first worker extraction and must not be forced behind a speculative generic worker abstraction.
7. The first GJC worker is the reference implementation. Other providers move only after a concrete need and a separately approved scope.

## Target shape

```text
Desktop shell (Electron initially; Tauri remains an option)
                         |
                      React UI
                         |
              existing application API
                         |
       Rust local core/daemon (incremental target)
       |        |         |        |        |
     Git      PTY      jobs     SQLite   file watch
                         |
                GJC worker client
                         |
              local versioned IPC
                         |
                GJC provider worker
                         |
                     GJC SDK/CLI
```

The desktop shell must stay thin. Closing a window must not implicitly destroy a durable agent job once the daemon architecture exists.

## GJC-only worker boundary

### Worker owns

- GJC SDK discovery, authentication, handshake, and protocol compatibility checks.
- GJC session start and resume operations.
- Turn start, streaming, controlled questions, replies, and abort.
- GJC token-usage and status events.
- GJC-specific error normalization before crossing IPC.
- Secret handling for SDK endpoint tokens; secrets must never enter observer events or logs.

### Application server/core owns

- Gajae App authentication and authorization.
- Application session IDs and provider-session ID mapping.
- Database writes and migrations.
- Browser WebSocket connections and replay sequencing.
- UI-facing normalized message events.
- Permission policy, job state, persistence, and recovery decisions.
- Worker startup, health checks, restart policy, and terminal failure reporting.

### Worker must not own

- Direct writes to the Gajae App database.
- Browser authentication or browser-facing sockets.
- Product-wide provider registration.
- Claude, Codex, Cursor, or OpenCode behavior.
- UI component state.

## Initial IPC contract

The default implementation direction is private local stdio with newline-delimited JSON. It avoids opening another network listener and is sufficient for one supervised GJC worker. A different transport requires a concrete operational reason.

Every frame should carry:

```json
{
  "protocolVersion": 1,
  "kind": "request | response | event",
  "id": "request-or-event-id",
  "sessionId": "application-session-id",
  "method": "turn.start",
  "payload": {}
}
```

Minimum request methods:

- `worker.initialize`
- `session.start`
- `session.resume`
- `turn.start`
- `turn.abort`
- `ask.reply`
- `worker.shutdown`

Minimum event families:

- `session.created`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.completed`
- `ask.presented`
- `usage.updated`
- `turn.completed`
- `turn.failed`
- `worker.status`

The protocol must reject unknown incompatible versions, correlate every response, bound frame size, redact secrets, and fail pending requests when the worker exits.

## Existing extraction points

The current GJC implementation already contains the boundary candidates:

- `server/gjc-cli.js`: GJC CLI process lifecycle and NDJSON handling.
- `server/gjc-sdk-client.ts`: SDK connection, request correlation, and protocol handling.
- `server/gjc-sdk-bridge.ts`: controlled asks, abort, token usage, and server integration.
- `server/modules/providers/list/gjc/`: read-only provider facets and session synchronization.
- `server/routes/agent.js` and `server/index.js`: application wiring and abort routing.
- `server/GJC-LIVE-SPEC.md`: current live-provider behavior and verification constraints.

Extraction must preserve the existing observable GJC behavior before responsibilities move into Rust.

## Migration checkpoints

### Checkpoint A: freeze behavior contracts — complete

- Capture the current GJC start, resume, stream, ask/reply, usage, abort, disconnect, and error behavior in focused tests.
- Keep all existing providers unchanged.
- Define the versioned IPC schema and maximum frame sizes.
- Define ownership of application IDs versus GJC session IDs.

### Checkpoint B: extract the GJC worker — complete

- Move GJC SDK/CLI connection behavior behind the worker boundary.
- Keep the existing Node application server as supervisor and API owner.
- Preserve current browser events and database behavior.
- Surface worker crashes as explicit failed turns; do not silently fake completion.

### Checkpoint C: introduce the Rust core

- Move process supervision, durable job state, PTY lifecycle, Git/worktree operations, and file watching behind a Rust daemon API.
- Keep the React UI and GJC worker contract stable.
- Keep non-GJC providers on their existing paths unless separately approved.

### Checkpoint D: thin desktop shell

- Evaluate Electron versus Tauri using measured startup, memory, updater, signing, WebView, and Linux packaging results.
- Make window lifecycle independent from durable daemon jobs.
- Embed or serve the built React assets without requiring end users to install a development Node.js toolchain.

## Product invariants

A Codex App-like direction requires more than changing implementation language:

- Agent jobs survive UI reconnects and expose deterministic terminal states.
- Each worktree/job has explicit ownership and cleanup rules.
- Diffs remain reviewable before commit or application.
- Abort is real and observable, not a UI-only state change.
- Event replay is ordered and idempotent.
- The daemon fails closed around project paths, credentials, and remote exposure.
- No migration may regress the existing GJC session history or live-run behavior.

## Non-goals

- Rewriting the whole server in Rust in one change.
- Replacing the React UI.
- Moving every provider to a worker.
- Removing existing providers.
- Claiming a single binary while silently requiring an unmanaged external runtime.
- Changing the Node.js 22 production artifact contract as part of the GJC worker extraction.

## Open decisions

These require implementation evidence or a separate approved plan:

- The implemented reference uses one long-lived TypeScript/Node worker per
  application server. A different topology requires measured evidence.
- Protocol v1's current source of truth is
  `server/gjc-worker-protocol.ts`; a TypeScript/Rust code-generation mechanism
  remains open for Checkpoint C.
- Rust SQLite library and migration ownership.
- Electron-to-Tauri timing and supported desktop platforms.
- Packaging strategy for any runtime still required by the GJC SDK.
