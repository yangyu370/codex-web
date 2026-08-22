# Shared Session, Review, Settings, and Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let macOS Codex Web and Codex CLI share live tasks through the local app-server daemon while adding native permission/reasoning controls, inline review, complete structured diffs, and the approved three-column UI.

**Architecture:** Introduce a transport-neutral JSON-RPC peer and a macOS Unix-socket WebSocket connection to the managed Codex daemon, with the current stdio process retained as the Windows and compatibility fallback. Expand the normalized browser protocol and WebState so the React client consumes authoritative thread settings, review state, and multi-file diffs without seeing raw app-server messages.

**Tech Stack:** Bun 1.3+, TypeScript, React 19, Zustand, Zod, `ws` for Unix-socket WebSocket transport, Bun test, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-22-shared-session-review-settings-ui-design.md`

## Global Constraints

- Live handoff is macOS-only in this release; Windows must keep embedded stdio behavior.
- Codex Desktop tasks are history-only and must never be labeled as live.
- An embedded CLI task that started before the daemon cannot be migrated.
- Permission and effort changes are task-scoped and may be saved only as non-secret defaults for new tasks; never modify `~/.codex/config.toml`.
- Review target is always uncommitted changes with inline delivery.
- Raw app-server messages, request IDs, configuration values, and Unix-socket paths never cross the browser protocol.
- Preserve existing byte, item-count, approval-count, attachment, authentication, and diagnostic bounds.
- Use tolerant native decoders so one unsupported capability does not disable basic history and turns.

## File Structure

- `src/shared/protocol.ts`: normalized browser request, catalog, settings, review, diff, and capability types.
- `src/server/app-server/json-rpc.ts`: transport-neutral JSON-RPC correlation and dispatch.
- `src/server/app-server/jsonl-transport.ts`: current stdio JSONL framing.
- `src/server/app-server/unix-websocket-transport.ts`: owner-local Unix-socket WebSocket connection.
- `src/server/app-server/daemon.ts`: bounded daemon lifecycle invocation and response validation.
- `src/server/app-server/process-manager.ts`: daemon-first macOS connection lifecycle and embedded fallback.
- `src/server/app-server/decoders.ts`: tolerant native catalog, thread, settings, and file-change decoders.
- `src/server/app-server/adapter.ts`: native methods for profiles, settings, review, resume, and turn options.
- `src/server/service/state.ts`: authoritative normalized snapshot and native notification handling.
- `src/server/service/thread-catalog.ts`: connection-aware task catalog refresh.
- `src/server/service/gateway.ts`: validated browser methods.
- `src/client/diff.ts`: unified-diff presentation parser.
- `src/client/components/TaskSettings.tsx`: permission/model/effort controls and Review action.
- `src/client/components/ChangesPanel.tsx`: file list and structured diff viewer.
- Existing `App`, sidebar, conversation, activity panel, websocket client, styles, fixtures, tests, README, and smoke files integrate these units.

---

### Task 1: Expand the normalized browser protocol and persisted defaults

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/shared/protocol.test.ts`
- Modify: `src/server/service/settings.ts`
- Modify: `src/server/service/settings.test.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/App.test.tsx`

**Interfaces:**
- Produces: `ReasoningEffortOption`, `PermissionProfileSummary`, `ThreadSettingsSummary`, `TurnDiffSummary`, `ReviewState`, `ServiceHandoff`, and `FileChangeSummary` types.
- Produces: browser methods `permissionProfile.list`, `thread.settings.update`, and `review.start`.
- Produces: `UserSettings.effort?: string` and `UserSettings.permissionProfile?: string`.

- [ ] **Step 1: Write failing protocol tests for the new methods and snapshot shapes**

Add cases that parse exact envelopes and construct the expanded types:

```ts
expect(parseClientMessage(JSON.stringify({
  kind: "request",
  id: "settings-1",
  method: "thread.settings.update",
  params: { threadId: "thread-1", effort: "high", permissionProfile: ":workspace" },
}))).toMatchObject({ method: "thread.settings.update" });

expect(parseClientMessage(JSON.stringify({
  kind: "request",
  id: "review-1",
  method: "review.start",
  params: { threadId: "thread-1" },
}))).toMatchObject({ method: "review.start" });
```

