# Windows Shared App-Server and Remote CLI Handoff Design

## Summary

Codex Web will add a Windows shared app-server mode that lets a user start a local Codex CLI session first, leave the machine, and later use Codex Web through Cloudflare Tunnel to observe and continue that same session. Sessions intended for live handoff start through a small PowerShell wrapper that connects the CLI to a user-scoped app-server listening on a loopback WebSocket endpoint. Codex Web connects to the same app-server instead of spawning its current private stdio process.

The shared process survives individual CLI and Codex Web clients. A CLI or browser disconnect therefore does not terminate the task. Sessions started with ordinary `codex` remain discoverable; while their CLI owns the writer, Codex Web opens them through `thread/read` as explicitly read-only, periodically refreshed history.

The design targets `codex-cli 0.149.1`, whose app-server exposes `--listen ws://IP:PORT` and whose TUI accepts `--remote ws://IP:PORT`. Both features are experimental in the native CLI, so embedded stdio remains an automatic compatibility fallback and an explicit escape hatch.

## User Problem

The current Windows implementation launches a private `codex app-server --stdio` for Codex Web. An independently launched CLI owns its thread writer. The Web process can discover that thread through the shared Codex home, but `thread/resume` fails with `already has an active writer`. The adapter maps that native error to the generic browser-safe `codexRejected` response, so the user cannot see why the thread failed to open.

The required workflow is:

1. Start a Codex CLI session locally on Windows.
2. Leave the CLI and its work running.
3. Later reach Codex Web through Cloudflare Tunnel and Cloudflare Access.
4. Observe output, continue the conversation, resolve approvals, or interrupt the turn from the browser.
5. Return to the local CLI without losing the thread or its state.

## Goals

- Provide a short Windows command that starts a CLI session capable of later live Web handoff.
- Allow either the CLI wrapper or Codex Web to be the first client started.
- Keep the shared app-server and active tasks alive when a CLI, browser, or Codex Web disconnects normally.
- Let Codex Web discover, resume, observe, continue, approve, and interrupt shared CLI threads.
- Preserve read-only monitoring for an active thread started with ordinary `codex`.
- Preserve the existing authenticated browser boundary: Cloudflare exposes Codex Web, never the raw app-server.
- Fall back to the current embedded stdio mode when the installed Codex version or local environment cannot provide shared WebSocket mode.
- Keep macOS shared-daemon behavior unchanged.

## Non-goals

- Migrating an already-running embedded CLI thread into the shared app-server.
- Making every ordinary `codex` invocation transparently remote by replacing `codex.exe`, editing the user's shell profile, or modifying `~/.codex/config.toml`.
- Exposing the native app-server WebSocket through Cloudflare Tunnel or another network listener.
- Supporting non-loopback app-server endpoints in the managed Windows mode.
- Guaranteeing that an in-progress turn survives an app-server process crash or Windows logout/restart.
- Installing a Windows service, scheduled task, or machine-wide daemon in the first release.
- Supporting Linux or WSL as part of this change.

## Success Criteria

- Running `scripts\codex-web-cli.ps1` before Codex Web starts creates a CLI thread that later appears as `LIVE · CLI` and accepts browser input.
- Starting Codex Web first and the wrapper later produces the same shared behavior.
- Closing Codex Web does not interrupt a turn started from either client.
- Closing one CLI does not stop the shared app-server or unrelated threads.
- A thread currently owned by an ordinary CLI opens in the Web UI as read-only instead of showing `codexRejected`.
- Read-only monitoring refreshes visible history while the ordinary CLI continues writing.
- The app-server endpoint listens only on loopback and is not part of the Cloudflare routing configuration.
- Windows and macOS CI gates continue to pass, including typecheck, unit tests, build, Playwright, and platform launcher syntax checks.

## Approaches Considered

### 1. On-demand shared WebSocket process with a CLI wrapper — selected

The wrapper and Codex Web both call the same user-scoped coordinator. The first caller starts a detached loopback app-server; later callers verify and reuse it. The wrapper then starts `codex --remote` against that endpoint.

This satisfies CLI-first and Web-first startup without installing operating-system services. It uses the native cross-platform WebSocket interface and keeps the user-visible change limited to a dedicated command for handoff-capable sessions.

### 2. Windows logon service or scheduled task

A logon task could keep app-server running before any client and allow a shorter client path. It also introduces installation, elevation, upgrade, uninstall, and enterprise-policy concerns. It is deferred until the on-demand lifecycle has proven stable.

### 3. Web-owned app-server only

