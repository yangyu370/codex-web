# Message Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload browser files into a temporary project-local directory, pass them to one Codex turn as context, and delete them on every terminal turn outcome.

**Architecture:** Authenticated HTTP endpoints stream file bytes into an `AttachmentStore`; WebSocket `turn.start` carries only an opaque session ID. A turn coordinator converts validated server metadata into app-server text and `localImage` inputs, while state events drive idempotent cleanup. The client owns only upload progress and safe metadata.

**Tech Stack:** Bun 1.3+, TypeScript, React 19, native Node filesystem streams, app-server v2 JSON-RPC, Bun test, Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-08-18-message-attachments-design.md`

## Global Constraints

- Files are stored only under `<project>/.codex-web/attachments/<session-id>/` on the Codex host.
- Limits are 10 files per session, 20 MiB per file, 50 MiB per session, 100 live sessions, and 500 MiB host-wide.
- Accepted content is UTF-8 text/source, PDF, PNG, JPEG, WebP, or GIF; executable and unknown binary signatures fail closed.
- Browser messages contain opaque IDs and safe metadata, never absolute attachment paths or file bytes.
- Upload endpoints authorize before reading any body and enforce byte limits while streaming.
- Terminal `completed`, `failed`, and `interrupted` turns delete attachments; abandoned drafts expire after one hour.
- Every filesystem deletion revalidates UUID layout, canonical containment, and the ownership marker.
- macOS and Windows native paths must both remain supported.
- Every production behavior starts with a failing test and is committed only after focused tests pass.

---

### Task 1: Protocol-version gate and request timeout

**Files:**
- Create: `src/client/bootstrap.ts`
- Create: `src/client/bootstrap.test.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/server/service/state.ts`
- Modify: `src/client/main.tsx`
- Modify: `src/client/websocket.ts`
- Modify: `src/client/websocket.test.ts`

**Interfaces:**
- Produces: `WEB_PROTOCOL_VERSION = 2`
- Produces: required `BrowserSnapshot.protocolVersion: number`
- Produces: `assertCompatibleSnapshot(value: unknown): BrowserSnapshot`
- Produces: `CodexWebClientOptions.requestTimeoutMs` with a 15,000 ms default

- [ ] **Step 1: Write failing compatibility and timeout tests**

```ts
test("rejects a frontend/backend protocol mismatch before opening a socket", () => {
  expect(() => assertCompatibleSnapshot({ ...snapshot, protocolVersion: 1 }))
    .toThrow("Restart Codex Web to finish the update");
});

