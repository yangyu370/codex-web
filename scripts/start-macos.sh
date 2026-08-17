#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Codex Web supports this launcher only on native macOS." >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun 1.3+ is required and was not found on PATH." >&2
  exit 1
fi
if [ -n "${CODEX_WEB_CODEX_EXECUTABLE:-}" ]; then
  case "$CODEX_WEB_CODEX_EXECUTABLE" in
    /*) codex_executable=$CODEX_WEB_CODEX_EXECUTABLE ;;
    *) echo "CODEX_WEB_CODEX_EXECUTABLE must be an absolute path." >&2; exit 1 ;;
  esac
  if [ ! -x "$codex_executable" ]; then
    echo "Configured Codex executable is not executable: $codex_executable" >&2
    exit 1
  fi
else
  codex_executable=$(command -v codex || true)
  if [ -z "$codex_executable" ]; then
    echo "Codex is required and was not found on PATH." >&2
    exit 1
  fi
fi

echo "Using $(bun --version | sed 's/^/Bun /')"
echo "Using $("$codex_executable" --version)"
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_directory/.."
bun run build
exec bun run start
