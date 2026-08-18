# Server Directory Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded in-page browser that selects a project directory on the Codex Web host.

**Architecture:** A native filesystem service owns allowed roots and canonical containment checks. The existing WebSocket gateway exposes one normalized listing request, while a focused React dialog consumes that request and fills the existing composer path field.

**Tech Stack:** Bun, TypeScript, React, Testing Library, native Node filesystem APIs

**Spec:** `docs/superpowers/specs/2026-08-18-server-directory-browser-design.md`

## Global Constraints

- The selected path always belongs to the machine running Codex Web.
- The default allowed root is the service user's home directory.
- Additional roots come only from `CODEX_WEB_BROWSE_ROOTS`.
- Lexical and canonical containment checks prevent traversal and symlink escape.
- Listings contain directories only and at most 200 entries.
- macOS and Windows use their native absolute-path forms.

---

### Task 1: Bounded host directory service

**Files:**
- Create: `src/server/service/directories.ts`
- Create: `src/server/service/directories.test.ts`
- Modify: `src/server/platform/types.ts`
- Modify: `src/server/platform/macos.ts`
- Modify: `src/server/platform/windows.ts`
- Modify: `src/server/platform/platform.test.ts`

**Interfaces:**
- Produces: `DirectoryService.list(path?: string): Promise<DirectoryListing>`
- Produces: `HostPlatform.homeDirectory(): string`

- [ ] **Step 1: Write failing service and platform tests** for default-root listing, bounded child directories, parent navigation, configured roots, lexical escape, and canonical symlink escape.
- [ ] **Step 2: Run `bun test src/server/service/directories.test.ts src/server/platform/platform.test.ts`** and confirm failures are caused by the missing interfaces.
- [ ] **Step 3: Implement the minimal native directory service** with streamed directory iteration, platform-aware containment, and safe bounded output.
- [ ] **Step 4: Re-run the focused tests** and confirm they pass.

### Task 2: Browser protocol and gateway

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/shared/protocol.test.ts`
- Modify: `src/server/service/gateway.ts`
- Modify: `src/server/service/gateway.test.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: `DirectoryService.list(path?: string)`
- Produces: browser method `directory.list` with optional `path`

- [ ] **Step 1: Write failing protocol and gateway tests** that send `{ method: "directory.list", params: {} }` and a path-bearing request and assert normalized bounded results.
- [ ] **Step 2: Run `bun test src/shared/protocol.test.ts src/server/service/gateway.test.ts`** and confirm the method is rejected before implementation.
- [ ] **Step 3: Add the protocol method, gateway action, and production wiring** using `CODEX_WEB_BROWSE_ROOTS` split by the native delimiter.
- [ ] **Step 4: Re-run the focused tests** and confirm they pass.

### Task 3: Server-directory picker UI

**Files:**
- Create: `src/client/components/DirectoryPicker.tsx`
- Modify: `src/client/components/Composer.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Modify: `src/client/workflows.test.tsx`

**Interfaces:**
- Consumes: `CodexWebClient.request("directory.list", { path? })`
- Produces: browse button, directory dialog, and selected `cwd`

- [ ] **Step 1: Write a failing React workflow test** that opens the server browser, receives a literal host listing, navigates into a child, and selects that absolute path.
- [ ] **Step 2: Run `bun test src/client/workflows.test.tsx`** and confirm failure occurs because the browse control is absent.
- [ ] **Step 3: Implement the focused dialog and composer integration** with loading, empty, truncated, error, close, parent, root, and select-current states.
- [ ] **Step 4: Re-run the workflow tests** and confirm they pass.

### Task 4: Documentation and full verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents: `CODEX_WEB_BROWSE_ROOTS` and server-side selection semantics

- [ ] **Step 1: Update README remote-access guidance** with allowed-root configuration examples for macOS and Windows.
- [ ] **Step 2: Run `bun run typecheck`, `bun test`, `bun run build`, and `bun run test:e2e`.**
- [ ] **Step 3: Inspect `git diff --check` and `git status --short`**, preserving the user's untracked `.idea/` directory.
