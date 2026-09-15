<!-- last-reviewed: 2026-09-12 round-98 -->
# ADR-0017: Sidecar-native OS folder dialog

- **Status:** ACCEPTED (backfilled round-17; decided rounds 14–16)
- **Date:** 2026-08-23

## Context

Owner: "select the folder itself, not paste paths". The Tauri shell has
`pick_folder`, but the owner's everyday flow is the launcher + browser — no
Tauri. Three iterations of Windows behavior taught: a failed dialog run must
never look like "user cancelled" (silent no-op), and dialogs must own the
topmost window or they appear behind everything.

## Options considered

- **UI-only `showDirectoryPicker()`** — Chromium-only, unusable in the
  desktop webview.
- **Sidecar opens the OS dialog** — works everywhere the sidecar runs.

## Decision

`POST /internal/dialog/folder` (bearer-walled) runs an ASYNC dialog spawn
(a sync spawn would freeze the whole sidecar): Windows = modern
Vista-style picker (OpenFileDialog, validation off) → classic
FolderBrowserDialog → Shell COM BrowseForFolder, each with a hidden TOPMOST
owner form; Linux/macOS = zenity → kdialog. Marker protocol
(`ACUTE_PICK:`/`ACUTE_CANCEL`) distinguishes cancel from failure; failures
return `{error}` and the UI shows the exact cause inline.

## Consequences

Browse works in launcher/browser dev; never silent. Human-blocking dialogs
stay out of tests. Reversal: delete route + client call.
