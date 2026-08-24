<!-- last-reviewed: 2026-08-24 round-33 -->
# Round 08 — Honest connection test, dashboard/shell redo, Settings, mono dark, project map, dev CLI (2026-08-22)

Owner direction: fix the test-connection lie; the dashboard "needs quite a
lot of redoing" (topbar useless, no theme/mode chrome, sidebar wrong);
understand & document the project properly for the complex future (scheduling
etc.); give the agent tooling to test from its own environment. The setup
wizard is DONE and approved — focus moves to the dashboard demo + chat demo
design language.

## 1. Test connection honesty (bug: "always says connected")

Root cause: the sidecar's probe only hit `GET {baseUrl}/models` — OpenRouter's
catalog is PUBLIC (any garbage key returns 200) and the model id was never
validated, so every test "passed".

Fix:
- `testProviderConnection` now runs a **one-token completion**
  (`POST /chat/completions`) when a model is given — validates key AND model.
  Upstream rejections map to HTTP 200 `{ok:false, message}` (a test that
  executed and answered NO); transport failures stay 502. No-model probes
  keep the reachability check and label it as such.
- New `POST /internal/providers/keys` (token-walled, shell-only): rotates a
  key inside the in-memory keyring; `ProviderKeyring.set()` + cache drop.
  The Tauri shell's existing push (keys.rs) now lands — Test-after-Save tests
  the just-typed key.
- Frontend: `testConnection` no longer masks failures as successes; in Tauri,
  Test stores the typed key first; browser dev result says "server key".

Verified live (curl + UI): bogus model → `ok:false "…not a valid model ID"`;
rotated-to-garbage key → `ok:false "key rejected (HTTP 401): User not found."`;
real key + `stealth/ox-alpha` → `ok:true`. The Settings API tab shows the
honest failure text in the UI. 95 sidecar tests green (7 new).

## 2. Shell & dashboard redo (per the owner's two demos)

- **TopBar deleted entirely** (theme/mode buttons gone with it).
- **Sidebar** restructured: brand + **Dashboard** in a highlighted top area ·
  separated **PROJECTS** section (color-chip items, delete-on-hover, count
  badge, Add Project dialog → name + folder path) · **Usage** · **Settings**.
  Sessions and Agents are deliberately NOT sidebar entries anymore.
- **Dashboard**: stat cards now Projects / Sessions / Tokens / API Requests
  (agents management lives in Settings); Quick Actions retargeted.
- **Projects**: local-first persisted store (`src/lib/projects-store.ts`);
  `/project/:id` ProjectView with an honest "project chat arrives with
  orchestration" state plus recent workspace sessions.
- **Settings rebuilt**: tabs = Appearance (mode + full theme list — the new
  home of theme/mode), Agents (embedded registry), API & Providers (per-key
  storage + honest live test), Advanced (data source). Deep-linkable `?tab=`.

## 3. Mono theme dark mode

`ThemeColors` gains optional **`accentDark`** (Mono: `#E0E0E0`) —
`deriveThemeStyles()` picks it in dark mode so accent text/icons/charts stay
legible on dark backgrounds. Table-driven as always; verified visually
(mono-dark dashboard fully readable).

## 4. Documentation & tooling for the future

- **`docs/architecture/PROJECT-MAP.md`** — the requested living project
  memory: what ACUTE-CODE is, the four-layer process map, naming/state/
  secrets conventions, data model, surface status, and the future direction
  (scheduling, automations, project-centric work) with rules that keep new
  capabilities additive.
- **`scripts/acute.mjs`** — dev CLI (health/providers/models/test/agents/
  sessions/usage/raw) against the dev sidecar, so the agent can self-test
  from a terminal without curl acrobatics.
- Sidebar/project flow covered by 4 new unit tests (create → navigate →
  view → delete, plus nav-structure assertions).

**Status: delivered; awaiting owner review of the dashboard + Settings.**
