# Permission Profile Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible Codex desktop-style three-mode permission menu to the Web task header.

**Architecture:** Keep the server-driven `PermissionProfileSummary[]` catalog as the authority. `TaskSettings` maps the three known native IDs to friendly presentation metadata, renders unknown profiles as safe fallbacks, and emits the existing settings-change payload without changing protocol or server code.

**Tech Stack:** React 19, TypeScript, lucide-react, CSS, Testing Library, Bun test, Playwright

**Spec:** `docs/superpowers/specs/2026-08-23-permission-profile-menu-design.md`

## Global Constraints

- Preserve native profile IDs, catalog order, `allowed`, and server descriptions.
- Do not infer or transmit sandbox combinations in the browser.
- Keep unknown profiles selectable when allowed.
- Support trigger keyboard activation, option keyboard activation, Escape, and outside-click dismissal.
- Preserve pending, disabled, and `Next turn` behavior.

---

### Task 1: Permission menu behavior

**Files:**
- Modify: `src/client/components/TaskSettings.test.tsx`
- Modify: `src/client/components/TaskSettings.tsx`

**Interfaces:**
- Consumes: `PermissionProfileSummary[]`, `permissionProfile?: string`, and existing disabled/pending/running props.
- Produces: the existing `onSettingsChange({ permissionProfile: string })` callback and an accessible button/menu UI.

- [ ] **Step 1: Write failing component tests**

Add tests that open the `Permissions` button, assert the three friendly option names, select `Full access`, and observe the literal payload `{ permissionProfile: ":danger-full-access" }`. Add separate tests proving a disallowed profile cannot be selected and that Escape dismisses the menu while focus returns to the trigger.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test src/client/components/TaskSettings.test.tsx`

Expected: FAIL because the current component exposes a native `Permission profile` combobox and no permission-menu dialog or named option buttons.

- [ ] **Step 3: Implement the minimal accessible menu**

In `TaskSettings.tsx`, add local open state, trigger/dialog refs, friendly presentation metadata for the three known IDs, outside-pointer and Escape handlers active only while open, and buttons for catalog profiles. Selection must call the unchanged callback, close the menu, and return focus to the trigger. Render server descriptions for unknown or disallowed entries.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test src/client/components/TaskSettings.test.tsx`

Expected: all component tests pass with no warnings.

### Task 2: Client-matched visual treatment

**Files:**
- Modify: `src/client/components/TaskSettings.test.tsx`
- Modify: `src/client/components/TaskSettings.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: the catalog-driven menu behavior from Task 1.
- Produces: unique ARIA relationships, initial focus on the selected/first enabled option, line-icon presentation, and a responsive anchored popover with desktop-client spacing, selected state, disabled state, focus state, and orange full-access treatment.

- [ ] **Step 1: Write and run the focused accessibility test**

Add a test that mounts two settings controls and proves their trigger/menu IDs differ, then opens one menu and proves focus moves to its selected option. Run `bun test src/client/components/TaskSettings.test.tsx` and verify RED against the fixed IDs and trigger-retained focus.

- [ ] **Step 2: Add presentation markup and menu styles**

Use React `useId` for menu/title/description relationships, focus the selected or first enabled option on open, and add suitable lucide line icons for the three known modes plus a safe fallback. Style the compact trigger, elevated dialog, heading, option icons/copy/check marks, hover/focus-visible states, and narrow-screen positioning. Reuse existing color variables and add no dependencies.

- [ ] **Step 3: Re-run component tests**

Run: `bun test src/client/components/TaskSettings.test.tsx`

Expected: all component tests pass.

### Task 3: Workflow coverage and verification

**Files:**
- Modify: `src/client/workflows.test.tsx`
- Modify: `tests/e2e/daily-workflow.pw.ts`

**Interfaces:**
- Consumes: the accessible trigger and option names from Task 1.
- Produces: unchanged `thread.settings.update` request coverage and end-to-end selection coverage.

- [ ] **Step 1: Update workflow selectors first and verify RED**

Replace native select interactions with clicks on `Permissions` followed by the desired friendly profile option. Run the focused workflow tests before adjusting any remaining implementation selectors.

Run: `bun test src/client/workflows.test.tsx`

Expected: FAIL if the menu does not expose the agreed accessible names or does not close after selection.

- [ ] **Step 2: Make the workflow pass without changing API assertions**

Retain the literal expectation that the browser sends `thread.settings.update` with `permissionProfile: ":workspace"`.

- [ ] **Step 3: Run complete automated verification**

Run: `bun test && bun run typecheck && bun run build && bun run test:e2e`

Expected: zero failures; E2E may report only its existing documented conditional skips.

- [ ] **Step 4: Perform browser visual QA**

Open the local app at desktop and narrow widths, inspect closed/open/selected/disabled states, keyboard navigation, Escape, outside click, clipping, and contrast. Fix any observed issue and repeat the relevant automated verification.

- [ ] **Step 5: Review and commit**

Inspect `git diff --check`, `git diff`, and `git status --short`. Stage only the permission-menu implementation, tests, spec, and plan; leave `.idea/` untouched. Commit with `feat: add permission profile menu`.
