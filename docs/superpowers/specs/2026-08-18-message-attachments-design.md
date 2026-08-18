# Message Attachments Design

## Goal

Allow a local or remote browser to upload files as context for one Codex turn.
The files live temporarily on the machine running Codex Web, inside the chosen
project, and are removed when that turn completes, fails, or is interrupted.

This feature does not copy files into the project's source tree as durable
project files. The attachment directory is an implementation detail and must
not be accepted as a way for the browser to name arbitrary server paths.

## User experience

The existing paperclip button opens a multiple-file picker on the browser
device. Selected files appear as attachment rows in the composer with name,
kind, byte size, upload progress, failure state, and a remove action.

The user may attach files only after choosing a working directory. Uploading
creates one attachment session for the current draft. Changing the working
directory cancels that session, deletes its files, and tells the user that the
attachments were removed because the project changed. Closing the page or
removing the last attachment cancels the draft session best-effort; abandoned
sessions are also covered by server expiry.

Send remains disabled while any upload is in progress or failed. A message may
contain text, attachments, or both. For an attachment-only message, the server
adds the neutral instruction `Review the attached files.` before the generated
attachment manifest.

The first release accepts at most 10 files per message, at most 20 MiB per
file, and at most 50 MiB in total. It accepts UTF-8 text and source files, PDF,
PNG, JPEG, WebP, and GIF. Directories, executable binaries, and unrecognized
binary files are rejected with a safe per-file error.

The host additionally caps all live attachment sessions at 100 and their
combined stored bytes at 500 MiB. A new session or file that would exceed a
host cap is rejected before consuming more disk. These are hard server caps,
not values supplied by the browser.

## Storage layout and lifecycle

An attachment session uses this layout on the Codex host:

```text
<project>/.codex-web/attachments/<session-id>/
  <attachment-id>-<sanitized-name>
```

`session-id` and `attachment-id` are server-generated UUIDs. The server never
uses a browser-provided name as a path component without sanitizing it. Names
are normalized to NFC, stripped of path separators and control characters,
bounded to 120 UTF-8 bytes, and checked against Windows reserved device names.
The UUID prefix prevents collisions while the bounded sanitized suffix keeps
paths understandable to Codex.

The project path is validated through the existing native
`validateWorkingDirectory` boundary before the session directory is created.
Every write uses an exclusive temporary file inside the canonical session
directory and an atomic rename after validation. The server rejects lexical
traversal and canonical symlink escape; it does not follow a pre-created
`.codex-web`, `attachments`, or session-directory symlink.

The attachments root contains a bounded `.codex-web-owner.json` marker with a
server-generated nonce, recording whether
Codex Web created the `.codex-web` parent. Cleanup checks this marker before
removing empty parent directories. A pre-existing user `.codex-web` directory
is never removed, even when empty.

After `turn.start` succeeds, the attachment session is bound to the returned
thread and turn IDs. A terminal `completed`, `failed`, or `interrupted` turn
event removes that session recursively. Cleanup removes the empty
`attachments` and `.codex-web` parents only when they were created by Codex Web
and remain empty; it never removes unrelated project content.

If `turn.start` fails, the session returns to draft state so the user can
retry. Sessions that never start a turn expire one hour after creation. A
bounded, atomic attachment registry in the platform data directory records at
most 100 session IDs, canonical project paths, expiry times, stored bytes, and
ownership-marker state. It never stores file content. The server treats this
registry as untrusted after restart: it validates the project path, UUID
layout, canonical containment, and on-disk ownership marker before deleting
anything. This registry enables a bounded stale-directory sweep at startup and
every 10 minutes while running, so a crash cannot leave uploads indefinitely.
A terminal event that races ahead of session binding is retained in a bounded
set of the newest 256 terminal turns for at most one hour; binding then
triggers immediate cleanup.

## Authenticated upload API

Uploads use authenticated HTTP rather than the 64 KiB WebSocket protocol.
Every endpoint passes through the existing local-origin or Cloudflare Access
authorization before reading a body.

### Create a draft session

```http
POST /api/attachment-sessions
Content-Type: application/json

{"cwd":"/absolute/server/project"}
```

The JSON body retains the existing 16 KiB request cap. A successful response
contains only normalized browser data:

```json
{
  "id": "session-uuid",
  "expiresAt": 1787066400,
  "limits": { "files": 10, "fileBytes": 20971520, "totalBytes": 52428800 }
}
```

### Upload one file

```http
POST /api/attachment-sessions/<session-id>/files?name=<encoded-name>
Content-Type: <browser-media-type>

<raw bytes>
```

