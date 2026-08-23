# Thread Sidebar Directory Groups Design

## Goal

Group the sidebar's recent tasks by their working directory so tasks from different projects stay separated, using data the thread catalog already provides.

## Interaction

- The global `Running` section stays first and is never split by directory: live CLI takeover tasks remain visible at the top.
- Every other task is grouped under its `cwd`:
  - The group header shows a folder icon, the directory basename (project name), a task count badge, and a chevron; hovering the header reveals the full path.
  - Tasks without a working directory fall into a `No directory` group.
  - Basenames are computed for POSIX and Windows separators, with trailing separators ignored.
- Groups sort by their most recent task activity (newest project first); tasks inside a group also sort newest-first.
- Groups are collapsible `<details>` sections that start expanded.
- Searching keeps the grouping: directories with no matches disappear instead of collapsing the list into a flat result.

## Scope

Client-only, contained in `ThreadSidebar` plus its styles and component tests. Protocol, the thread catalog refresher, and selection behavior are unchanged.
