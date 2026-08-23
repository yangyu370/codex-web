# Permission Profile Menu Design

## Goal

Replace the compact native permission-profile select with a Codex desktop-style permission menu while continuing to use the native permission catalog and settings-update API.

## Interaction

- The task header shows one compact `Permissions` trigger with the active mode label.
- Activating the trigger opens a floating dialog titled `How should Codex run?`.
- Native profiles are presented in catalog order. The three known profiles use product copy:
  - `:read-only`: `Ask for approval` — `Ask before editing files or using the internet.`
  - `:workspace`: `Approve when needed` — `Ask only when Codex detects a risky operation.`
  - `:danger-full-access`: `Full access` — `Use the internet and any file on this computer without restrictions.`
- Unknown native profiles remain available and use their ID and server-provided description. Codex Web never manufactures sandbox policy combinations.
- The current profile has a check mark. Disallowed profiles remain visible, disabled, and expose the server description.
- Selection uses the existing `onSettingsChange({ permissionProfile })` path, then closes the dialog.
- Escape and outside pointer interaction close the dialog. The trigger and options remain keyboard accessible.
- While a settings update is pending or controls are disabled, the trigger is disabled. During an active turn, `Next turn` remains visible.

## Visual Direction

Use the desktop client's restrained utility aesthetic: an off-white elevated sheet, subtle one-pixel border, generous option hit areas, monochrome line icons, and a warm orange accent only for full access. Keep the existing Web UI typography and density so the menu feels native to this product rather than pasted from the screenshot.

## Scope

The change is client-only. It modifies `TaskSettings`, its styles, component tests, and the end-to-end workflow selector. Protocol, adapter validation, persistence, and thread settings APIs remain unchanged.