- [ ] **Step 2: Run the focused protocol test and observe the unknown-method failure**

Run: `bun test src/shared/protocol.test.ts`

Expected: FAIL because the browser method enum does not contain the new methods.

- [ ] **Step 3: Add exact shared types and increment the protocol version**

Use these normalized shapes:

```ts
export interface ReasoningEffortOption {
  id: string;
  description?: string;
}

export interface PermissionProfileSummary {
  id: string;
  description?: string;
  allowed: boolean;
}

export interface ThreadSettingsSummary {
  threadId: string;
  model: string;
  effort?: string;
  permissionProfile?: { id: string; extends?: string };
  approvalPolicy: string;
  sandbox: string;
}

export interface FileChangeSummary {
  path: string;
  kind: "add" | "modify" | "delete" | "rename" | "unknown";
  diff: string;
  truncated?: boolean;
}
```

Change the file-change `VisibleItem` variant to `changes: FileChangeSummary[]`, add `permissionProfiles`, optional `threadSettings`, `turnDiff`, `review`, and `service.liveHandoff` to `BrowserSnapshot`, and set `WEB_PROTOCOL_VERSION` to `3`.

- [ ] **Step 4: Write failing settings normalization tests**

```ts
await store.save({
  recentDirectories: ["/work/app"],
  model: "gpt-5.6",
  effort: "high",
  permissionProfile: ":workspace",
});
expect(await store.read()).toEqual({
  recentDirectories: ["/work/app"],
  model: "gpt-5.6",
  effort: "high",
  permissionProfile: ":workspace",
});
```

Also prove that strings longer than 200 characters are dropped.

- [ ] **Step 5: Persist only bounded effort and profile defaults**

Extend `UserSettings`, `normalizeSettings`, `ClientSettings`, and the successful-send persistence path. Keep recent-directory and theme behavior unchanged.

- [ ] **Step 6: Update fixtures and run the focused type/tests**

Run: `bun run typecheck && bun test src/shared/protocol.test.ts src/server/service/settings.test.ts src/client/App.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit the protocol foundation**

```bash
git add src/shared/protocol.ts src/shared/protocol.test.ts src/server/service/settings.ts src/server/service/settings.test.ts src/client/App.tsx src/client/App.test.tsx
git commit -m "feat: extend web protocol for task controls"
```

### Task 2: Make JSON-RPC transport-neutral

**Files:**
- Create: `src/server/app-server/jsonl-transport.ts`
- Create: `src/server/app-server/jsonl-transport.test.ts`
- Modify: `src/server/app-server/json-rpc.ts`
- Modify: `src/server/app-server/json-rpc.test.ts`
- Modify: `src/server/app-server/process-manager.ts`
- Modify: `src/server/app-server/process-manager.test.ts`

**Interfaces:**
- Produces: `JsonRpcTransport` with `send(source)`, `close()`, `onMessage(listener)`, and `onClose(listener)`.
- Produces: `createJsonlTransport(stdout, stdin): JsonRpcTransport`.
- Consumes: no daemon-specific behavior yet.

- [ ] **Step 1: Write a failing in-memory transport test for `JsonRpcPeer`**

Use a fake transport that captures whole JSON strings and emits whole strings:

```ts
const transport = new MemoryJsonRpcTransport();
const peer = new JsonRpcPeer(transport, { requestTimeoutMs: 20 });
const result = peer.request("model/list", {});
expect(JSON.parse(transport.sent[0]!)).toMatchObject({ id: 1, method: "model/list" });
transport.receive(JSON.stringify({ id: 1, result: { data: [] } }));
await expect(result).resolves.toEqual({ data: [] });
```

- [ ] **Step 2: Run the JSON-RPC test and observe the constructor mismatch**

Run: `bun test src/server/app-server/json-rpc.test.ts`

Expected: FAIL because `JsonRpcPeer` currently accepts stdout/stdin streams.

- [ ] **Step 3: Introduce the message transport interface and preserve correlation behavior**

Define:

```ts
export interface JsonRpcTransport {
  send(source: string): void | Promise<void>;
  close(): void;
  onMessage(listener: (source: string) => void): () => void;
  onClose(listener: (reason?: Error) => void): () => void;
}
```

Move JSON parsing into `JsonRpcPeer.#receive(source)`. Keep request limits, timeouts, bounded error data, server requests, notifications, unknown response diagnostics, and single-close behavior unchanged. Do not append a newline in `JsonRpcPeer`.

