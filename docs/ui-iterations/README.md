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
| Plug in your brain (step 3) | R1 port → R3 layout REJECTED → R5 padding/rail/key-gating → R6 live backend → R7 full-catalog expand + unified scroll | **APPROVED** (owner: "working properly… how they are meant to be") |
| Connection test | R8 honesty fix (one-token completion probe; garbage key/model honestly fail) | **DELIVERED** — live-verified |
| Dashboard / shell | R1–R2 restyle → R8 redo (topbar removed, sidebar restructure, Settings hub) | **IN REVIEW** — R8 delivered |
| Sidebar projects | R8 (local-first store + ProjectView) → R9 backend swap (`/api/v1/projects`, pick_folder Browse under Tauri, projects-store deleted) | **IN REVIEW** (R9) |
| Project chat (`/project/:id/chat`) | R9 port → R10 demo-parity → R11 fullscreen → R12 streaming + stats + borderless polish | + hamburger sidebar toggle + agent picker in header | (full TopBar: agent picker + file search + theme grid + Experimental freeform + To-Do panel; 7 tools) | **IN REVIEW** — R10 delivered, live-verified on P1 |
| Dashboard | Owner verdict: "way too simple / rigid" — redo queued | **QUEUED** — next round |
| Mono theme dark mode | R8 accentDark fix | **DELIVERED** — visually verified |
| All set (step 4) | R1 port → R3 theme-derived confetti | **APPROVED** ("perfect") |
| Dashboard / Agents / Sessions / Chat | R1–R2 theme-engine restyle | Approved in the Phase-2 walkthrough ("everything is working properly… UI looks much better"); further polish on request |

## Round files

- [`round-01-02.md`](round-01-02.md) — initial port + adaptable-layout rounds
- [`round-03.md`](round-03.md) — owner verdict: PickFlavor & PlugBrain rejected, NeedBrain approved
- [`round-04.md`](round-04.md) — PickFlavor demo-anatomy rebuild (approved) + NeedBrain padding
- [`round-05.md`](round-05.md) — primary-button polish, PlugBrain full pass, live-key verification
- [`round-06.md`](round-06.md) — persistent dev backend (`pnpm dev:full`): fixes models list & test connection in the browser
- [`round-07.md`](round-07.md) — expand button lists the full catalog; PlugBrain scrolls as one unified flow
- [`round-08.md`](round-08.md) — honest connection test; dashboard/shell redo; Settings hub; mono dark; PROJECT-MAP + dev CLI
- [`round-15.md`](round-15.md) — model management (providers, models, pricing, keys, testing), dashboard v2 (light theme, multi-file), folder dialog .ps1 fix
- [`round-14.md`](round-14.md) — dashboard live on GitHub Pages (DASHBOARD repo, plan section, browser-verified)
- [`round-13.md`](round-13.md) — governance round: docs/ADRs/blueprints/workflow + tool-truth fixes + public dashboard (sub-agent audits)
- [`round-12.md`](round-12.md) — live streaming (SSE), per-reply stats + copy + ctx meter + model picker, borderless tight chat UI, drag fix, Nova→Acute, modern always-on-top folder dialog, DESIGN-SYSTEM.md, sandbox-wipe recovery via work branch
- [`round-11.md`](round-11.md) — owner Windows-verdict fixes: real folder dialog (2 methods + error surfacing), fullscreen chat with hamburger sidebar toggle, plug-and-play Nova agent seed, dialog centering fix, HTML-build live proof
- [`round-10.md`](round-10.md) — agentic coding system for real: OS folder picker, create_dir/delete_file/search_files, demo-parity chat UI (TopBar/To-Do/Experimental), live P1 proof incl. deletion refusal
- [`round-09.md`](round-09.md) — Agentic MVP M3 (project-chat UI port onto live data) + M4 (live ACUTEST run, files verified on disk) + live-call bug fix (`jsonSchema()` tool wrapping)

## Running the UI with a live backend (dev)

Plain `pnpm dev` = UI only (no sidecar — model catalog and connection tests
cannot work). For the full live workflow run **`pnpm dev:full`**: sidecar on
127.0.0.1:5178 with the OpenRouter key from Credential Manager + vite. See
[`round-06.md`](round-06.md).

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

- **round-27** (2026-08-24): web tools (web_fetch + web_search) + critical deps-wiring fix + demo project built by the agent. See round-27.md.
