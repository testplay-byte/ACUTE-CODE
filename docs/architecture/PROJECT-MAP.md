<!-- last-reviewed: 2026-08-30 round-54 -->
# ACUTE-CODE — Project Map

**The living map of what this project is, how every part links together, and
the conventions that keep it manageable as it grows.** Read this before
touching code; update it whenever structure changes (it is the owner's
requested "memory" of the system — HANDOFF.md covers process/state, this file
covers the system itself).

Last updated: 2026-08-22 (round 8).

---

## 1. What ACUTE-CODE is

A **local-first, closed-source Windows desktop workbench for orchestrating
multiple AI coding agents** — and more: the product will grow well beyond a
coding assistant (scheduling, advanced automations, richer tool surfaces).
"Local-first" means all processing, data and orchestration happen on-device;
LLMs are cloud APIs only. The human-in-the-loop approval engine is the
security boundary (no sandbox in v1). Distribution: a portable folder with an
exe (ADR-0003).

Three run modes (ADR-0001): **single** agent (default), **auto-team**
(a cheap orchestrator model delegating to a powerful worker), **manual**
team. Max 5 concurrent agents.

## 2. Process map (four cooperating layers)

```
┌─ Tauri 2 shell (Rust, src-tauri/) ────────────────────────────────┐
│ window · sidecar lifecycle · Credential Manager key custody       │
│   sidecar.rs: mint token → spawn node dist/main.js → ready-line    │
│   keys.rs:   store_provider_key → Credential Manager + push to    │
│              POST /internal/providers/keys on the running sidecar │
└───────────────┬───────────────────────────────────────────────────┘
                │ env: ACUTE_TOKEN, ACUTE_DB_PATH, ACUTE_PROVIDER_<ID>,
                │      ACUTE_PORT (dev only); stdout: ACUTE_READY {port}
┌───────────────▼─ agent-core sidecar (Node/TS, agent-core/) ───────┐
│ Fastify 5 REST+WS · owns SQLite (WAL) · THE ONLY SQL LIVES HERE   │
│   server.ts        routes, bearer wall, CORS allowlist, envelope  │
│   providers/       keyring (env + internal handoff), model cache, │
│                     connection test (one-token completion probe)  │
│   agents/          AI-SDK chat seam + single-agent turn runtime   │
│   approvals.ts     fail-closed tool categorizer (denylist first)  │
│   storage/         migrations + agents/providers/sessions/usage   │
└───────────────┬───────────────────────────────────────────────────┘
                │ localhost REST /api/v1 (WS in Phase 3)
┌───────────────▼─ React 18 frontend (src/) ────────────────────────┐
│ AppShell: sidebar (Dashboard / Projects / Usage / Settings)       │
│   dashboard/  Welcome view: greeting, stat cards, chart, activity │
│   projects/   ProjectView (project home; chat flow = Phase 3)     │
│   sessions/   SessionsScreen + ChatView (chat window flow: R9+)   │
│   agents/     AgentsScreen (embedded in Settings → Agents tab)    │
│   onboarding/ first-run wizard (owner-approved round 4+)          │
│   pages/      SettingsPage: Appearance · Agents · API · Advanced  │
│   lib/        theme engine, stores, config, hooks, motion         │
└───────────────────────────────────────────────────────────────────┘
                │ import type only
           shared/ — canonical domain types (RunMode, AgentRecord, …)
```

Everything flows through the sidecar: the UI never touches SQLite, never
sees provider keys (Credential Manager → env → in-memory keyring only).

## 3. Naming & structure conventions

- **Packages**: `agent-core` (sidecar), `shared` (types), root = frontend.
  Rust stays in `src-tauri`. No cross-imports except `shared`.
- **Files**: components `PascalCase.tsx` exporting the same-named component;
  hooks `use-<thing>.ts`; stores `<thing>-store.ts`; libs lowercase kebab.
  agent-core source files match their route domain (`providers/`, `agents/`,
  `storage/`).