- [ ] **Step 4: Write failing JSONL framing tests**

Prove fragmented reads and multiple lines become complete messages, and writes append exactly one newline:

```ts
transport.onMessage((source) => received.push(source));
stdout.enqueue(encoder.encode('{"method":"one"}\n{"method":'));
stdout.enqueue(encoder.encode('"two"}\n'));
expect(received).toEqual(['{"method":"one"}', '{"method":"two"}']);
await transport.send('{"id":1}');
expect(stdinText).toBe('{"id":1}\n');
```

- [ ] **Step 5: Implement bounded JSONL framing and wire embedded app-server through it**

`createJsonlTransport` owns `MAX_JSON_RPC_MESSAGE_BYTES = 8_388_608`, UTF-8 decoding, newline splitting, write serialization, stream-close propagation, and cleanup. `AppServerProcessManager` constructs `new JsonRpcPeer(createJsonlTransport(child.stdout, child.stdin))`.

- [ ] **Step 6: Run transport, peer, and process-manager tests**

Run: `bun test src/server/app-server/jsonl-transport.test.ts src/server/app-server/json-rpc.test.ts src/server/app-server/process-manager.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the transport refactor**

```bash
git add src/server/app-server/json-rpc.ts src/server/app-server/json-rpc.test.ts src/server/app-server/jsonl-transport.ts src/server/app-server/jsonl-transport.test.ts src/server/app-server/process-manager.ts src/server/app-server/process-manager.test.ts
git commit -m "refactor: separate JSON-RPC message transport"
```

### Task 3: Connect macOS to the managed Codex daemon

**Files:**
- Create: `src/server/app-server/daemon.ts`
- Create: `src/server/app-server/daemon.test.ts`
- Create: `src/server/app-server/unix-websocket-transport.ts`
- Create: `src/server/app-server/unix-websocket-transport.test.ts`
- Modify: `src/server/app-server/process-manager.ts`
- Modify: `src/server/app-server/process-manager.test.ts`
- Modify: `src/server/platform/types.ts`
- Modify: `src/server/platform/system-runtime.ts`
- Modify: `src/server/platform/system-runtime.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: `JsonRpcTransport` from Task 2.
- Produces: `startManagedDaemon(executable, codexHome, runtime): Promise<DaemonConnectionInfo>`.
- Produces: `connectUnixWebSocket(socketPath, options): Promise<JsonRpcTransport>`.
- Produces: process snapshot fields `mode: "daemon" | "embedded"` and `liveHandoff: "available" | "unavailable"`.

- [ ] **Step 1: Add `ws` and its TypeScript declarations**

Run: `bun add ws && bun add -d @types/ws`

Expected: `package.json` and `bun.lock` contain the resolved dependency versions.

- [ ] **Step 2: Write failing daemon response-validation tests**

Cover `started` and `alreadyRunning`, nonzero exit, oversized output, malformed JSON, relative paths, and paths outside Codex home:

```ts
expect(parseDaemonStartOutput(JSON.stringify({
  status: "alreadyRunning",
  socketPath: "/Users/test/.codex/app-server-control/app-server-control.sock",
  appServerVersion: "0.147.0",
}), "/Users/test/.codex")).toEqual({
  socketPath: "/Users/test/.codex/app-server-control/app-server-control.sock",
  appServerVersion: "0.147.0",
});
```

- [ ] **Step 3: Implement bounded daemon lifecycle startup**

Spawn exactly:

```ts
[executable, "app-server", "daemon", "start"]
```

Bound stdout and stderr to 64 KiB, enforce a 15-second timeout, require exit code `0`, parse one JSON object, allow only `started` and `alreadyRunning`, and validate the resolved socket path with `path.relative(codexHome, socketPath)`.

- [ ] **Step 4: Write failing Unix-socket WebSocket transport tests**

Start a temporary Unix socket test server and prove:

- the request uses an HTTP WebSocket upgrade;
- outbound JSON is a text frame;
- inbound text frames reach `onMessage`;
- ping receives pong;
- binary, oversized, or malformed messages close the transport;
- remote close reaches `onClose` once.

