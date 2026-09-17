<!-- last-reviewed: 2026-09-17 round-102 -->
# Round 01–02 — Initial port & adaptable layouts (2026-08-22)

## Round 1 — Port from the design demo

- Ported the owner's demo (`design/demos/acute-agent-ui`) wizard into the app:
  5-step machine (Welcome → Pick flavor → Need a brain → Plug in your brain →
  All set), Header/Footer chrome, dot-grid background, ambient accent glows,
  step-in animation.
- Theme engine built table-driven (`src/lib/themes.ts`: THEMES +
  `deriveThemeStyles()` + `--ac-*` CSS bridge) so a theme is one object
  literal — seeded with Nova Cream + Bento Blue.
- Wired live: providers from `GET /api/v1/providers` with a client-side
  OpenRouter fallback (wizard renders even with the sidecar down), model
  catalog from `GET /providers/{id}/models`, connection test from
  `POST /providers/{id}/test`, key stored via the Tauri shell into Windows
  Credential Manager.

## Round 2 — Adaptable layouts (owner: "not that adaptable")

Owner verdict after the Phase-2 walkthrough: everything works, but wide/tall
viewports behaved poorly. Changes:

- Fluid content containers (1280 → 1480 → 1640 with the window), full-bleed
  chrome pinned to true window corners (`WIZARD_EDGE`), `overflow-x-clip`
  guards, decorative floats made `pointer-events-none`.
- Welcome hero scales to 2xl; per-screen content caps; `short:` variant
  compresses vertical rhythm under 760px height.
- Vertical centering fixed via flex chain (wizard-step `flex min-h-0 flex-1`).

**Status: APPROVED** ("everything is quite good… well managed and properly
adaptable").
