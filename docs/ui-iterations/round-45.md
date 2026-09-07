<!-- last-reviewed: 2026-09-07 round-75 -->
# Round 45 — Finishing the agentic environment: security round (audit P0-3/P0-4/P0-5 CLOSED) · PTY terminal sessions · packaging v1 · TOOL_CATALOG drift guard · VLM pass (session manager un-orphaned + mobile drawer)

**Date:** 2026-08-28 · **Branch:** `main` · **Owner directives:** the continuing
"complete the whole agentic coding environment… quality over speed" directive —
this round closed the R42-audit security holes the owner had deferred at R44
("after this"), the round-44 PTY-terminal deferral, and the packaging workstream
that every prior round had queued. Plan: `agent-ctx/R45-plan.md` (sandbox).

**Commits (in order):** `0a68d0f` (security round: P0-3/P0-4/P0-5 + migration
0016, 46 new tests) · `d316ae3` (PTY terminal sessions, 34 new tests) ·
`fd70c5b` (packaging v1 + TOOL_CATALOG drift guard + SessionsScreen mobile
search, 5 new tests) · `6f75087` (VLM pass fixes: the three finds below).

## What shipped

### A. Security round — the last three deferred audit holes CLOSED (`0a68d0f`)

- **P0-3 — child-process env scrubbing.** `agent-core/src/lib/child-env.ts`
  exposes an ALLOWLIST-based `buildChildEnv()`: a spawned child gets the
  OS/toolchain variables it needs (PATH, HOME/USERPROFILE, TEMP, locale,
  Windows system vars, cargo/pnpm homes…) plus `FORCE_COLOR=0`/`CI=1` — and
  NOTHING else. Two defense layers on top: every name is scanned by a
  secret-shape pattern (`ACUTE_`, `*_KEY`, `TOKEN`, `OPENROUTER`…), and caller
  extras pass the same scan. Applied at **every child spawn site** — the
  `run_command` tool (`tools/exec.ts`), the git tool (`tools/git.ts`), the OS
  folder dialogs (`dialogs.ts`), BOTH terminal routes in `server.ts`, and the
  new PTY sessions. Children never inherit `ACUTE_TOKEN` or
  `ACUTE_PROVIDER_*`/slot keys; the existing output scrubbing in `runtime.ts`
  stays as defense in depth. Live-verified: a child probe printed nulls for
  every secret-bearing variable.
- **P0-4 — the AUTO command tier is path-contained.** New
  `commandTouchesOutsideRoot()` (approvals.ts) + a `root` param on
  `decideCommand`: an auto-tier candidate whose tokens reference ANY absolute
  path outside the project root, a `~`-relative path, a `..`-escape, or a
  Windows other-drive path is DEMOTED to the ask tier. `cat /etc/passwd` now
  ASKS (it auto-ran before). Explicit always-allow rules still win (the owner
  can grant broad commands deliberately); the compound-safe, quoted-token-aware
  tokenizer handles both POSIX and Windows path shapes. Live-verified through
  a real model turn: `approval.requested` card → deny → the agent reported the
  denial instead of running it.
- **P0-5 — web tools gated.** `web_fetch` + `browser_control:navigate` now
  pass a host gate (`decideWebFetch`): exact-host match against
  `DEFAULT_WEB_HOST_ALLOWLIST` (37 documentation/package/source hosts —
  github.com, npmjs.com, MDN, react.dev, nodejs.org, docs.rs, pypi.org, DDG,
  wikipedia, learn.microsoft.com…) or a per-project `web_host_rules` row
  (migration `0016_web_host_rules.sql`) → run; anything else → the SAME
  interactive approval round-trip commands use (SSE card + notification +
  timeout), and "always allow" remembers the **HOST**, not the URL. Other
  `browser_control` actions (back/forward/reload/viewport/get_state) stay
  auto. `web_search` stays friction-free (fixed DDG/Wikipedia endpoints) but
  the query is secret-scrubbed first (`scrubSearchQuery` — keyring values +
  key-shaped patterns) before it leaves the machine. Live-verified: nodejs.org
  auto-fetched; httpbin.org asked → approved → fetched; search returned 8
  results unaffected.