- [ ] **Step 5: Implement `ws` with a Unix `net.Socket` connection**

Construct the client with a custom connection:

```ts
const socket = new WebSocket("ws://localhost/", {
  createConnection: () => net.createConnection({ path: socketPath }),
  perMessageDeflate: false,
  maxPayload: 8_388_608,
});
```

Expose only text messages through `JsonRpcTransport`, reject binary messages, map `error`/`close` to one terminal reason, and make `close()` idempotent.

- [ ] **Step 6: Write failing daemon-first process-manager tests**

Prove macOS tries daemon once, initializes the connected peer, reports daemon mode, does not terminate daemon on stop, and falls back to embedded mode after lifecycle or socket failure. Prove Windows never invokes daemon startup.

- [ ] **Step 7: Extend process management with daemon-first selection**

Keep restart backoff single-flight. In daemon mode reconnect the Unix transport; in embedded mode preserve child-process restart. A normal `stop()` closes the current peer and embedded child only; it never calls `codex app-server daemon stop`.

- [ ] **Step 8: Run daemon, transport, platform, and process-manager tests**

Run: `bun run typecheck && bun test src/server/app-server/daemon.test.ts src/server/app-server/unix-websocket-transport.test.ts src/server/app-server/process-manager.test.ts src/server/platform/system-runtime.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit shared-daemon connectivity**

```bash
git add package.json bun.lock src/server/app-server/daemon.ts src/server/app-server/daemon.test.ts src/server/app-server/unix-websocket-transport.ts src/server/app-server/unix-websocket-transport.test.ts src/server/app-server/process-manager.ts src/server/app-server/process-manager.test.ts src/server/platform/types.ts src/server/platform/system-runtime.ts src/server/platform/system-runtime.test.ts
git commit -m "feat: connect macOS through shared Codex daemon"
```

### Task 4: Decode native profiles, task settings, live status, and complete file changes

**Files:**
- Modify: `src/server/app-server/decoders.ts`
- Modify: `src/server/app-server/adapter.ts`
- Modify: `src/server/app-server/adapter.test.ts`
- Modify: `src/server/service/state.ts`

**Interfaces:**
- Consumes: Task 1 normalized types.
- Produces: `decodePermissionProfileList`, expanded `decodeModelList`, `decodeThreadRuntime`, and all-change `decodeHistoryItem`.
- Produces: adapter methods `permissionProfiles()`, `updateThreadSettings()`, and `startReview()`.

- [ ] **Step 1: Write failing catalog decoder tests**

Use current native field names:

```ts
expect(decodeModelList({ data: [{
  id: "gpt-5.6",
  displayName: "GPT-5.6",
  description: "Frontier coding model",
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast" },
    { reasoningEffort: "high", description: "Thorough" },
  ],
  defaultReasoningEffort: "high",
}] })[0]).toMatchObject({
  supportedReasoningEfforts: [{ id: "low" }, { id: "high" }],
  defaultReasoningEffort: "high",
});

expect(decodePermissionProfileList({ data: [
  { id: ":workspace", description: "Workspace access", allowed: true },
] })).toEqual([{ id: ":workspace", description: "Workspace access", allowed: true }]);
```

- [ ] **Step 2: Write failing thread/runtime and multi-file tests**

Assert source/status/capability normalization and preservation of two native file changes:

```ts
expect(decodeHistoryItem({
  id: "patch-1",
  type: "fileChange",
  status: "completed",
  changes: [
    { path: "a.ts", kind: "update", diff: "+a" },
    { path: "b.ts", kind: "delete", diff: "-b" },
  ],
})).toMatchObject({
  type: "fileChange",
  changes: [
    { path: "a.ts", kind: "modify", diff: "+a" },
    { path: "b.ts", kind: "delete", diff: "-b" },
  ],
});
```

- [ ] **Step 3: Implement bounded tolerant decoders**

Bound each catalog string to 4 KiB, each ID to 512 bytes, each individual diff to 256 KiB, all changes per item to 200, and source/status to known normalized labels with `unknown` fallback. Decode start/resume response settings into `ThreadSettingsSummary` without exposing raw policy objects.

- [ ] **Step 4: Write failing adapter request tests**

Assert exact native calls:

```ts
await adapter.updateThreadSettings("thread-1", {
  effort: "high",
  permissionProfile: ":workspace",
});
expect(rpc.lastRequest).toEqual({
  method: "thread/settings/update",
  params: { threadId: "thread-1", effort: "high", permissions: ":workspace" },
});

