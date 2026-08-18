# Codex Web

Codex Web is a single local Web UI for managing the native Codex installation on macOS or Windows. A loopback-only Bun service owns `codex app-server --stdio`; the browser never launches Codex directly and never receives raw app-server payloads.

## Requirements

- Native macOS or Windows (Linux and WSL are intentionally unsupported)
- Bun 1.3 or newer
- Codex available on `PATH`, or an absolute `CODEX_WEB_CODEX_EXECUTABLE`

## Run locally

Install the JavaScript dependencies once with `bun install`, then use the native launcher:

```sh
./scripts/start-macos.sh
```

On Windows PowerShell:

```powershell
.\scripts\start-windows.ps1
```

Open `http://127.0.0.1:4173`. The service always binds to `127.0.0.1`; change the loopback port with `CODEX_WEB_PORT` and add its origin to `CODEX_WEB_LOCAL_ORIGINS` when needed. The launchers preserve the existing `CODEX_HOME` and do not install or upgrade Bun or Codex.

The folder button in the composer browses directories on the machine running
Codex Web. The service user's home directory is available by default. Add
other project roots with the native path delimiter:

```sh
CODEX_WEB_BROWSE_ROOTS=/Volumes/Projects:/opt/work ./scripts/start-macos.sh
```

```powershell
$env:CODEX_WEB_BROWSE_ROOTS = 'D:\Projects;\\server\share\work'
.\scripts\start-windows.ps1
```

Only configured roots and their descendants are visible in the Web UI.

## Message attachments

Choose a project directory, then use the paperclip in the composer to attach
files from the browser device. Codex Web accepts up to 10 files per message,
20 MiB per file, and 50 MiB total. Supported content is UTF-8 text/source,
PDF, PNG, JPEG, WebP, and GIF.

Uploads are temporary context, not durable project files. They are stored on
the machine running Codex Web under
`<project>/.codex-web/attachments/<session-id>/`, passed only to the current
Codex turn, and deleted when that turn completes, fails, or is interrupted.
Abandoned drafts expire after one hour. The host also limits live attachment
storage to 100 sessions and 500 MiB total.

After updating Codex Web, restart the native launcher before reloading the
browser. A browser/backend protocol mismatch shows a blocking restart message
instead of leaving directory browsing or uploads stuck.

For Vite hot reload, run `bun run dev:server` and `bun run dev` in separate terminals, then open `http://127.0.0.1:5173`.

## Remote access

Remote mode still listens only on loopback and is intended to sit behind a locally managed Cloudflare Tunnel plus Cloudflare Access. It fails closed unless every required value is set:

```text
CODEX_WEB_AUTH_MODE=remote
CODEX_WEB_CF_TEAM_DOMAIN=team.cloudflareaccess.com
CODEX_WEB_CF_AUDIENCE=<access-audience>
CODEX_WEB_OWNER_EMAIL=owner@example.com
CODEX_WEB_PUBLIC_URL=https://codex.example.com
```

Do not expose the loopback service directly or use a public ingress without Access. The service validates the Access JWT issuer, audience, expiry, owner email, and browser origin.

Directory browsing in remote mode still targets the Codex Web host. It never
browses the filesystem of the laptop or phone displaying the page.

## Verification

```sh
bun run typecheck
bun test
bun run build
bun run test:e2e
CODEX_WEB_SMOKE=1 bun run test:smoke
```

The end-to-end suite compiles a fake native Codex executable and exercises new task, first turn, file approval, completion, responsive navigation, and overflow checks. The opt-in smoke test uses the installed Codex without starting a model turn and archives its temporary thread afterward.