Codex Web could start the shared process and require users to launch Web before the CLI. This is simpler but does not satisfy the primary CLI-first workflow.

### 4. Read-only polling only

Polling `thread/read` solves monitoring for ordinary CLI threads but cannot provide input, approvals, or interruption because it does not share writer ownership. It is retained as a compatibility fallback, not the main architecture.

## Architecture

### Shared Windows mode

The shared app-server command is:

```text
codex app-server --listen ws://127.0.0.1:4500
```

The default endpoint is `ws://127.0.0.1:4500`. `CODEX_WEB_APP_SERVER_URL` may override the port, but managed mode accepts only a literal loopback host, the `ws` scheme, and a valid TCP port. It rejects credentials, query parameters, fragments, non-root paths, wildcard hosts, and non-loopback addresses.

Codex Web adds a TCP WebSocket implementation of the existing `JsonRpcTransport` interface. The maintained `ws` dependency owns the HTTP upgrade and WebSocket framing. `JsonRpcPeer`, `CodexAdapter`, normalized `WebState`, browser gateway, and browser WebSocket remain transport-independent.

The process manager attempts Windows shared mode before embedded mode. After connecting it performs the normal app-server `initialize` request and `initialized` notification. A successful handshake sets:

- process mode to `daemon`
- `liveHandoff` to `available`
- the native Codex version in the service snapshot

If shared startup or connection fails, Codex Web records a bounded local diagnostic and launches the existing private stdio app-server. Embedded mode reports `liveHandoff: "unavailable"` but preserves history, new tasks, attachments, approvals, and reviews.

macOS continues using its managed daemon and Unix-socket WebSocket transport. The new TCP transport does not replace or weaken Unix socket validation.

### Components

#### `WindowsSharedAppServerCoordinator`

The coordinator has a small interface:

```text
ensure(): Promise<{ endpoint, pid?, codexVersion }>
status(): Promise<stopped | starting | ready | incompatible>
stop(): Promise<void>
```

It is responsible only for validating configuration, serializing startup, spawning or verifying the shared process, bounding diagnostics, and returning connection information. It does not speak JSON-RPC beyond a readiness handshake and does not own browser state.

The implementation stores non-secret lifecycle metadata beneath `%LOCALAPPDATA%\Codex Web`:

- endpoint
- process ID when Codex Web started the process
- resolved Codex executable path
- observed Codex version
- lifecycle generation and start timestamp

Metadata is advisory. A PID file or open TCP port alone never proves readiness. Every caller verifies the endpoint by completing a WebSocket connection and native initialization handshake.

#### TCP WebSocket transport

`connectTcpWebSocket(endpoint)` adapts a `ws` client into `JsonRpcTransport`. It enforces:

- loopback endpoint validation before connection
- a five-second connection and upgrade timeout
- text frames only
- the existing 8 MiB native message bound
- one terminal close reason
- bounded send backpressure
- clean close and listener disposal

The app-server endpoint is internal configuration. It never crosses the normalized browser protocol.

#### Windows management script

`scripts\windows-shared-app-server.ps1` supports:

```text
start
status
stop
restart
```

`start` is idempotent. `stop` and `restart` act only on a process whose stored identity and verified endpoint match the Codex Web-managed instance. They never terminate an arbitrary process merely because it owns the configured port. Normal Codex Web shutdown does not call `stop`.

The PowerShell file is a thin entry point over a Bun lifecycle command so the Web server and scripts use one coordinator implementation. Background launches use a hidden window with inherited standard handles detached. After bounded startup diagnostics have been captured, long-lived standard output and error go to `NUL`; the design does not create an unbounded process log. Lifecycle failures are copied into `events.jsonl` through the existing redaction and truncation path.

#### CLI wrapper

`scripts\codex-web-cli.ps1`:

1. resolves Bun and the configured Codex executable using the same rules as the Windows Web launcher;
2. calls the shared coordinator's idempotent `ensure` entry point;
3. exports no secret configuration;
4. rejects user-supplied `--remote` and `--remote-auth-token-env` flags so the verified local endpoint cannot be replaced;
5. starts the foreground TUI as `codex --remote <endpoint>`, forwarding every other user argument unchanged after the remote arguments;
6. returns the native CLI exit code.

For example:

```powershell
.\scripts\codex-web-cli.ps1 -C C:\Projects\demo
```

The wrapper does not shadow `codex.exe`, modify `PATH`, or change the user's PowerShell profile. Documentation may suggest a user-created alias, but the project does not install one.

### Process ownership and lifetime

The shared app-server is user-scoped and independent of any one client:

