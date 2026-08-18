# Server Directory Browser Design

## Goal

Let the same Codex Web UI choose a project directory on the machine running
Codex Web, whether the browser is local or remote.

## User experience

The composer keeps its editable working-directory field and recent-directory
history. A browse button beside that field opens an in-page directory dialog.
The dialog identifies the machine as the Codex host, shows allowed server-side
roots, supports entering child directories and moving to a parent, and selects
the currently displayed directory. Choosing a directory fills the existing
working-directory field; Codex is not started until the user sends a message.

The browser never uses a local file picker. A remote browser therefore sees
paths from the server Mac or Windows machine, not paths from the client device.

## Server boundary

Add a normalized `directory.list` browser request. It accepts an optional
absolute server path and returns a bounded listing containing the current
directory, its allowed parent, configured roots, child directories, and a
truncation flag. Raw filesystem errors and file entries are not returned.

The default browse root is the service account's home directory. Additional
roots are configured with `CODEX_WEB_BROWSE_ROOTS`, separated by the native
path delimiter (`:` on macOS, `;` on Windows). This permits Windows data drives
or macOS mounted volumes without exposing the full host filesystem by default.

Each request is checked twice: lexically before filesystem access, then against
canonical paths after resolving symlinks. A symlink cannot escape an allowed
root. Results are directories only, sorted by display name, capped at 200
entries, and bounded per name/path. The selected path still passes through the
existing working-directory validator when `thread.start` runs.

## Failure behavior

An unavailable or unauthorized path produces the existing safe
`invalidWorkingDirectory` browser error. The dialog keeps the previous listing
and displays a retryable user-facing message. Closing the dialog leaves the
working-directory field unchanged.

## Verification

- Directory-service tests cover default roots, navigation, entry caps, and
  lexical/symlink escape rejection.
- Gateway tests cover `directory.list` normalization.
- React workflow tests cover opening, navigating, and choosing a server path.
- Type checking, unit tests, production build, and the existing Playwright
  workflow must remain green.
