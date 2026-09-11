<!-- last-reviewed: 2026-09-11 round-90 -->
# R51 PLAN — the owner's fourth Windows test round

Source: the owner's R50 feedback message (fourth test round). Sandbox verified
INTACT at round start (repo at 0.50.0 / dbe0aaa, worklog current, secrets in
place — no restore needed).

## The round's one big discovery (made in orchestrator recon)

**Why the browser is "still not working": the owner never runs the Tauri
shell.** The launcher (`launcher/acute_launcher.py`) runs `pnpm dev:full`
(vite :5173 + sidecar :5178) and opens the **system browser** at
http://localhost:5173. In that mode `window.__TAURI__` is undefined →
`isNativeBrowserAvailable()` is false → the BrowserPanel renders the **R43
fetch-proxy iframe** (the exact path the owner rejected). The R50 native
child-webview browser only activates inside the Tauri shell, and there is no
bundled installer yet (ADR-0003/0009 deferred it). So every "browser still
broken" report will recur until we DELIVER THE SHELL.

## Task graph

Wave 1 (parallel, disjoint files):
- **R51-a — desktop shell delivery** (THE browser fix): CI-built Windows NSIS
  installer with bundled node.exe + agent-core (pnpm deploy), release-mode
  sidecar spawn in Rust, key slots 2–4 through Credential Manager, launcher
  desktop flow (download → silent install → launch, dev-mode fallback), and a
  visible engine badge + native-failure auto-fallback in BrowserPanel.
- **R51-b — SubAgentPanel polish**: remove the accent left-rail on the final
  report (the owner's "AI slope" complaint), full todo list (not just the
  progress bar), centered + refined stats footer.
- **R51-c — Composer polish**: icon-only Add Context, model-name-only selector
  button, viewport-aware model flyout positioning (no bottom/right cutoff),
  donut without the inline % label + hover-bridge fix + warning colors,
  session stats split main/sub-agents/combined, min-width protection against
  control overlap.

Wave 2 (parallel, disjoint files):
- **R51-d — main agent efficiency + transcript highlighting**: prompts.ts
  understand-first/batch-reads/fewest-steps rework (kill the mandatory
  read-back verify), distinctive collapsed-row treatment for delegate_task and
  file-edit rows in WorkingSection.
- **R51-e — usage page**: ACUTE-CODE `scripts/export-usage.mjs` (DB →
  public-safe usage.json) + the DASHBOARD Usage page (projects → sessions →
  tool calls / sub-agents / tokens / cost).
- **R51-f — deepseek-harness study + selective adoption**: research doc
  (MIT-licensed reference, cloned to /tmp/deepseek-harness) + implement the
  loop-hygiene guard (consecutive identical/failed tool calls → nudge →
  honest stop) in the runtime outer loop.

Close (orchestrator): `pnpm smoke` entrypoint (curated fast test subset — the
owner explicitly said NOT to re-run the full suite repeatedly), full gates
ONCE, live battery, docs (round-51.md, CHANGELOG 0.51.0, HANDOFF,
IMPLEMENTED-API, ORCHESTRATION-WORKLOG, MAINTENANCE), commit, push, CI watch
to real SUCCESS, DASHBOARD publish, ntfy → TASKISDONE.

## Test policy this round (owner directive)

Sub-agents run TARGETED vitest files only (`pnpm vitest run <files>`). The
full suite runs ONCE at close. No repeated full-suite runs.

## File ownership map (conflict avoidance)

- R51-a: src-tauri/** (Cargo.toml, browser.rs, sidecar.rs, keys.rs, lib.rs,
  tauri.conf.json), .github/workflows/release.yml, launcher/acute_launcher.py,
  `src/components/right-sidebar/BrowserPanel.tsx` + tests, src/lib/native-browser.ts.
- R51-b: `src/components/right-sidebar/SubAgentPanel.tsx` + tests,
  src/lib/stream-store.ts (todo items), api types for todos.
- R51-c: `src/components/project-chat/composer/**` + tests, AgentChatPanel.tsx
  (min-width), agent-core context-report route (session-totals split),
  src/lib/api.ts (context report types).
- R51-d: agent-core/src/agents/prompts.ts + prompt tests,
  `src/components/project-chat/WorkingSection.tsx` + tests.
- R51-e: scripts/export-usage.mjs (new), DASHBOARD repo (build.mjs, src/, data).
- R51-f: docs/research/deepseek-harness-notes.md (new),
  agent-core/src/agents/runtime.ts (loop-hygiene guard) + tests.

Shared-file rule: any needed change outside a task's own list goes through the
orchestrator (documented deviation in the worklog).