- If the wrapper is first, it starts the hidden app-server and then the foreground CLI.
- If Codex Web is first, its coordinator starts the same hidden app-server before connecting.
- If both start concurrently, one acquires the startup lock; the other waits for readiness and reuses the result.
- Closing the browser, Codex Web, or any CLI only closes that client's connection.
- Explicit management commands or Windows logout/restart end the shared process.

The coordinator uses an exclusive lock file with a bounded acquisition timeout. A contender polls the readiness condition rather than sleeping for a fixed startup duration. A stale lock may be removed only after its age exceeds the startup deadline and the recorded process is absent or fails identity verification. Port ownership is never resolved by killing an unknown process.

The first release does not continuously supervise a shared process when no client is attached. If the app-server crashes, connected clients fail visibly. Codex Web retries with bounded backoff and may start a replacement; a newly invoked wrapper also repairs the stopped state. Persisted history can be resumed, but an in-progress turn is reported interrupted because crash survival is not guaranteed.

### Version changes

If the resolved `codex.exe` version differs from a running verified shared process, clients may continue using the running version. Codex Web shows a bounded restart-required diagnostic and does not automatically terminate the process because doing so could interrupt active work. The explicit `restart` command applies the new version.

## Data Flow

### Shared CLI starts first

```text
codex-web-cli.ps1
  -> coordinator.ensure
  -> start or verify loopback app-server
  -> codex --remote ws://127.0.0.1:4500
  -> thread/start and live events on the shared server

later:

Codex Web
  -> coordinator.ensure
  -> connect to the existing server
  -> initialize
  -> thread/list
  -> thread/open -> thread/resume
  -> normalized events -> authenticated browser
```

### Codex Web starts first

Codex Web starts the shared process and connects. A later wrapper verifies the endpoint and starts the remote TUI. Thread discovery continues through the existing catalog refresh and focus refresh mechanisms.

### Remote browser access

```text
Browser
  -> Cloudflare Tunnel and Access
  -> Codex Web HTTP/WebSocket on 127.0.0.1:4173
  -> normalized BrowserGateway actions
  -> local app-server connection on 127.0.0.1:4500
```

Cloudflare never routes to port 4500. The browser never speaks native app-server JSON-RPC.

### Ordinary CLI thread

An ordinary `codex` process still owns its private writer. Selecting its thread calls the server-side `thread.open` flow:

1. attempt native `thread/resume`;
2. if and only if the native response is classified as `already has an active writer`, call `thread/read` with turns;
3. load the returned history with access mode `historyOnly` and reason `activeWriter`;
4. refresh while that thread remains selected and at least one browser is connected;
5. retry normal resume after the catalog reports a state change or the user selects the thread again.

This fallback does not claim live handoff. It cannot start or interrupt turns and cannot resolve approvals owned by the private CLI.

## Browser Protocol and State

The browser protocol version increments. The client replaces its unconditional `thread.resume` selection request with:

```text
thread.open { threadId }
```

The server owns resume-versus-read policy so native error strings and transport mode remain private. Existing `thread.resume` and `thread.read` may remain temporarily for protocol compatibility and focused diagnostics, but the production client no longer chooses between them.

The loaded thread state adds:

```text
threadAccess: {
  threadId: string
  mode: "readWrite" | "historyOnly"
  reason?: "activeWriter" | "unsupportedSource" | "sharedModeUnavailable"
}
```

`canAcceptDirectInput` remains the authoritative native capability when present. `threadAccess.mode` describes the result of this Web server's actual open attempt. Mutating gateway methods require all of the following:

- the requested thread is loaded;
- `threadAccess.mode` is `readWrite`;
- native `canAcceptDirectInput` is `true`;
- no conflicting active turn or review exists.

The client displays a concise read-only banner derived from the normalized reason. It never displays the raw `already has an active writer` text or treats history-only access as a service failure.

## Read-Only Monitoring

`HistoryThreadRefresher` provides best-effort monitoring for a selected ordinary CLI thread:

- it runs only for a loaded `historyOnly` thread while at least one browser is connected;
- refreshes are single-flight and stop immediately when selection or access mode changes;
- the default interval is three seconds;
- a catalog `updatedAt` change triggers an immediate refresh;
- unchanged reads do not emit a duplicate `thread.loaded` browser event;
- visible items retain the existing 500-item and payload bounds;
- failures use bounded backoff up to thirty seconds and remain local diagnostics unless history becomes unavailable;
- browser focus triggers an immediate refresh.

Shared `readWrite` threads never use this polling path because they receive native live events.

## Concurrency and State Races