await adapter.startReview("thread-1");
expect(rpc.lastRequest).toEqual({
  method: "review/start",
  params: {
    threadId: "thread-1",
    target: { type: "uncommittedChanges" },
    delivery: "inline",
  },
});
```

- [ ] **Step 5: Implement adapter catalog, settings, and review methods**

Cache the latest profile catalog for validation. Reject an absent or disallowed profile with `invalidRequest`. Return decoded runtime settings from thread start/resume. Extend `startTurn` to accept optional `model`, `effort`, and `permissionProfile`, forwarding them as native `model`, `effort`, and `permissions`.

- [ ] **Step 6: Run adapter tests**

Run: `bun test src/server/app-server/adapter.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit native capability decoding**

```bash
git add src/server/app-server/decoders.ts src/server/app-server/adapter.ts src/server/app-server/adapter.test.ts src/server/service/state.ts
git commit -m "feat: expose native task settings and file changes"
```

### Task 5: Make WebState authoritative for settings, Review, and turn diffs

**Files:**
- Modify: `src/server/service/state.ts`
- Modify: `src/server/app-server/adapter.test.ts`
- Modify: `src/client/websocket.ts`
- Modify: `src/client/websocket.test.ts`

**Interfaces:**
- Consumes: decoded settings, complete file-change items, `thread/settings/updated`, and `turn/diff/updated`.
- Produces: browser events `thread.settings.updated`, `turn.diff.updated`, and `review.updated`.

- [ ] **Step 1: Write failing WebState notification tests**

Apply exact native notifications and inspect the snapshot:

```ts
state.applyNotification({
  method: "thread/settings/updated",
  params: {
    threadId: "thread-1",
    threadSettings: {
      cwd: "/work/app",
      model: "gpt-5.6",
      effort: "high",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      activePermissionProfile: { id: ":workspace", extends: null },
    },
  },
});
expect(state.snapshot().threadSettings).toMatchObject({
  threadId: "thread-1",
  effort: "high",
  permissionProfile: { id: ":workspace" },
});
```

Add `turn/diff/updated`, entered/exited review, review turn completion, and thread switch reset cases.

- [ ] **Step 2: Implement bounded authoritative state transitions**

Keep only settings, diff, and review belonging to `loadedThreadId`. Bound the aggregated turn diff to 1 MiB and mark truncation. Set review running from `review/start` response or `enteredReviewMode`, and finish it on `exitedReviewMode` or terminal review turn.

- [ ] **Step 3: Write failing browser event-application tests**

```ts
socket.receive({
  kind: "event",
  sequence: 7,
  type: "thread.settings.updated",
  payload: { threadSettings: settings },
});
expect(client.getSnapshot().threadSettings).toEqual(settings);
```

Also assert diff and review events survive sequence replay and are cleared by an authoritative snapshot.

- [ ] **Step 4: Apply the new events in `CodexWebClient`**

Add explicit branches for settings, diff, review, and permission catalog events. Continue using server snapshots as authoritative state after reconnect gaps.

- [ ] **Step 5: Run state and browser-client tests**

Run: `bun test src/server/app-server/adapter.test.ts src/client/websocket.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit authoritative task state**

```bash
git add src/server/service/state.ts src/server/app-server/adapter.test.ts src/client/websocket.ts src/client/websocket.test.ts
git commit -m "feat: synchronize task settings review and diffs"
```

### Task 6: Expose actions and refresh the shared task catalog

**Files:**
- Create: `src/server/service/thread-catalog.ts`
- Create: `src/server/service/thread-catalog.test.ts`
- Modify: `src/server/service/gateway.ts`
- Modify: `src/server/service/gateway.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/app-server/process-manager.ts`

**Interfaces:**
- Consumes: adapter methods from Task 4 and process mode from Task 3.
- Produces: `ThreadCatalogRefresher` with `browserConnected()`, `browserDisconnected()`, `refreshNow()`, and `close()`.
- Produces: validated browser settings and Review actions.

- [ ] **Step 1: Write failing gateway dispatch tests**

Assert normalization and exact calls:

```ts
await gateway.handleMessage(JSON.stringify({
  kind: "request",
  id: "s1",
  method: "thread.settings.update",
  params: { threadId: "t1", effort: "high", permissionProfile: ":workspace" },
}), send);