- 46 new tests in `agent-core/tests/r45-security.test.ts` (containment,
  demotion, host-gate decisions, rule persistence, query scrubbing) +
  `child-env.test.ts` (allowlist shape, secret-name rejection, real spawn
  probe).

### B. PTY terminal sessions — the round-44 "no interactive stdin" deferral closed (`d316ae3`)

`agent-core/src/terminal-sessions.ts` — a `TerminalSessionManager` with two
engines chosen by try-load at runtime: **node-pty** (optionalDependency, MIT,
added to `pnpm-workspace.yaml` allowBuilds — real TTY echo, resize, TERM
negotiation) and a pure-Node **persistent-pipe fallback** (one long-lived
bash/cmd.exe; cwd/env state persists across commands, but no TUI echo). Six
REST+SSE routes in `server.ts` (create/list/input/resize/stream/kill; see
ROUND-45 additions in IMPLEMENTED-API.md). Sessions are project-scoped
(cwd = project root, env = `buildChildEnv()` — the P0-3 scrub applies to PTY
children too), ring-buffered (256 KB, late viewers get the backlog as one
leading output frame), idle-reaped (10 min with NEITHER input NOR output — a
streaming build is never reaped), capped **3/project + 8 global** (oldest
evicted), and disposed on Fastify close + SIGTERM/SIGINT (no orphan shells;
dev.mjs's sidecar kill path is covered by the signal handlers).
`TerminalPanel` gains a **Run | Shell** mode toggle (Run path byte-identical
to R44-e): live streaming output, Enter-to-send input with ↑↓ history
(cap 100), Kill/New shell, engine badge, ANSI-stripped rendering, and a
visible error state (no silent death). Live-verified end-to-end through the
dev sidecar AND the real UI: typed `echo` in Shell mode via browser, PTY echo
seen, env-clean probe clean, `exit 0` produced the exit frame, DELETE reaped
it — 23 backend + 11 panel tests.

### C. Packaging v1 (`fd70c5b`) — version discipline + changelog + release workflow

- `scripts/release/version.mjs` — `get`/`set`/`check`; the version is
  SINGLE-SOURCED at **0.45.0** across root `package.json`, `agent-core`,
  `shared`, and `src-tauri/tauri.conf.json`; `pnpm version:check` gates CI
  right after install (drift = red build with the per-file values printed).
- `CHANGELOG.md` — Keep a Changelog format, seeded `[Unreleased]` (the bundled
  installer, next) → `[0.45.0]` and backfilled through 0.37.0, user-facing
  Added/Changed/Fixed/Security subsections only.
- `.github/workflows/release.yml` — verify (lint + typecheck + test + version
  check) → assemble the **launcher-kit zip** (CRLF-guarded ACUTE.bat +
  acute.sh + acute_launcher.py + credentials.example.txt + launcher README +
  CHANGELOG + VERSION) → artifact upload; tag-gated draft GitHub release.
  **DISPATCHED AND VERIFIED:** run `33182499163` SUCCESS, artifact
  `acute-launcher-kit-v0.45.0` (24107 bytes) confirmed via the Actions API.
- The kit is the LAUNCHER flow — the bundled installer/sidecar stays a
  documented next step (ADR-0003 dev-mode note), honestly scoped.

### D. TOOL_CATALOG drift guard (`fd70c5b`)

`src/lib/tool-catalog-drift.test.ts` reads `agent-core/src/storage/agents.ts`
as TEXT (no cross-package import), extracts `TOOL_NAMES`, and deep-compares
against the frontend `TOOL_CATALOG` in `src/lib/api.ts` — failure prints BOTH
lists, the per-side missing delta, and the exact files to edit. The R44
15-vs-21 lag (agent-dialog checkboxes missing tools) can never silently
recur: a backend tool without a catalog entry fails CI. 2 tests (21 = 21
today; failure path exercised during development).

### E. VLM UI verification pass (`6f75087`) — three real finds, all fixed + live-verified

1. **The R44-c session manager was ORPHANED.** SessionsScreen (session
   search/fork two-pane) had shipped with 23 passing tests but was imported
   by NO route — session search was unreachable at any screen size. Now
   routed at `/sessions` with a sidebar nav entry. (The old App test that
   pinned "no Sessions nav" had pinned the bug; corrected.) Lesson #64 in
   AGENT-MEMORY.md.
2. **No mobile drawer existed.** The sidebar was a static 270 px column
   leaving **69 px** of content at 375 px (the R43 geometry pass only
   verified ≥700 px). Below `md` the shell now has a proper overlay drawer —
   floating logo trigger, dark backdrop, auto-close on navigation — measured
   main width 69→351 px, mobile search input 58→319 px; desktop layout
   byte-identical (trigger is `md:hidden`, sidebar inline above `md`).
3. **The wizard version badge was hardcoded `v0.1.0`** — now single-sourced
   from `package.json` via a vite `__APP_VERSION__` define (works under
   vitest too) and reads `v0.45.0`.

VLM-verified after the fixes: mobile sessions screen PASS, drawer overlay
PASS, terminal Shell mode PASS, wizard badge PASS.

## Verification

- `pnpm lint` / `pnpm typecheck` (root + agent-core) CLEAN.
- **Tests: 565 in 49 files** (`pnpm test`, run again for this report — was 473
  in 44 at R44; +92: r45-security 46, terminal-sessions 23, TerminalPanel
  +11, child-env 7, tool-catalog-drift 2, SessionsScreen mobile +3).
- **CI (GitHub Actions API, not hand-claimed):** run `33181641242` @
  `fd70c5b` (push) **success** · run `33184750437` @ `6f75087` (the tip)
  **success** — dispatched manually because the push on `6f75087` did NOT
  auto-trigger a run (a push-trigger miss; the workflow_dispatch fallback is
  golden-rule-4 protocol) · Release run `33182499163` @ `fd70c5b` **success**
  with artifact `acute-launcher-kit-v0.45.0` (24107 bytes).
- **Live battery:** env-clean child probe (nulls for every secret-bearing
  var) · `cat /etc/passwd` ask→deny round-trip through a real model turn ·
  nodejs.org auto-fetch + httpbin.org ask→approve round-trip + search
  unaffected (8 results) · PTY session create → typed command in the real UI
  (Shell mode) → echo + env-clean probe + `exit` frame → delete.
- docs:check (this round's docs batch): 0 failures / 0 warnings.

## Known limitations (honest)

- **PTY fallback echo:** if node-pty fails to build on a machine (native
  toolchain missing — it builds on CI ubuntu/windows and this sandbox), the
  persistent-pipe fallback keeps cwd/env state but has NO TUI echo: full-screen
  apps (vim, less) won't render, though line commands still work. Windows
  bash-dependent PTY tests `skipIf(win32)` by design (the R44 CRLF lesson).
- **User-typed browser-panel navigation is STILL ungated — by design.** The
  P0-5 gate covers the AGENT's `web_fetch`/`browser_control` calls; a URL the
  human types into the BrowserPanel is a user action, like typing it into
  their own browser.
- **The release kit is the launcher flow, NOT the bundled installer.** Tag
  `v*` produces the launcher-kit zip + a draft release; the packaged
  exe/bundled-sidecar workstream (ADR-0003 "dev mode only" note) is the
  documented next step, tracked in CHANGELOG `[Unreleased]`.
- **Memory digest is still newest-first** (no relevance ranking in the
  injection) — memory v2 (ranking, edit UI) remains queued.
- **The P0-4 containment is token-based, not a real sandbox.** A demoted
  command can't silently escape via a path token, but approved commands
  still run with full user privileges — the approval engine remains the
  boundary (as it has been since v1). Shell escapes like `bash -c "<anything>"`
  inside a command string still exist — but such commands were never
  auto-tier anyway; they always asked.
- Browser-proxy v1 limits from R43 still true: no cookie persistence
  (logins), runtime-JS URLs bypass the rewrite, multipart POST opaque,
  hostname-only private-net guard.