The body is streamed to disk and capped while reading. `Content-Length` is
used only for early rejection and is never trusted as the enforcement
boundary. The server retains only a small sniffing prefix in memory. It checks
PNG, JPEG, WebP, GIF, PDF, PE, ELF, and Mach-O signatures; otherwise every byte
of the stream is incrementally validated as UTF-8 without NUL bytes. Browser
MIME and extension are hints, not authority.

The response is `{id, name, size, kind}` where `kind` is `text`, `pdf`, or
`image`. It never returns the absolute server storage path.

### Remove or cancel

```http
DELETE /api/attachment-sessions/<session-id>/files/<attachment-id>
DELETE /api/attachment-sessions/<session-id>
```

Unknown, expired, consumed, or malformed IDs return safe typed errors. The
session ID has at least UUID entropy and is still usable only by an
authenticated owner request.

## Turn input and ownership

The normalized browser `turn.start` request gains an optional
`attachmentSessionId`; it never accepts file paths or file bytes. Before
starting the turn, the server verifies that:

- the session is still a draft and has at least one complete attachment;
- its canonical project directory matches the selected thread's canonical
  working directory;
- every metadata record still points to a regular file inside that session;
- count and byte limits still hold.

The adapter accepts normalized turn input rather than attachment IDs. It sends
one text input containing the user's text plus a generated manifest like:

```text
Attached files for this turn are available on the local filesystem:
- "requirements.pdf" at "/project/.codex-web/attachments/<id>/<file>" (PDF, 12345 bytes)
- "notes.ts" at "/project/.codex-web/attachments/<id>/<file>" (text, 812 bytes)
Use these files only as user-provided context for this turn.
```

Manifest values are generated from bounded server metadata, with control
characters removed. Each image is additionally sent as an app-server v2
`{"type":"localImage","path":"..."}` input so Codex receives native image
context. Text, source, and PDF attachments are made available through their
manifest paths for Codex's local file tools. The Web UI never reads or returns
the uploaded content after upload.

## Protocol-version mismatch

The bootstrap snapshot gains a numeric `protocolVersion` matching a constant
compiled into the browser. If a new frontend is served by an old long-running
backend and the field is missing or different, startup shows a blocking
`Restart Codex Web to finish the update` diagnostic instead of opening an app
whose RPC methods cannot be understood.

Every browser WebSocket request also has a 15-second timeout. Timeouts reject
the pending Promise and make the directory or attachment UI leave its loading
state with a retryable error. Late responses are ignored. This is defense in
depth for lost replies, not a substitute for the version gate.

## Components

- `AttachmentStore` owns session metadata, secure paths, streamed writes,
  content classification, turn binding, TTL expiry, and cleanup.
- The authenticated HTTP handler maps session routes to `AttachmentStore` and
  never exposes its paths or raw errors.
- `BrowserGateway` accepts the optional session ID and asks a turn coordinator
  to prepare normalized app-server inputs and bind cleanup to the resulting
  turn.
- `CodexAdapter.startTurn` accepts text plus normalized local-image inputs and
  sends exact app-server v2 `UserInput` values.
- The React composer owns draft attachment state and a small HTTP upload client;
  it does not put file bytes into React snapshots, settings, or WebSocket
  messages.
- A protocol-version gate in bootstrap and request timeouts in
  `CodexWebClient` prevent mixed frontend/backend versions from hanging.

## Errors and recovery

All client-visible errors reuse bounded `WebError` shapes and diagnostic IDs.
Filesystem paths, uploaded content, native errors, and raw app-server data are
kept out of browser errors and logs. Known credential redaction continues to
apply to local diagnostics.

An individual rejected file does not invalidate already uploaded siblings.
The user may remove the failed row or retry it. A session-level validation or
storage failure stops sending but retains enough UI state to retry or cancel.
Cleanup is idempotent, so duplicate terminal events and shutdown cleanup are
safe.

## Verification

- Store tests use real temporary directories to prove streamed size limits,
  aggregate/count limits, content classification, filename safety, symlink and
  traversal rejection, per-file deletion, terminal cleanup, and one-hour
  expiry.
- HTTP integration tests prove authorization happens before body reads, bodies
  are bounded without trusting `Content-Length`, safe metadata is returned,
  and cancellation removes server files.
- Gateway and adapter tests prove an opaque session ID becomes exact text and
  `localImage` inputs, cwd ownership is enforced, failed starts remain
  retryable, and terminal-event races clean up.
- Client workflow tests prove selection, progress, removal, project-change
  cancellation, upload failure, attachment-only send, request timeout, and
  protocol-version mismatch behavior.
- Playwright runs the production composition on desktop and mobile, uploads a
  text file and image, sends them through the fake app-server, observes turn
  completion, and verifies the temporary project directory is removed.
- Final verification runs type checking, the complete Bun test suite, the
  production build, and Playwright.