- A native active turn disables new input in both the browser projection and local CLI behavior enforced by app-server.
- If CLI and Web submit simultaneously while idle, app-server decides the winner. The rejected client refreshes authoritative thread state instead of retrying automatically.
- Approval resolution remains first-writer-wins. A later `alreadyResolved` result is a benign synchronization race.
- Native settings changes, interruptions, and turn events replace Web state authoritatively.
- If a shared connection drops, the Web service rejects in-flight browser requests as interrupted, reconnects, resumes the loaded thread, and publishes a fresh snapshot.
- The history-only refresher and a manual open are single-flight per thread so stale reads cannot overwrite a newer selected thread.
- A transition from history-only to read-write clears old polling state before enabling mutations.

## Error Handling

### Startup failure matrix

| Failure | CLI wrapper behavior | Codex Web behavior |
| --- | --- | --- |
| Codex executable missing or incompatible | Exit with actionable error | Fall back to embedded mode when possible |
| Configured endpoint is not loopback | Reject configuration | Reject configuration; do not connect |
| Port owned by another verified Codex app-server | Reuse it | Reuse it |
| Port owned by an unknown process | Exit without killing it | Fall back to embedded mode with diagnostic |
| Startup lock contention | Wait on readiness up to deadline | Wait on readiness up to deadline |
| Shared handshake timeout | Exit with diagnostic ID | Fall back to embedded mode |
| Running version differs | Continue and recommend explicit restart | Continue and expose restart-required diagnostic |

The browser receives safe, normalized messages. Detailed process output, native errors, endpoint failures, and diagnostic IDs stay in the bounded local log.

### Active-writer classification

The adapter must preserve enough internal error information to distinguish an active-writer conflict from generic `codexRejected`. The fallback is deliberately narrow: it matches the native response class and the normalized active-writer condition. Authentication failures, overload, malformed requests, and compatibility failures never silently become history-only success.

If a future native protocol adds a structured writer-conflict error code, the adapter switches to that code while retaining the compatibility match for the minimum supported CLI version.

## Security

- Managed app-server URLs must resolve syntactically to literal loopback; DNS hostnames are not accepted.
- The native listener uses plain `ws` only because it is loopback-only. Remote app-server endpoints and `wss` deployment are outside this feature.
- Cloudflare Tunnel exposes only Codex Web. Documentation explicitly warns against routing the native port.
- Existing Cloudflare Access issuer, audience, expiry, owner-email, and Origin checks remain mandatory in remote mode.
- Browser HTTP and WebSocket payload limits remain unchanged.
- Native messages, request IDs, lifecycle metadata, executable paths, app-server URLs, and process logs never cross the browser protocol.
- Lifecycle metadata contains no bearer tokens or account credentials.
- Spawned processes inherit the existing filtered environment handling and local log secret redaction.
- Management `stop` and `restart` verify process identity before termination and never act only on a PID or occupied port.
- The feature does not edit Codex global configuration, shell profiles, PATH, Windows services, firewall rules, or Cloudflare configuration.

## User Interface

- Shared CLI threads retain the existing `LIVE · CLI` badge only after a successful shared resume and direct-input capability confirmation.
- Active ordinary CLI threads show a `READ ONLY · LOCAL CLI` badge.
- A history-only banner explains: "This CLI task was not started in shared mode. You can monitor it here, but continue it from the local CLI."
- Composer, settings, Review, approval actions, and interrupt controls are disabled in history-only mode with the same reason available as a tooltip.
- Shared transport fallback is visible in the existing service diagnostic area without blocking embedded functionality.
- The sidebar footer distinguishes `Shared Codex`, `Local Codex`, reconnecting, and unavailable states.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_WEB_WINDOWS_SHARED` | `auto` | `auto`, `required`, or `off` shared-mode policy |
| `CODEX_WEB_APP_SERVER_URL` | `ws://127.0.0.1:4500` | Loopback shared app-server endpoint |
| `CODEX_WEB_CODEX_EXECUTABLE` | PATH lookup | Absolute Codex executable override |

Policy behavior:

- `auto`: try shared mode and fall back to embedded stdio.
- `required`: fail Web startup readiness if shared mode is unavailable; the CLI wrapper always behaves as required.
- `off`: retain the current embedded Windows behavior; the wrapper reports that shared mode is disabled.

The setting is process-local and does not alter `~/.codex/config.toml`.

## Testing Strategy

### Coordinator and lifecycle unit tests

