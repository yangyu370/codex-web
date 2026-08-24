# Windows Shared App-Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Windows CLI-first/Web-first live handoff through a managed loopback app-server while retaining the macOS native daemon and sharing all connection, access-state, and UI policy above the lifecycle backend.

**Architecture:** `AppServerProcessManager` consumes a platform-selected `SharedAppServerBackend`; macOS uses the current native daemon and Unix socket, Windows uses a lifecycle coordinator and TCP WebSocket, and both fall back to embedded stdio. Thread open/read-only monitoring and browser state are platform-neutral.

**Tech Stack:** Bun 1.3+, TypeScript, Node-compatible process/filesystem APIs, `ws` 8.x, PowerShell, React 19, Zustand, Zod, Bun test, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-24-windows-shared-app-server-design.md`

## Global Constraints

- Target `codex-cli 0.149.1`; `--listen ws://IP:PORT` and TUI `--remote` are experimental.
- Managed Windows endpoints accept only `ws`, a literal loopback address, a root path, and a valid TCP port.
- Cloudflare exposes Codex Web only; native app-server endpoints never enter the browser protocol.
- macOS retains `codex app-server daemon start` and validated Unix-socket WebSocket behavior.
- Windows `auto` falls back to embedded stdio, `required` fails readiness, and `off` skips shared mode.
- Ordinary active-writer CLI threads are history-only; every mutating gateway action is blocked server-side.
- Normal Web or CLI disconnect does not stop shared app-server work.
- Unknown port owners and mismatched managed identities are never terminated or reused.
- Lifecycle output, native messages, browser messages, visible items, and diagnostics remain bounded.
- No PATH, profile, global Codex config, service, scheduled-task, firewall, or Cloudflare mutations.

## File Structure

- `src/server/app-server/shared-backend.ts`: shared backend contracts and platform selection.
- `src/server/app-server/macos-daemon-backend.ts`: current native daemon lifecycle adapter.
- `src/server/app-server/tcp-websocket-transport.ts`: loopback endpoint validation and `ws` transport.
- `src/server/app-server/windows-shared-coordinator.ts`: lock, metadata, identity, readiness, status, and stop policy.
- `src/server/app-server/windows-app-server-host.ts`: detached Windows host that drains bounded diagnostics and owns the native child.
- `scripts/app-server-lifecycle.ts`: Bun CLI used by Web-facing and PowerShell lifecycle commands.
- `scripts/windows-shared-app-server.ps1`: thin `start/status/stop/restart` entry point.
- `scripts/codex-web-cli.ps1`: handoff-capable foreground TUI wrapper.
- `src/server/app-server/process-manager.ts`: shared-first connection policy, initialization, reconnect, and embedded fallback.
- `src/server/app-server/adapter.ts`: structured native error preservation and open/read behavior.
- `src/server/service/thread-access.ts`: `thread.open` access decision and mutation guards.
- `src/server/service/history-thread-refresher.ts`: selected history-only polling.
- `src/server/service/state.ts`: normalized `threadAccess` and split version state.
- `src/shared/protocol.ts`: protocol version, `thread.open`, access and service fields.
- Client workflow/sidebar/composer files: read-only banner, badges, and disabled reasons.
- Fake server, unit tests, Playwright, smoke tests, CI, and README: cross-platform verification and documentation.

---

### Task 1: Shared Backend Contract and macOS Adapter

