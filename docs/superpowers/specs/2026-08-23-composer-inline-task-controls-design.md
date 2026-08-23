# Composer Inline Task Controls Design

## Goal

Move the reasoning-effort and permission-profile controls out of the task header and into the composer toolbar as compact dropdown chips, so every per-task control lives where the user types — matching the input-box pattern popularized by desktop coding assistants.

## Interaction

- The composer toolbar shows inline chips after the attach button:
  - `Model` (new tasks only) — a brain icon plus the model display name, opening a menu of catalog models with a check mark on the selection.
  - `Reasoning effort` — a gauge icon plus the current degree only (`High`), with a chevron. The catalog description of the current effort moves into the chip tooltip.
  - `Permissions` — the profile icon (eye / folder / shield / question mark) plus the friendly mode label, with a chevron. The current mode description is the tooltip.
- Activating a chip opens a floating dialog menu anchored above the composer:
  - The model and effort menus list compact single-line options with a check mark on the selection; each option's description is its hover tooltip.
  - The permission menu keeps the existing catalog semantics: friendly labels for the three known profiles, unknown native ids verbatim, server descriptions, disabled disallowed profiles, and a check mark on the selection.
- Menu widths are per-kind: the model menu is moderate, the effort menu is narrow (degree labels only), and the permission menu keeps the wide two-line layout.
- Only one menu is open at a time. Escape and outside pointer interaction close a menu and restore trigger focus; the selected (or first allowed) option receives focus on open.
- While a settings update is pending the chip shows a warning border and stays non-activatable; during an active turn the `Applies from the next turn` hint is appended to the chip tooltip instead of rendering visible label text.
- Menu geometry is measured when a chip opens: both menus open upward from the composer, the width is clamped to the viewport, the left edge is shifted to stay inside the viewport, and the height never exceeds the space above the chip. Long server-provided descriptions are clamped to two lines (full text remains in the DOM for assistive technology and hover tooltips).

## Scope

Client-only. `TaskSettings` shrinks to the review button alone; the loaded task's model stays visible in the header context line and new tasks pick a model from the composer chip. `Composer` replaces its native model select with the model chip and drops the static `Workspace access` chip; chips shrink with ellipsized labels on narrow viewports so the toolbar never covers the send button. Protocol, adapter validation, persistence, and thread settings APIs are unchanged.
