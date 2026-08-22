# UI Iterations — Owner Review Rounds

This folder is the **dedicated tracking system for UI-fidelity work** (owner
directive, 2026-08-22): every owner review round gets a file here recording
what he verdicted, what changed, and how it was verified. Any agent picking
up the project can read this folder top-to-bottom and know exactly where the
UI stands and what is still open.

## How rounds work

1. The owner reviews the running UI (`pnpm dev` → http://localhost:5173/setup,
   or the desktop app) and sends verdicts per screen.
2. The orchestrator implements, verifies (screenshots at multiple viewports +
   code gates: typecheck / tests / build), and records a round file here.
3. A round is **CLOSED** only when the owner explicitly approves the screen.
   He gates progress one screen at a time — never batch-advance past a
   verdict, and never infer approval from praise of a different screen.

## Status board (wizard)

| Screen | Round history | Status |
|---|---|---|
| Welcome (step 0) | R1 port → R2 adaptable layouts | **APPROVED** (footer stays here only) |
| Pick your flavor (step 1) | R1 port → R3 two-half layout REJECTED → R4 demo-anatomy rebuild → R5 button polish | **APPROVED layout** (R4); R5 primary-button polish delivered, awaiting next look |
| Need a brain (step 2) | R1 port → R3 equal heights + accent selection → R5 bottom-button padding | **APPROVED** (R3: "proper, no huge issues"; R5 padding fix delivered) |
| Plug in your brain (step 3) | R1 port → R3 layout (padding/width/functionality REJECTED) → R5 full pass | **IN REVIEW** — R5 delivered: padding, wider rail, key-gated model search, hover steppers, AUTO/MANUAL split, live catalog + connection test verified |
| All set (step 4) | R1 port → R3 theme-derived confetti | **APPROVED** ("perfect") |
| Dashboard / Agents / Sessions / Chat | R1–R2 theme-engine restyle | Approved in the Phase-2 walkthrough ("everything is working properly… UI looks much better"); further polish on request |

## Round files

- [`round-01-02.md`](round-01-02.md) — initial port + adaptable-layout rounds
- [`round-03.md`](round-03.md) — owner verdict: PickFlavor & PlugBrain rejected, NeedBrain approved
- [`round-04.md`](round-04.md) — PickFlavor demo-anatomy rebuild (approved) + NeedBrain padding
- [`round-05.md`](round-05.md) — primary-button polish, PlugBrain full pass, live-key verification

## Verification method (per round)

- Code gates: `pnpm typecheck` + onboarding vitest suite + `pnpm build`.
- Visual: ZCode in-app browser against the vite dev server at 1920×1080 and a
  tall viewport (~1080×1600); scroll-container overflow checked numerically
  (`scrollHeight` vs `clientHeight`) because screenshots blur edges.
- Live backend (when behavior depends on the sidecar): boot
  `agent-core/dist/main.js` with `ACUTE_TOKEN`/`ACUTE_DB_PATH`/
  `ACUTE_PROVIDER_OPENROUTER` env, point vite at it via
  `VITE_ACUTE_BASE_URL`/`VITE_ACUTE_TOKEN`, verify real catalog + connection
  test in the UI. See `round-05.md`.