**Files:**
- Create: `src/server/app-server/shared-backend.ts`
- Create: `src/server/app-server/macos-daemon-backend.ts`
- Create: `src/server/app-server/shared-backend.test.ts`
- Modify: `src/server/app-server/process-manager.ts`
- Modify: `src/server/app-server/process-manager.test.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Produces: `SharedBackendKind = "nativeDaemon" | "managedTcp"`.
- Produces: `SharedServerInfo { backend, cliVersion, appServerVersion?, endpoint }`.
- Produces: `SharedAppServerBackend.ensureAndConnect(context): Promise<{ info, transport }>`.
- Produces: `selectSharedAppServerBackend(platform, options)`.

- [x] **Step 1: Write failing contract tests** proving macOS selects `nativeDaemon`, Windows `off` selects no backend, and manager snapshots use `mode: "shared"` without stopping the shared process.

```ts
expect(selectSharedAppServerBackend(macPlatform, options)?.kind).toBe("nativeDaemon");
expect(selectSharedAppServerBackend(winPlatform, { ...options, windowsPolicy: "off" })).toBeUndefined();
expect(manager.snapshot()).toMatchObject({ mode: "shared", sharedBackend: "nativeDaemon" });
```

- [x] **Step 2: Run `bun test src/server/app-server/shared-backend.test.ts src/server/app-server/process-manager.test.ts` and verify failures mention missing contract/types.**

- [x] **Step 3: Implement the contract and move current daemon start/connect wiring into `MacNativeDaemonBackend` without changing socket validation or fallback behavior.**

```ts
export interface SharedAppServerBackend {
  readonly kind: SharedBackendKind;
  ensureAndConnect(context: SharedBackendContext): Promise<{
    info: SharedServerInfo;
    transport: JsonRpcTransport;
  }>;
}
```

- [x] **Step 4: Change the manager to consume the selected backend, report `cliVersion` and `appServerVersion` separately, and keep `codexVersion` as a compatibility alias for the actual running app-server version.**

- [x] **Step 5: Run the focused tests and `bun run typecheck`; expect PASS.**

- [x] **Step 6: Commit with `git commit -m "refactor: abstract shared app server backend"`.**

### Task 2: TCP WebSocket Transport and Endpoint Validation

**Files:**
- Create: `src/server/app-server/tcp-websocket-transport.ts`
- Create: `src/server/app-server/tcp-websocket-transport.test.ts`

**Interfaces:**
- Produces: `parseManagedLoopbackEndpoint(source): URL`.
- Produces: `connectTcpWebSocket(endpoint, options?): Promise<JsonRpcTransport>`.

- [x] **Step 1: Write failing table tests** for `127.0.0.1`, `[::1]`, invalid schemes, credentials, hostname aliases, paths, queries, fragments, missing/invalid ports, binary frames, oversized frames, timeout, clean close, and backpressure.

```ts
expect(parseManagedLoopbackEndpoint("ws://127.0.0.1:4500").href)
  .toBe("ws://127.0.0.1:4500/");
expect(() => parseManagedLoopbackEndpoint("ws://localhost:4500"))
  .toThrow("literal loopback");