expect(actions.updateThreadSettings).toHaveBeenCalledWith("t1", {
  effort: "high",
  permissionProfile: ":workspace",
});
```

Reject empty updates, unknown fields longer than bounds, and Review for an empty thread ID.

- [ ] **Step 2: Implement the gateway methods and first-turn settings forwarding**

Extend `BrowserActions`, gateway dispatch, `TurnCoordinator.start`, and `turn.start` parameters so a new task's first turn carries its selected model, effort, and permission profile. Keep attachment preparation and cleanup unchanged.

- [ ] **Step 3: Write failing catalog refresher tests with a fake clock**

Prove zero browsers means zero interval calls, the first browser refreshes immediately, two browsers share one timer, the last disconnect stops it, focus/request refresh is single-flight, and `close()` prevents later calls.

- [ ] **Step 4: Implement connection-aware single-flight refresh**

Use a 5-second interval. If a refresh is already running, return its promise. A failed refresh records a diagnostic but preserves the previous catalog. Add a gateway connection-count callback so WebSocket open/close controls the refresher.

- [ ] **Step 5: Wire service startup and reconnect restoration**

On app-server ready, load models, permission profiles, and threads independently so one compatibility failure does not erase the others. On daemon reconnect, create the new adapter, reload catalogs, resume `state.snapshot().loadedThreadId` if present, then publish readiness. Set `service.liveHandoff` from process mode.

- [ ] **Step 6: Run gateway, coordinator, catalog, and server tests**

Run: `bun run typecheck && bun test src/server/service/gateway.test.ts src/server/service/turn-coordinator.test.ts src/server/service/thread-catalog.test.ts src/server/service/server.test.ts src/server/app-server/process-manager.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit browser actions and discovery**

```bash
git add src/server/service/thread-catalog.ts src/server/service/thread-catalog.test.ts src/server/service/gateway.ts src/server/service/gateway.test.ts src/server/service/turn-coordinator.ts src/server/service/turn-coordinator.test.ts src/server/index.ts src/server/app-server/process-manager.ts
git commit -m "feat: refresh and control shared Codex tasks"
```

### Task 7: Add a tested unified-diff presentation parser

**Files:**
- Create: `src/client/diff.ts`
- Create: `src/client/diff.test.ts`

**Interfaces:**
- Consumes: bounded raw unified diff strings.
- Produces: `parseUnifiedDiff(source): ParsedDiff` with files, hunks, line kinds, old/new line numbers, and addition/deletion counts.

- [ ] **Step 1: Write table-driven failing parser tests**

Cover add, modify, delete, rename headers, multiple files, multiple hunks, `\\ No newline at end of file`, quoted paths, and malformed input. One representative assertion:

```ts
const parsed = parseUnifiedDiff([
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  " same",
].join("\n"));

expect(parsed.files[0]).toMatchObject({
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  additions: 1,
  deletions: 1,
});
expect(parsed.files[0]?.hunks[0]?.lines).toEqual([
  { kind: "delete", text: "old", oldLine: 1 },
  { kind: "add", text: "new", newLine: 1 },
  { kind: "context", text: "same", oldLine: 2, newLine: 2 },
]);
```

- [ ] **Step 2: Run the parser test and observe the missing-module failure**

Run: `bun test src/client/diff.test.ts`

Expected: FAIL because `src/client/diff.ts` does not exist.

- [ ] **Step 3: Implement a non-throwing line-oriented parser**

Return `{ files, raw, parsed: true }` for recognized unified diffs and `{ files: [], raw, parsed: false }` when no valid file/hunk structure exists. Never discard `raw`. Bound parser work to the already-bounded input and avoid regular expressions with unbounded backtracking.

- [ ] **Step 4: Run parser tests**

