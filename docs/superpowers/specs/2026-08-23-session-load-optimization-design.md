# Session Load Optimization Design

## Goal

Cut the time from clicking a task to seeing its conversation, for both long-running sessions (hundreds of turns) and large event payloads, without changing the browser protocol.

## Changes

- **Larger resume pages.** `resumeThread` fetches turns newest-first with `limit: 50` instead of `10` (both the `initialTurnsPage` and the `thread/turns/list` follow-ups). Long sessions need 5× fewer sequential round trips; the existing 500-item and 50-page caps still bound the total work.
- **Encode each event once.** The gateway encodes every state event a single time and reuses that string for byte accounting, the replay ring buffer, and every connected socket (the WebSocket `Send` callback accepts an optional pre-encoded string and falls back to encoding). `WebState.#emit` no longer clones the event per listener — events are freshly constructed per emit and consumed synchronously by read-only listeners.
- **Lazy conversation rendering.** The client renders only the newest 40 items in full. Older items render as one-line previews (first line of the message, the command, or the changed paths) that expand when they approach the viewport via `IntersectionObserver` (with a click fallback and an expand-immediately fallback where observers are unavailable). Opening a 500-item session no longer parses hundreds of markdown documents in one commit.
- **Resume timing diagnostic.** `resumeThread` records `pages`, `items`, and `totalMs` through `state.addDiagnostic`, so load times are observable in the local event log before and after further tuning.

## Scope

`adapter.resumeThread`, `gateway`/`state` event dispatch, and `Conversation` rendering, plus their tests. The browser protocol version, event shapes, and replay semantics are unchanged; `thread.loaded` still delivers the full decoded history.