```

- [x] **Step 2: Run `bun test src/server/app-server/tcp-websocket-transport.test.ts`; expect missing-module failure.**

- [x] **Step 3: Implement transport with `ws`, `handshakeTimeout: 5000`, `maxPayload: 8_388_608`, text-only messages, a 1 MiB send-buffer ceiling, callback-backed send promises, and one terminal close notification.**

- [x] **Step 4: Run the focused transport tests and Unix transport tests; expect PASS.**

- [x] **Step 5: Commit with `git commit -m "feat: add loopback tcp websocket transport"`.**

### Task 3: Windows Shared Lifecycle Coordinator

**Files:**
- Create: `src/server/app-server/windows-shared-coordinator.ts`
- Create: `src/server/app-server/windows-shared-coordinator.test.ts`
- Create: `src/server/app-server/windows-app-server-host.ts`
- Create: `scripts/app-server-lifecycle.ts`
- Modify: `src/server/platform/types.ts`
- Modify: `src/server/platform/system-runtime.ts`

**Interfaces:**
- Produces: `WindowsSharedAppServerCoordinator.ensure/status/stop/restart`.
- Produces: `WindowsSharedMetadata` keyed by canonical `CODEX_HOME` and containing endpoint, host/native PID, executable, CLI/app-server versions, generation, and timestamp.
- Produces: lifecycle CLI JSON results with exit codes 0 for success and nonzero for incompatible/conflict/failure.

- [x] **Step 1: Write failing coordinator tests** with injected filesystem/process/readiness operations for first start, concurrent single-flight, matching reuse, stale-lock recovery, malformed metadata, mismatched `CODEX_HOME`, unknown port owner, version mismatch, verified stop, and refusal to kill arbitrary PIDs.

```ts
await Promise.all([coordinator.ensure(), coordinator.ensure()]);
expect(fakeHost.starts).toBe(1);
await expect(mismatched.ensure()).rejects.toThrow("managed identity mismatch");
expect(fakeHost.terminated).toEqual([]);
```

- [x] **Step 2: Run the coordinator test and verify missing-module failure.**

- [x] **Step 3: Implement strict JSON metadata parsing, atomic `wx` lock acquisition, bounded readiness polling, stale-lock rules, and identity checks. Namespace files by a SHA-256 digest of canonical `CODEX_HOME`.**

- [x] **Step 4: Implement the detached host subcommand using a hidden detached Windows process, drain child output into a 256 KiB rotating diagnostic file, write host/native identity atomically, and exit with the native child.**

- [x] **Step 5: Implement readiness using TCP WebSocket plus `initialize`/`initialized`, closing the probe connection afterward.**

- [x] **Step 6: Run coordinator, transport, platform runtime tests, and typecheck; expect PASS.**

- [x] **Step 7: Commit with `git commit -m "feat: coordinate windows shared app server"`.**

### Task 4: Windows Backend Selection, Policy, and Reconnect

**Files:**
- Create: `src/server/app-server/windows-managed-backend.ts`
- Create: `src/server/app-server/windows-managed-backend.test.ts`
- Modify: `src/server/app-server/shared-backend.ts`
- Modify: `src/server/app-server/process-manager.ts`
- Modify: `src/server/app-server/process-manager.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/shared/protocol.ts`

**Interfaces:**
- Consumes: coordinator and TCP transport from Tasks 2-3.
- Produces: `parseWindowsSharedPolicy(value): "auto" | "required" | "off"`.
- Produces: service fields `cliVersion?`, `appServerVersion?`, `restartRequired?`.

- [x] **Step 1: Write failing tests** for `auto` success/fallback, `required` fatal readiness, `off` embedded behavior, reconnect after shared close, and Web shutdown detaching without interrupting.

- [x] **Step 2: Run focused tests and verify the expected policy/backend failures.**

- [x] **Step 3: Implement `WindowsManagedBackend` and select it only on Windows when policy is not `off`; keep all platform branching in backend selection.**

- [x] **Step 4: Update process snapshots and normalized service state without exposing backend endpoints or lifecycle metadata.**

- [x] **Step 5: Run focused tests, protocol tests, and typecheck; expect PASS.**

- [x] **Step 6: Commit with `git commit -m "feat: select shared backend by platform"`.**

### Task 5: Windows PowerShell Management and CLI Wrappers

**Files:**
- Create: `scripts/windows-shared-app-server.ps1`
- Create: `scripts/codex-web-cli.ps1`
- Create: `scripts/windows-launchers.test.ts`
- Modify: `scripts/start-windows.ps1`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: management commands `start`, `status`, `stop`, `restart`.
- Produces: `codex-web-cli.ps1 [codex arguments...]` forwarding to `codex --remote <verified endpoint>`.

- [x] **Step 1: Write failing launcher tests** that parse both scripts, verify lifecycle command construction, reject `--remote` and `--remote-auth-token-env` in both split and `=` forms, preserve `--`, Unicode, quotes and spaces, and return the native exit code.

- [x] **Step 2: Run `bun test scripts/windows-launchers.test.ts`; expect missing-script failures.**

- [x] **Step 3: Implement thin scripts that resolve Bun/repo paths, invoke `scripts/app-server-lifecycle.ts`, parse its bounded JSON endpoint, and use PowerShell's call operator with an argument array.**

- [x] **Step 4: Add `CODEX_WEB_WINDOWS_SHARED` validation to `start-windows.ps1` without changing global configuration.**

- [x] **Step 5: Add CI PowerShell parser checks and run tests/typecheck; if `pwsh` is unavailable locally, assert the Bun structural tests and leave the native parser to Windows CI.**

- [x] **Step 6: Commit with `git commit -m "feat: add windows shared cli launchers"`.**

### Task 6: Platform-Neutral Thread Open and Access State

**Files:**
- Create: `src/server/service/thread-access.ts`
- Create: `src/server/service/thread-access.test.ts`
- Modify: `src/server/app-server/json-rpc.ts`
- Modify: `src/server/app-server/adapter.ts`
- Modify: `src/server/app-server/adapter.test.ts`
- Modify: `src/server/service/state.ts`
- Modify: `src/server/service/state.test.ts`
- Modify: `src/server/service/gateway.ts`
- Modify: `src/server/service/gateway.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/shared/protocol.test.ts`

**Interfaces:**
- Produces: browser method `thread.open { threadId }`.
- Produces: `ThreadAccess { threadId, mode: "readWrite" | "historyOnly", reason? }`.
- Produces: internal structured `JsonRpcResponseError` inspection without exposing raw native text to browsers.

- [x] **Step 1: Write failing tests** proving successful resume becomes read-write, only active-writer rejection falls back to `thread/read`, generic rejection stays an error, and every mutation rejects history-only state.

```ts
await access.open("thread-1");
expect(state.snapshot().threadAccess).toEqual({
  threadId: "thread-1", mode: "historyOnly", reason: "activeWriter",
});
```

- [x] **Step 2: Run focused tests and verify missing access state/method failures.**

- [x] **Step 3: Preserve bounded native error code/message/data internally; implement the narrow active-writer classifier for the 0.149.1 response shape.**

- [x] **Step 4: Implement `ThreadAccessController.open`, atomically update loaded history and access state, and centralize mutation checks in the gateway.**

- [x] **Step 5: Increment browser protocol version and remove production client dependence on choosing resume versus read.**

- [x] **Step 6: Run adapter/state/gateway/protocol tests and typecheck; expect PASS.**

- [ ] **Step 7: Commit with `git commit -m "feat: open active cli threads safely"`.**

### Task 7: History-Only Monitoring

**Files:**
- Create: `src/server/service/history-thread-refresher.ts`
- Create: `src/server/service/history-thread-refresher.test.ts`
- Modify: `src/server/service/thread-catalog.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Produces: `HistoryThreadRefresher.select(access)`, `browserConnected`, `browserDisconnected`, `focus`, `catalogUpdated`, and `close`.