Run: `bun test src/client/diff.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the parser**

```bash
git add src/client/diff.ts src/client/diff.test.ts
git commit -m "feat: parse unified diffs for presentation"
```

### Task 8: Implement the approved A-layout controls, Review, and Changes inspector

**Files:**
- Create: `src/client/components/TaskSettings.tsx`
- Create: `src/client/components/TaskSettings.test.tsx`
- Create: `src/client/components/ChangesPanel.tsx`
- Create: `src/client/components/ChangesPanel.test.tsx`
- Modify: `src/client/components/AppHeader.tsx`
- Modify: `src/client/components/Composer.tsx`
- Modify: `src/client/components/ThreadSidebar.tsx`
- Modify: `src/client/components/ActivityPanel.tsx`
- Modify: `src/client/components/Conversation.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/App.test.tsx`
- Modify: `src/client/workflows.test.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: Task 1 snapshot types, Task 5 client events, and Task 7 parser.
- Produces: task settings workflow, inline Review action, Running/Recent sidebar groups, and Activity/Changes inspector tabs.

- [ ] **Step 1: Use the `frontend-design` skill to translate approved mockup A into repo-native components**

Read `/Users/mac/.codex/skills/fronted-design/SKILL.md` before editing UI files. Preserve the existing dark visual identity while implementing the confirmed hierarchy; do not introduce a second design system or generic dashboard cards.

- [ ] **Step 2: Write failing `TaskSettings` interaction tests**

Prove allowed profiles can be selected, disallowed profiles are disabled with descriptions, model changes choose a supported/default effort, running turns display “Next turn”, and Review has exact disabled states.

```tsx
await user.selectOptions(screen.getByLabelText("Permission profile"), ":workspace");
expect(onSettingsChange).toHaveBeenCalledWith({ permissionProfile: ":workspace" });

await user.selectOptions(screen.getByLabelText("Reasoning effort"), "high");
expect(onSettingsChange).toHaveBeenCalledWith({ effort: "high" });
```

- [ ] **Step 3: Implement authoritative settings state in `App`**

Maintain draft defaults only in new-task mode. For a loaded task render `snapshot.threadSettings`, keep a pending field while `thread.settings.update` is in flight, clear it when the matching authoritative event arrives, and restore it on rejection. Register a bounded `window.focus` listener that requests `thread.list` so the server refreshes tasks when the browser becomes active. Treat `alreadyResolved` approval errors as a refresh race rather than an alert.

- [ ] **Step 4: Write failing sidebar, header, and focus-refresh tests**

Assert only resumed, directly controllable daemon tasks receive `LIVE · CLI`; source-only and Desktop/appServer history do not. Assert Running and Recent headings, live-handoff unavailable copy, settings controls, and Review action labels. Dispatch one `focus` event and assert exactly one `thread.list` browser request.

- [ ] **Step 5: Implement sidebar grouping and task header controls**

Move model and effort into the cohesive task settings group. Keep the composer model control only for a new-task draft; a loaded task uses the header's authoritative settings. Add a visible “Start Web before CLI” hint only when macOS handoff is unavailable or no daemon task is live.

- [ ] **Step 6: Write failing `ChangesPanel` tests**

Render two files, select the second, verify line numbers and add/delete classes, verify counts, and verify malformed input renders the original raw `<pre>` fallback. Cover empty, running, failed, and truncated states.

- [ ] **Step 7: Implement Activity/Changes tabs and structured diff viewer**

Keep approvals and token usage in Activity. Build the Changes file list from turn-level diff first and complete file-change items as fallback. Preserve selection by path across updates when possible. Use native buttons, `aria-selected`, an `aria-label="Changes"` panel, and horizontal scrolling only on the code region.

- [ ] **Step 8: Update conversation activity rows and responsive CSS**

File-change conversation rows summarize all paths and open the Changes tab. At tablet widths make the inspector a drawer; at phone widths expose Tasks, Chat, Activity, and Changes as exclusive views. Ensure 320px layout has no page-level horizontal overflow.

- [ ] **Step 9: Run component and workflow tests**

Run: `bun run typecheck && bun test src/client/components/TaskSettings.test.tsx src/client/components/ChangesPanel.test.tsx src/client/App.test.tsx src/client/workflows.test.tsx`

Expected: PASS.

- [ ] **Step 10: Commit the approved UI**

