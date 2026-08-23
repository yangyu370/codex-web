# Composer Inline Task Controls Design

## Goal

Move the reasoning-effort and permission-profile controls out of the task header and into the composer toolbar as compact dropdown chips, so every per-task control lives where the user types — matching the input-box pattern popularized by desktop coding assistants.

## Interaction

- The composer toolbar shows two inline chips after the attach button:
  - `Reasoning effort` — a gauge icon plus the current degree only (`High`), with a chevron. The catalog description of the current effort moves into the chip tooltip.
  - `Permissions` — the profile icon (eye / folder / shield / question mark) plus the friendly mode label, with a chevron. The current mode description is the tooltip.
- Activating a chip opens a floating dialog menu anchored above the composer:
  - The effort menu lists degree-only options with a check mark on the selection; each option's description is its hover tooltip.
  - The permission menu keeps the existing catalog semantics: friendly labels for the three known profiles, unknown native ids verbatim, server descriptions, disabled disallowed profiles, and a check mark on the selection.
- Only one menu is open at a time. Escape and outside pointer interaction close a menu and restore trigger focus; the selected (or first allowed) option receives focus on open.
- While a settings update is pending the chip shows a warning border and stays non-activatable; during an active turn the `Applies from the next turn` hint is appended to the chip tooltip instead of rendering visible label text.
- Menu geometry is measured when a chip opens: both menus open upward from the composer, the width is clamped to the viewport, the left edge is shifted to stay inside the viewport, and the height never exceeds the space above the chip. Long server-provided descriptions are clamped to two lines (full text remains in the DOM for assistive technology and hover tooltips).

## Scope

Client-only. `TaskSettings` shrinks to the model select and the review button (the model-change effort fallback moved into `App`). `Composer` gains the new `ComposerControls` component and the settings-change props; the old static `Workspace access` composer chip is removed. Protocol, adapter validation, persistence, and thread settings APIs are unchanged.
