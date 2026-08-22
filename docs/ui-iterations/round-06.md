# Round 06 — Persistent dev backend (models list & test connection in the browser) (2026-08-22)

## Owner report

"the test connection and the models list fails to load" — in the browser tab
(http://localhost:5173/setup), with the same OpenRouter key.

## Root cause

Not a product bug in the wizard: plain `pnpm dev` starts ONLY vite. The
sidecar — which owns the providers/models/test endpoints — is spawned by the
Tauri shell in the desktop app; nothing spawns it in a browser workflow. The
live catalog/test had only ever worked while a temporary hand-booted sidecar
was running; when it was cleaned up, the browser UI was left with no backend
("Failed to fetch" / dead test button).

## Fix — one command, deterministic backend

- `agent-core/src/main.ts` now honors an optional **`ACUTE_PORT`** env for a
  fixed bind (the shell still uses the ephemeral ready-line port).
- **`scripts/dev.mjs`** (`pnpm dev:full`): boots the sidecar on
  **127.0.0.1:5178** (the address `config-store` already defaults to) with
    - a stable dev SQLite DB at `.dev/acute.db` (gitignored, survives
      restarts),
    - the OpenRouter key read from Windows Credential Manager
      (`ACUTE-CODE/provider/openrouter` — stored once, length-73 verified;
      never printed),
    - the loopback-only dev bearer `acute-dev-local`,
    then starts vite. One Ctrl+C stops both. Plain `pnpm dev` (UI-only)
  keeps working as before.
- **`.env.development`**: `VITE_ACUTE_TOKEN=acute-dev-local` so the browser
  authenticates against the dev sidecar automatically (loopback-only, not a
  secret; production still mints ephemeral per-spawn tokens).

## Verification (all live, in the browser at localhost:5173/setup)

- `GET /health` on 5178 → ok with dev token; providers list → `hasKey:true`.
- Wizard walk: provider list arrives from the live server; before any key
  the dropdown shows the gated state; typing the key loads the **real
  OpenRouter catalog** (stealth/ox-alpha row, 1M ctx) with zero fetch errors.
- **Test connection button clicked in the UI → "Connected • 313ms •
  stealth/ox-alpha"** (real OpenRouter round trip).
- `pnpm verify` green: 144 unit + 6 e2e + license audit (107 deps, CLEAN).

**Status: delivered; awaiting owner confirmation in his browser tab.**