- [ ] **Step 1: Write failing fake-timer tests** for three-second polling, zero polling without browsers, single-flight reads, unchanged-history suppression, catalog-triggered refresh, focus refresh, selection cancellation, read-write transition cleanup, and exponential backoff capped at thirty seconds.

- [ ] **Step 2: Run the focused test and verify missing-module failure.**

- [ ] **Step 3: Implement the refresher with injected clock/read/project callbacks and generation checks so stale reads cannot replace a newer selection.**

- [ ] **Step 4: Wire browser connection count, focus requests, catalog updates, and thread-open transitions through the server.**

- [ ] **Step 5: Run refresher, catalog, server, and gateway tests; expect PASS.**

- [ ] **Step 6: Commit with `git commit -m "feat: refresh history only cli threads"`.**

### Task 8: Read-Only and Shared UI Projection

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/workflows.ts`
- Modify: `src/client/workflows.test.tsx`
- Modify: `src/client/components/ThreadSidebar.tsx`
- Modify: `src/client/components/ThreadSidebar.test.tsx`
- Modify: composer/settings/review components and tests selected by current ownership.
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: normalized `threadAccess` and `service.liveHandoff` only.
- Produces: `LIVE · CLI`, `READ ONLY · LOCAL CLI`, history-only banner, disabled controls, and `Shared Codex`/`Local Codex` service labels.

- [ ] **Step 1: Write failing Testing Library tests** for badges, banner copy, disabled composer/settings/review/approval/interrupt actions, tooltip reasons, keyboard accessibility, and mobile/desktop rendering without color-only meaning.

- [ ] **Step 2: Run focused client tests and verify missing projection failures.**

- [ ] **Step 3: Change selection to send `thread.open`, derive all mutability from `threadAccess`, and render the approved labels/copy.**

- [ ] **Step 4: Run focused client tests, typecheck, and build; expect PASS.**

- [ ] **Step 5: Commit with `git commit -m "feat: show shared and history only task access"`.**

### Task 9: End-to-End Coverage, Smoke Test, Documentation, and Rollout

**Files:**
- Modify: fake Codex fixture files under `tests/fixtures/`.
- Modify: Playwright specs under `tests/e2e/`.
- Create: `tests/smoke/windows-shared-app-server.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: fake multi-client WebSocket app-server and private active-writer modes.
- Produces: `CODEX_WEB_SMOKE_WINDOWS=1 bun run test:smoke:windows-shared`.

- [ ] **Step 1: Extend the fake server with loopback WebSocket multi-client notifications, active writer rejection, thread/read updates, and disconnect survival.**

- [ ] **Step 2: Add Playwright cases** for CLI-first, Web-first, bidirectional input, approvals, interruption, Web disconnect survival, ordinary CLI read-only monitoring, and later read-write transition.

- [ ] **Step 3: Add an opt-in Windows smoke script using isolated `CODEX_HOME`, an unused loopback port, explicit owned cleanup, one minimal model turn, and temporary thread archival.**

- [ ] **Step 4: Update README with wrapper usage, management commands, `auto|required|off`, loopback-only Cloudflare warning, version mismatch guidance, and the distinction between wrapper-started live tasks and ordinary read-only tasks.**

- [ ] **Step 5: Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run build`, and `bun run test:e2e`; expect all required gates PASS.**

- [ ] **Step 6: Run `git diff --check`, inspect `git status --short`, and verify only feature/spec/plan changes are included.**

- [ ] **Step 7: Commit with `git commit -m "test: verify windows shared cli handoff"`.**