- endpoint validation accepts only the supported loopback shape;
- first caller starts the process and later callers reuse it;
- concurrent callers produce one ready server;
- stale lock recovery observes timeout and process identity rules;
- unknown port owners are never terminated;
- readiness requires WebSocket plus initialize, not TCP connect alone;
- startup output, timeout, and diagnostics remain bounded;
- version mismatch warns without automatic restart;
- normal client shutdown leaves the shared process running;
- explicit stop verifies identity and cleans only owned metadata.

### TCP WebSocket transport tests

- initialize and bidirectional JSON-RPC text messages;
- ping, pong, close, reconnect, and one terminal error;
- binary-frame rejection;
- connection timeout, malformed upgrade, payload limit, and backpressure;
- loopback validation before any network operation.

Tests use ephemeral fake-server ports; they do not depend on port 4500.

### Adapter, state, and gateway tests

- `thread.open` resumes a shared thread and marks it read-write;
- only an active-writer conflict falls back to `thread/read`;
- generic Codex rejection remains an error;
- history-only state blocks every mutation server-side;
- unchanged monitoring reads do not emit duplicate loads;
- selection changes cancel stale refresh results;
- catalog changes trigger immediate history refresh;
- successful later resume transitions atomically to read-write;
- reconnect restores the selected shared thread and authoritative state.

### Client tests

- shared and read-only badges follow actual access state;
- history-only banner and disabled reasons are accessible;
- shared threads retain composer, approval, Review, settings, and interrupt workflows;
- fallback diagnostics do not hide otherwise usable embedded mode;
- mobile and desktop layouts display the access state without relying on color alone.

### PowerShell launcher tests

- parse both Windows scripts with the PowerShell parser in CI;
- preserve arguments containing spaces, quotes, Unicode, and `--`;
- return the native CLI exit code;
- surface coordinator failure without launching a private CLI accidentally;
- launch background helpers hidden;
- never modify PATH, profiles, global config, services, or firewall rules.

### End-to-end tests

The fake Codex fixture gains a WebSocket listener and multi-client shared-thread behavior. Playwright covers:

1. wrapper-equivalent shared server starts before Web;
2. Web discovers and resumes the CLI-created thread;
3. CLI-originated output appears in the browser;
4. browser input appears through the same shared thread;
5. approval and interruption work from the browser;
6. disconnecting Web does not terminate active work;
7. an active private-writer fixture opens and refreshes as history-only.

An opt-in Windows native smoke test uses an isolated temporary Codex home and an unused loopback port. It starts one real shared app-server and two clients, runs a minimal model turn, verifies cross-client observation and continuation, archives the temporary thread, then stops only the test-owned process. It requires an explicit environment flag because it consumes model usage.

### CI gates

The existing macOS and Windows matrix remains authoritative:

```text
bun install --frozen-lockfile
platform launcher syntax check
bun run typecheck
bun test
bun run build
bun run test:e2e
```

The Windows job additionally parses both new PowerShell scripts. Native smoke tests remain opt-in and are not part of pull-request CI.

## Rollout

1. Land coordinator, TCP transport, process-manager selection, and fake-server coverage behind `CODEX_WEB_WINDOWS_SHARED=off` in tests that require legacy behavior.
2. Add the wrapper and management scripts, then exercise the Windows native smoke test manually.
3. Change the Windows default to `auto`, retaining `off` as an immediate rollback switch.
4. Update README startup instructions, Cloudflare guidance, troubleshooting, and the Windows capability table.
5. Record the minimum verified Codex CLI version as `0.149.1`; older versions fall back in `auto` and fail clearly in `required`.

The release notes must state that only wrapper-started or otherwise `--remote`-connected CLI threads are writable from Web. Existing and ordinary CLI threads are monitored read-only until their owning CLI exits.

## Documentation Examples

Start a handoff-capable CLI:

```powershell
.\scripts\codex-web-cli.ps1 -C C:\Projects\demo
```

Start Codex Web now or later:

```powershell
.\scripts\start-windows.ps1
```

Inspect or restart the shared service during maintenance:

```powershell
.\scripts\windows-shared-app-server.ps1 status
.\scripts\windows-shared-app-server.ps1 restart
```

The remote browser continues using the configured Codex Web public URL. No Cloudflare route is added for the app-server port.

## Implementation Boundaries

The implementation should remain divided into independently testable units:

- platform-neutral TCP WebSocket transport;
- Windows-only lifecycle coordinator;
- process-manager mode selection and fallback;
- adapter-level thread-open policy;
- history-only refresh coordinator;
- normalized protocol and UI projection;
- thin PowerShell entry points.

No unrelated UI redesign, app-server protocol expansion, global configuration migration, or macOS daemon refactor is part of this work.