test("rejects a request whose correlated response never arrives", async () => {
  const client = new CodexWebClient(snapshot, () => socket, { requestTimeoutMs: 5 });
  client.connect();
  socket.onopen?.();
  await expect(client.request("directory.list", {})).rejects.toThrow("request timed out");
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun test src/client/bootstrap.test.ts src/client/websocket.test.ts`

Expected: FAIL because `assertCompatibleSnapshot`, `protocolVersion`, and timeout settlement do not exist.

- [ ] **Step 3: Implement the version and timeout boundaries**

Add the shared constant and snapshot field, emit it from `WebState.snapshot`, validate it before constructing `CodexWebClient`, and store a timeout handle per pending request. Clear the handle on response, socket close, and client close; ignore late responses.

```ts
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}
```

- [ ] **Step 4: Run focused tests and type checking**

Run: `bun test src/client/bootstrap.test.ts src/client/websocket.test.ts && bun run typecheck`

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the coherent compatibility boundary**

```bash
git add src/client/bootstrap.ts src/client/bootstrap.test.ts src/shared/protocol.ts src/server/service/state.ts src/client/main.tsx src/client/websocket.ts src/client/websocket.test.ts
git commit -m "fix: detect Codex Web protocol mismatches"
```

### Task 2: Secure attachment session layout and registry

**Files:**
- Create: `src/server/service/attachment-store.ts`
- Create: `src/server/service/attachment-store.test.ts`
- Modify: `src/shared/protocol.ts`

**Interfaces:**
- Produces: `AttachmentSessionSummary`, `AttachmentLimits`, and `AttachmentSummary` browser types
- Produces: `new AttachmentStore(platform, dataDirectory, options?)`
- Produces: `create(cwd): Promise<AttachmentSessionSummary>`
- Produces: `cancel(sessionId): Promise<void>`, `sweepExpired(): Promise<void>`, and `close(): Promise<void>`
- Produces: internal `AttachmentError` codes `invalidAttachment`, `attachmentTooLarge`, `attachmentCapacity`, and `attachmentExpired`

- [ ] **Step 1: Write failing real-filesystem session tests**

```ts
test("creates an opaque draft under the validated project", async () => {
  const session = await store.create(project);
  expect(session).toMatchObject({
    id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    limits: { files: 10, fileBytes: 20_971_520, totalBytes: 52_428_800 },
  });
  expect((await lstat(join(project, ".codex-web", "attachments", session.id))).isDirectory())
    .toBe(true);
});

test("refuses a symlinked attachment root", async () => {
  await symlink(outside, join(project, ".codex-web"));
  await expect(store.create(project)).rejects.toMatchObject({ code: "invalidWorkingDirectory" });
});
```

Also cover 100-session rejection, UUID-only cancellation, atomic bounded registry persistence, ownership-marker preservation of a pre-existing `.codex-web`, one-hour expiry, and untrusted registry entries that point outside the recorded project.

- [ ] **Step 2: Run the store test and verify RED**

Run: `bun test src/server/service/attachment-store.test.ts`

Expected: FAIL because the store module is absent.

- [ ] **Step 3: Implement session state and secure layout**

Use `lstat` before each path component, `mkdir` without following symlinks, UUID validation, canonical containment, an atomic registry file under `platform.dataDirectory()`, and a `.codex-web-owner.json` nonce marker. Keep at most 100 in-memory/registry sessions and schedule a 10-minute unref'ed sweep.

```ts
type SessionState = "draft" | "starting" | "consumed";
interface StoredSession {
  id: string;
  cwd: string;
  canonicalCwd: string;
  directory: string;
  createdAt: number;
  expiresAt: number;
  state: SessionState;
  files: Map<string, StoredAttachment>;
  totalBytes: number;
}
```

- [ ] **Step 4: Run focused tests and type checking**

Run: `bun test src/server/service/attachment-store.test.ts && bun run typecheck`

Expected: session, expiry, marker, registry, and escape tests pass.

- [ ] **Step 5: Commit session storage**

```bash
git add src/server/service/attachment-store.ts src/server/service/attachment-store.test.ts src/shared/protocol.ts
git commit -m "feat: add secure attachment sessions"
```

### Task 3: Streamed file ingestion and deletion

**Files:**
- Modify: `src/server/service/attachment-store.ts`
- Modify: `src/server/service/attachment-store.test.ts`

**Interfaces:**
- Produces: `addFile(sessionId, name, mediaType, body, declaredLength?): Promise<AttachmentSummary>`
- Produces: `removeFile(sessionId, attachmentId): Promise<void>`
- Produces: `getSession(sessionId): AttachmentSessionSummary | undefined`

- [ ] **Step 1: Write failing streamed-ingestion tests**

```ts
test("streams UTF-8 text without trusting content-length", async () => {
  const attachment = await store.addFile(
    session.id,
    "../../notes.ts",
    "text/plain",
    stream([encoder.encode("export const ready = true;\n")]),
    0,
  );
  expect(attachment).toEqual({
    id: expect.any(String),
    name: "notes.ts",
    size: 27,
    kind: "text",
  });
});
```

Add literal fixtures for PNG/JPEG/WebP/GIF/PDF signatures, PE/ELF/Mach-O rejection, invalid UTF-8 and NUL rejection, 20 MiB streamed overflow, 10-file/50 MiB session caps, 500 MiB host cap, duplicate names, Windows reserved names, temporary-file cleanup on abort, and per-file deletion.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test src/server/service/attachment-store.test.ts`

Expected: FAIL because `addFile` and `removeFile` are absent.

- [ ] **Step 3: Implement bounded streaming and classification**

Write each chunk through an exclusive file handle while counting actual bytes. Retain no more than 16 KiB for signature sniffing. For non-signature content, feed every chunk through a fatal streaming `TextDecoder` and reject NUL bytes. Delete the temporary file on every error and atomically rename only after classification and all counters pass.

```ts
async addFile(
  sessionId: string,
  name: string,
  mediaType: string,
  body: ReadableStream<Uint8Array>,
  declaredLength?: number,
): Promise<AttachmentSummary>;
```

- [ ] **Step 4: Run focused tests and type checking**

Run: `bun test src/server/service/attachment-store.test.ts && bun run typecheck`

Expected: all content, cap, abort, and deletion cases pass.

- [ ] **Step 5: Commit ingestion behavior**

```bash
git add src/server/service/attachment-store.ts src/server/service/attachment-store.test.ts
git commit -m "feat: stream bounded message attachments"
```

### Task 4: Authenticated attachment HTTP API

**Files:**
- Modify: `src/server/service/server.ts`
- Modify: `src/server/service/server.test.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: `AttachmentStore.create`, `addFile`, `removeFile`, and `cancel`
- Produces: `POST /api/attachment-sessions`
- Produces: `POST /api/attachment-sessions/:id/files?name=...`
- Produces: `DELETE /api/attachment-sessions/:id/files/:fileId` and `DELETE /api/attachment-sessions/:id`

- [ ] **Step 1: Write failing authenticated route tests**

```ts
test("authorizes before streaming an attachment body", async () => {
  let pulled = false;
  const body = new ReadableStream({ pull() { pulled = true; } });
  const response = await handler(new Request(`${origin}/api/attachment-sessions/id/files?name=a.ts`, {
    method: "POST",
    headers: { Origin: "https://evil.example" },
    body,
    duplex: "half",
  } as RequestInit));
  expect(response.status).toBe(403);
  expect(pulled).toBe(false);
});
```

Cover successful create/upload/delete/cancel, malformed IDs, missing body/name, misleading `Content-Length`, 413 cap errors, method-not-allowed responses, and safe errors without absolute paths.

- [ ] **Step 2: Run the HTTP test and verify RED**

Run: `bun test src/server/service/server.test.ts`

Expected: FAIL with 404 responses for attachment routes.

- [ ] **Step 3: Implement route parsing and production wiring**

Add an optional attachment dependency to `WebRequestHandlerDependencies`, route only exact UUID-shaped paths after authorization, pass `request.body` directly to the store, and map `invalidAttachment` to HTTP 400, `attachmentTooLarge` to 413, `attachmentCapacity` to 429, and `attachmentExpired` to 410 using bounded `WebError` JSON. Construct the store from the selected platform and platform data directory in `src/server/index.ts`; close it during shutdown.

- [ ] **Step 4: Run focused tests and type checking**

Run: `bun test src/server/service/server.test.ts src/server/service/attachment-store.test.ts && bun run typecheck`

Expected: all HTTP and store tests pass.

- [ ] **Step 5: Commit the upload boundary**

```bash
git add src/server/service/server.ts src/server/service/server.test.ts src/server/index.ts
git commit -m "feat: expose authenticated attachment uploads"
```

### Task 5: Turn input coordination and terminal cleanup

**Files:**
- Create: `src/server/service/turn-coordinator.ts`
- Create: `src/server/service/turn-coordinator.test.ts`
- Modify: `src/server/service/attachment-store.ts`
- Modify: `src/server/service/attachment-store.test.ts`
- Modify: `src/server/app-server/adapter.ts`
- Modify: `src/server/app-server/adapter.test.ts`
- Modify: `src/server/service/state.ts`
- Modify: `src/server/service/gateway.ts`
- Modify: `src/server/service/gateway.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/shared/protocol.ts`

**Interfaces:**
- Produces: `NativeTurnInput = {type:"text"; text:string} | {type:"localImage"; path:string}`
- Produces: `AttachmentStore.prepareForTurn(sessionId, cwd)`, `bindTurn(sessionId, threadId, turnId)`, `releaseTurn(sessionId)`, and `completeTurn(threadId, turnId)`
- Produces: `TurnCoordinator.start(threadId, text, attachmentSessionId?)`
- Consumes: `getAdapter(): { startTurn(threadId, input): Promise<TurnResult> }` so app-server restarts do not leave a stale adapter reference
- Changes: `CodexAdapter.startTurn(threadId, input: NativeTurnInput[])`
- Changes: browser `turn.start` accepts optional `attachmentSessionId`

- [ ] **Step 1: Write failing adapter and coordinator tests**

```ts
test("sends manifest text and native local images to app-server v2", async () => {
  await adapter.startTurn("t1", [
    { type: "text", text: "Inspect the attachment manifest" },
    { type: "localImage", path: "/project/.codex-web/attachments/s/a.png" },
  ]);
  expect(rpc.requestParams).toEqual({
    threadId: "t1",
    input: [
      { type: "text", text: "Inspect the attachment manifest" },
      { type: "localImage", path: "/project/.codex-web/attachments/s/a.png" },
    ],
  });
});
```

Coordinator tests must prove attachment-only default text, bounded manifest escaping, cwd mismatch rejection, exact image inputs, rollback after failed start, binding after success, duplicate terminal cleanup, and a terminal event arriving before bind.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test src/server/app-server/adapter.test.ts src/server/service/turn-coordinator.test.ts src/server/service/gateway.test.ts`

Expected: FAIL because normalized inputs, attachment session dispatch, and coordinator do not exist.

- [ ] **Step 3: Implement normalized turn input and ownership flow**

`prepareForTurn` revalidates the thread cwd and every regular file, changes the draft to `starting`, and returns bounded manifest/image metadata. `TurnCoordinator.start` calls the adapter, releases on failure, and binds on success. `WebState.threadWorkingDirectory(threadId)` supplies the authoritative cwd. Gateway parses only an optional string session ID.

```ts
async start(threadId: string, text: string, attachmentSessionId?: string) {
  const prepared = attachmentSessionId
    ? await attachments.prepareForTurn(attachmentSessionId, state.threadWorkingDirectory(threadId))
    : undefined;
  try {
    const result = await adapter.startTurn(threadId, buildInputs(text, prepared));
    if (prepared) await attachments.bindTurn(prepared.sessionId, threadId, result.id);
    return result;
  } catch (error) {
    if (prepared) await attachments.releaseTurn(prepared.sessionId);
    throw error;
  }
}
```

Subscribe the coordinator to bounded `work.updated` terminal events and call `completeTurn`. Never put paths in browser events.

- [ ] **Step 4: Run focused tests and type checking**

Run: `bun test src/server/app-server/adapter.test.ts src/server/service/turn-coordinator.test.ts src/server/service/gateway.test.ts src/server/service/attachment-store.test.ts && bun run typecheck`

Expected: adapter, coordinator, gateway, ownership, and cleanup tests pass.

- [ ] **Step 5: Commit the turn bridge**

```bash
git add src/server/service/turn-coordinator.ts src/server/service/turn-coordinator.test.ts src/server/service/attachment-store.ts src/server/service/attachment-store.test.ts src/server/app-server/adapter.ts src/server/app-server/adapter.test.ts src/server/service/state.ts src/server/service/gateway.ts src/server/service/gateway.test.ts src/server/index.ts src/shared/protocol.ts
git commit -m "feat: attach uploaded context to Codex turns"
```

### Task 6: Browser upload client and composer workflow

**Files:**
- Create: `src/client/attachments.ts`
- Create: `src/client/attachments.test.ts`
- Create: `src/client/components/AttachmentList.tsx`
- Modify: `src/client/components/Composer.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Modify: `src/client/main.tsx`
- Modify: `src/client/App.test.tsx`
- Modify: `src/client/workflows.test.tsx`

**Interfaces:**
- Produces: `AttachmentClient.createSession`, `upload`, `remove`, and `cancel`
- Produces: `UploadHandle { promise, abort }` with XHR progress callbacks
- Changes: composer paperclip accepts multiple files and renders safe draft attachment rows
- Changes: `App` sends `attachmentSessionId` with `turn.start`

- [ ] **Step 1: Write failing upload-client and workflow tests**

```ts
test("uploads raw bytes and reports monotonic progress", async () => {
  const values: number[] = [];
  const handle = client.upload("session-id", file, (value) => values.push(value));
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
  xhr.respond(200, { id: "a1", name: "notes.ts", size: 10, kind: "text" });
  await expect(handle.promise).resolves.toMatchObject({ id: "a1" });
  expect(values).toEqual([0.5, 1]);
});
```

React tests select files through the hidden input, assert upload rows/progress/remove actions, disable send during upload/failure, send attachment-only drafts, include the opaque session ID, cancel on cwd change/new task/unmount, preserve successful siblings after one rejection, and clear rows after successful `turn.start`.

- [ ] **Step 2: Run focused client tests and verify RED**

Run: `bun test src/client/attachments.test.ts src/client/App.test.tsx src/client/workflows.test.tsx`

Expected: FAIL because the upload client, file input behavior, and attachment rows are absent.

- [ ] **Step 3: Implement the client and UI**

Use authenticated `fetch` for session/create/delete and `XMLHttpRequest` for raw upload progress and abort. Keep `File` objects only in ephemeral React state. Sanitize all server-provided display strings through React text rendering. Cancel before changing cwd or task, and pass only the session ID through WebSocket.

```ts
interface DraftAttachment {
  localId: string;
  file: File;
  progress: number;
  status: "uploading" | "ready" | "failed";
  remote?: AttachmentSummary;
  error?: string;
}
```

- [ ] **Step 4: Run focused tests, type checking, and build**

Run: `bun test src/client/attachments.test.ts src/client/App.test.tsx src/client/workflows.test.tsx && bun run typecheck && bun run build`

Expected: all client flows pass, TypeScript exits 0, and Vite builds.

- [ ] **Step 5: Commit the browser workflow**

```bash
git add src/client/attachments.ts src/client/attachments.test.ts src/client/components/AttachmentList.tsx src/client/components/Composer.tsx src/client/App.tsx src/client/styles.css src/client/main.tsx src/client/App.test.tsx src/client/workflows.test.tsx
git commit -m "feat: upload files as turn context"
```

### Task 7: Production E2E, documentation, and final verification

**Files:**
- Modify: `tests/fixtures/fake-codex.ts`
- Modify: `tests/e2e/daily-workflow.pw.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the production HTTP upload, WebSocket turn, app-server input, and cleanup path
- Proves: desktop/mobile text and image attachment flow plus project-directory removal

- [ ] **Step 1: Add a failing production-composed Playwright test**

```ts
test("uploads server-side context and removes it after the turn", async ({ page }) => {
  const project = await mkdtemp(join(tmpdir(), "codex-web-upload-e2e-"));
  await page.goto("/");
  await page.getByRole("combobox", { name: "Working directory" }).fill(project);
  await page.getByLabel("Choose attachment files").setInputFiles([
    { name: "notes.ts", mimeType: "text/plain", buffer: Buffer.from("export const ok = true;\n") },
    { name: "pixel.png", mimeType: "image/png", buffer: tinyPng },
  ]);
  await expect(page.getByText("notes.ts")).toBeVisible();
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByLabel("Activity").getByText("Turn completed")).toBeVisible();
  await expect.poll(async () => {
    try { await access(join(project, ".codex-web", "attachments")); return true; }
    catch { return false; }
  }).toBe(false);
});
```

- [ ] **Step 2: Run only the new E2E and verify RED**

Run: `CODEX_WEB_PORT=4183 bunx playwright test --grep "uploads server-side context"`

Expected: FAIL until the fake validates text plus `localImage` inputs and completes the attachment turn.

- [ ] **Step 3: Extend the fake and README**

Make the fake reject a turn whose manifest path is unreadable or whose image input is not `localImage`, then complete the turn normally. Document attachment limits, project-local temporary storage, automatic terminal/TTL cleanup, and the need to restart after a protocol-version update.

- [ ] **Step 4: Run fresh complete verification**

Run each command independently and require exit code 0:

```bash
bun run typecheck
bun test
bun run build
CODEX_WEB_PORT=4183 bun run test:e2e
git diff --check
```

Expected: all unit/integration tests pass, all non-skipped desktop/mobile E2E tests pass, production build succeeds, and diff check is empty.

- [ ] **Step 5: Commit verification assets and documentation**

```bash
git add tests/fixtures/fake-codex.ts tests/e2e/daily-workflow.pw.ts README.md
git commit -m "test: cover message attachments end to end"
```