- **Relative imports inside agent-core/src MUST end `.js`** (ESM dist).
- **IDs are slugs**: providers/projects/agents use `[a-z0-9_-]`; provider
  keys live at `ACUTE-CODE/provider/<providerId>` (user `api-key`).
- **Env contract**: `ACUTE_TOKEN`, `ACUTE_DB_PATH`, `ACUTE_PROVIDER_<ID>`,
  `ACUTE_PORT` (dev). Frontend dev wiring: `VITE_ACUTE_BASE_URL`,
  `VITE_ACUTE_TOKEN` (.env.development).
- **State**: server state via TanStack Query (`["<domain>", ...]` keys);
  local UI state via zustand stores (`*-store.ts`), persisted under
  `acute-code.*` localStorage keys; wizard secrets are NEVER persisted.
- **Theming**: everything reads `useThemeStyles()` / `--ac-*` vars derived
  from the THEMES table (`src/lib/themes.ts`). Adding a theme = one table
  entry; mode-specific accents use optional `accentDark`. Never hard-code
  theme ids or colors in components.
- **Error envelope**: sidecar errors are `{error: {code, message,
  details?}}`; probes that EXECUTE and fail answer HTTP 200 `{ok:false}`.
- **Secrets rule**: keys exist only in Credential Manager and the sidecar's
  in-memory keyring; never in REST bodies (except the shell-only
  `/internal/*` handoff), never logged, never in error text.

## 4. Data model (SQLite, migrations in agent-core/src/storage/migrations)

- `providers` (seeded: openrouter) + in-memory keyring → `hasKey` flag.
- `agents` (+ 5 seeded templates: planner/researcher/coder/reviewer/tester).
- `sessions` + append-only `session_events` (ADR-0010).
- `usage_records` (tokens/cost per turn; feeds /usage/summary).
- Coming with orchestration (F3): projects↔sessions linkage, message bus
  events, task board, approvals audit log.

## 5. Product surfaces & status (round 8)

| Surface | State |
|---|---|
| First-run wizard (5 steps) | **Owner-approved** (rounds 1–7) |
| Dashboard (welcome view) | Round-8 pass delivered (no topbar, Projects stat) |
| Sidebar | Round-8 structure: Dashboard / PROJECTS / Usage / Settings |
| Project registry + ProjectView | Round-8 (local-first store; backend link = F3) |
| Settings (Appearance/Agents/API/Advanced) | Round-8 |
| Sessions/ChatView | Exists; sidebar entry removed by design — the chat-window flow (project-chat demo) lands with orchestration |
| Usage screen | Placeholder (F7) — real aggregation after Phase 3 |
| Orchestration engine | Phase 3 (gate pending owner approval) |

## 6. Where the project is going (owner direction, 2026-08-22)

- **Far more than a coding assistant**: scheduling, advanced automations and
  further surfaces are expected; keep module boundaries clean so each new
  capability is an additive domain, not a refactor (e.g. `scheduling/` will
  be its own sidecar domain + UI surface, not a wedge into agents/).
- **Project-centric work**: projects become first-class backend entities
  linked to sessions, chat windows, task boards and the approval log.
- **Robustness over features**: every round ships verified (tests + live
  probes + browser screenshots); quality over speed is a standing rule.

## 7. Dev & test entry points

- `pnpm dev:full` — UI + live sidecar (models/test/chat work in browser).
- `pnpm verify` — lint + typecheck + tests + build + e2e + license audit.
- `node scripts/acute.mjs <cmd>` — CLI against the dev sidecar (health,
  providers, models, test, agents, sessions, usage) for quick self-testing.
- `scripts/dev.mjs`, `scripts/credential.ps1`, `scripts/license-audit.mjs`.
- CI (GitHub Actions, windows-latest) runs verify + cargo check on push.