```bash
git add src/client/components/TaskSettings.tsx src/client/components/TaskSettings.test.tsx src/client/components/ChangesPanel.tsx src/client/components/ChangesPanel.test.tsx src/client/components/AppHeader.tsx src/client/components/Composer.tsx src/client/components/ThreadSidebar.tsx src/client/components/ActivityPanel.tsx src/client/components/Conversation.tsx src/client/App.tsx src/client/App.test.tsx src/client/workflows.test.tsx src/client/styles.css
git commit -m "feat: add task controls review and diff workspace"
```

### Task 9: End-to-end coverage, documentation, and full verification

**Files:**
- Modify: `tests/fixtures/fake-codex.ts`
- Modify: `tests/e2e/daily-workflow.pw.ts`
- Create: `tests/smoke/shared-daemon.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: affected test fixtures under `src/client` and `src/server`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: fake-native coverage and opt-in macOS shared-daemon smoke command.

- [ ] **Step 1: Extend fake Codex with native settings, review, and diff behavior**

Return models with effort metadata and `permissionProfile/list` data. Handle `thread/settings/update` by emitting `thread/settings/updated`. Handle `review/start` by emitting entered-review, assistant result, exited-review, and terminal turn messages. Emit a two-file `turn/diff/updated` plus complete file-change item during the normal turn.

- [ ] **Step 2: Write the failing Playwright workflow**

The test must:

1. open the existing CLI-labeled task;
2. verify `LIVE · CLI` after resume;
3. select an allowed permission profile and `high` effort;
4. run Review and observe the final review message;
5. open Changes, select the second file, and verify its added line;
6. return to Chat and continue the same task.

- [ ] **Step 3: Run the focused E2E test and observe missing behavior**

Run: `bun run test:e2e -- tests/e2e/daily-workflow.pw.ts`

Expected before fixture/UI completion: FAIL at the first missing live/settings/Review/Diff assertion.

- [ ] **Step 4: Add an opt-in shared-daemon smoke test**

Add `test:smoke:daemon` and require both `CODEX_WEB_SMOKE=1` and macOS. Use an isolated temporary `CODEX_HOME`, start the daemon through the built binary, connect two Unix-socket clients, initialize both, start a thread on client A, resume it on client B, and verify both receive its next turn. Close clients and verify `codex app-server daemon version` still reports running; then stop only the isolated test daemon in `finally`.

- [ ] **Step 5: Update README behavior and platform limits**

Document:

- Web or `codex app-server daemon start` must run before the CLI task;
- launch overrides may force embedded CLI mode;
- macOS supports live CLI handoff;
- Desktop tasks and Windows are history-only in this release;
- permission and effort are task-scoped;
- Review covers uncommitted changes and Changes preserves raw diff fallback.

- [ ] **Step 6: Run the full verification suite**

Run:

```bash
bun run typecheck
bun test
bun run build
bun run test:e2e
```

Expected: all commands exit `0` with no failing tests.

- [ ] **Step 7: Run targeted UI QA at desktop, tablet, and phone sizes**

Use the in-app browser against the fake E2E server at 1440×900, 900×900, and 390×844. Verify no clipped controls, no page-level horizontal overflow, keyboard-visible focus, inspector drawer behavior, readable diff lines, and accurate empty/running/error states. Save screenshots only under Playwright output or another ignored test-artifact directory.

- [ ] **Step 8: Request code review and address findings**

Use `superpowers:requesting-code-review` against the complete diff. Apply only verified in-scope corrections, rerun the affected focused tests after each correction, and rerun the full verification suite afterward.

- [ ] **Step 9: Commit E2E, docs, and verification support**

```bash
git add tests/fixtures/fake-codex.ts tests/e2e/daily-workflow.pw.ts tests/smoke/shared-daemon.ts package.json bun.lock README.md src/client src/server
git commit -m "test: cover shared Codex web workflows"
```

- [ ] **Step 10: Run completion verification from a clean process state**

Use `superpowers:verification-before-completion`, then rerun:

```bash
git status --short
bun run typecheck
bun test
bun run build
bun run test:e2e
```

Expected: only pre-existing user-owned `.idea/` and ignored/local design-companion files remain untracked; every validation command exits `0`.
