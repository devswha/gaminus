# GJC live provider specification

Status: Checkpoint A and Checkpoint B implemented (2026-07-15)

GJC is the only provider routed through an isolated provider worker. Claude,
Codex, Cursor, and OpenCode retain their existing execution paths.

## Headless GJC contract

The worker invokes:

```text
gjc -p --mode json --session-dir <dir> [-r <providerSessionId>] [--model <model>] @<private-prompt-file>
```

- `cwd` is the selected project path.
- The prompt is written to an owner-readable temporary file and passed by
  `@file`; it is never placed verbatim in the process list.
- `GJC_NOTIFICATIONS=0` disables notifications from the ephemeral CLI harness.
  Gajae App remains the notification owner.
- `--session-dir` isolates session writes. Authentication and configuration
  still come from the user's normal GJC configuration.
- Stdout is byte-bounded NDJSON. Stderr is diagnostic only and is not forwarded
  to browser clients as raw provider output.
- The optional loopback SDK v3 side channel supplies controlled questions,
  replies, token usage, and `turn.abort`. If discovery or handshake fails, the
  existing NDJSON stream and process-signal abort path remain available inside
  the worker.

## Production boundary

### Application process

`server/gjc-worker-client.ts` is the only production GJC execution facade used
by `server/index.js` and `server/routes/agent.js`. It owns:

- one lazily started, long-lived worker generation;
- application session scope and immutable run IDs;
- browser-facing normalized events, replay sequencing, and provider-session
  persistence through `ChatSessionWriter`;
- the synchronous mirror of pending controlled questions;
- run notifications and explicit failed-turn fallback;
- worker restart, request timeout isolation, graceful shutdown, and process-tree
  escalation.

There is no direct in-process production fallback to `server/gjc-cli.js`.
Malformed output or worker exit fails active GJC runs explicitly; a later run
starts a fresh worker generation.

### Worker process

`server/gjc-worker.ts` is a private Node/TypeScript executable. It owns:

- GJC CLI process creation and NDJSON normalization through
  `spawnGjcWithRuntime`;
- GJC SDK discovery, authentication, controlled asks, usage, and abort;
- start/resume completion ordering and provider-session discovery;
- draining or aborting active runs when shutdown, stdin EOF, or protocol failure
  occurs.

The worker does not own or mutate application database, browser WebSocket,
replay, or notification state.

### Identity model

Three IDs are intentionally separate:

1. `appSessionId` is the stable Gajae App session and protocol scope.
2. `runId` is generated for every start/resume request and is the immutable
   abort/event correlation handle.
3. `providerSessionId` is the native GJC session used for resume and history.

Every run event carries `sessionId: appSessionId` in the envelope and `runId` in
its payload. `session.created` adds `providerSessionId`. Late events for an old
run are ignored even when a new run reuses the same application session.

## Protocol v1

`server/gjc-worker-protocol.ts` is the source of truth. Transport is private
stdio NDJSON with a strict 64 MiB maximum frame size.

```json
{
  "protocolVersion": 1,
  "kind": "request",
  "id": "run-or-request-id",
  "sessionId": "application-session-id",
  "method": "session.start",
  "payload": {}
}
```

Global `worker.initialize` and `worker.shutdown` frames omit `sessionId`.
Supported scoped requests are `session.start`, `session.resume`, `turn.start`,
`turn.abort`, and `ask.reply`. Events are `session.created`, `message.delta`,
`message.completed`, `tool.started`, `tool.completed`, `ask.presented`,
`usage.updated`, `turn.completed`, `turn.failed`, and `worker.status`.

The codec rejects unknown fields, methods, unsafe identifiers, incompatible
versions, invalid JSON values, mismatched responses, oversized or unterminated
frames, and unknown response IDs. Pending requests fail when the worker exits.
Diagnostics and protocol errors use fixed safe text; supplied secrets are
redacted recursively by the serializer.

## Process and terminal lifecycle

- On POSIX, the application starts the worker as a detached process-group
  leader. GJC children are non-detached members of that group.
- On Windows, a PowerShell guard opens an exact application-process handle,
  completes a fixed ready/ack exchange with an exact unbuffered `ReadFile` over
  inherited stdin, then uses
  `STARTUPINFOEX` with `PROC_THREAD_ATTRIBUTE_JOB_LIST` to create the worker
  inside a kill-on-close Job Object from its first instruction. Worker or
  application crashes therefore close the guard/job and terminate every
  inherited GJC descendant. Explicit `taskkill /T /F` is a validated escalation
  path; failed cleanup permanently blocks replacement generations.
- A start/resume response remains pending until the GJC run settles and all
  earlier worker events have been emitted.
- `turn.abort` targets `runId`; the worker time-bounds the SDK attempt before
  direct child-signal fallback. The application marks a run aborted only after
  the worker confirms `aborted: true`; failed or timed-out aborts leave it active.
- Exactly one terminal browser event is forwarded. If the worker dies before
  producing one, the application emits one sanitized error and one failed
  completion.
- Usage enrichment, SDK bridge closure, and installation probes are bounded;
  `complete` remains the final run event even when optional dependencies stall.
- Application shutdown sends `worker.shutdown`, waits for bounded run drain,
  then terminates the owned worker tree.

## Verification contract

Focused coverage is in:

- `server/gjc-cli.test.ts`
- `server/gjc-sdk-client.test.ts`
- `server/gjc-sdk-bridge.test.ts`
- `server/gjc-worker-protocol.test.ts`
- `server/gjc-worker.test.ts`
- `server/gjc-windows-job.test.ts`
- `server/gjc-worker-client.test.ts`
- `server/modules/websocket/tests/chat-run-registry.test.ts`

Coverage includes start/resume, split and bounded NDJSON, SDK asks and replies,
timeouts, abort fallbacks, terminal races, malformed worker output, response
correlation, stale-run isolation, worker restart, real executable
initialize/shutdown, graceful drain, atomic Windows Job Object launch, failed
cleanup admission blocking, and process-tree cleanup. Full repository
verification must continue to pass on supported Node.js 22 and 24 source
runtimes.
