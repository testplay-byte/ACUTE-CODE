<!-- last-reviewed: 2026-09-02 round-61 -->
# Round 61 — Computer use (the desktop-control system), the separate vision model, skills + MCP extensibility, and the monitor

**Date:** 2026-09-02 · **Branch:** `main` · **Version:** 0.61.0 · **Owner directives:** the computer-use round — the agent observes and actuates the real desktop GUI ("give the user the option to turn on and off the computer use"); the vision model is configured COMPLETELY separately ("for the vision we are utilizing a separate model. The user can configure our model for the vision itself… the provider completely separately" + "if the main model supports vision then the user will be given an option to configure that too"); extensibility ("the ability to add multiple skills" + "the ability to add MCP servers too"); the monitor ("in a mini window it will show the details and their stats while the agent is using computers… what it's about to do, how it's thinking, the progress"); and the prompt upgrade ("improve its tool calling skill using"). Built to the uploaded 13-doc build-ready spec (`computer-use-docs/01..12`).

## The round's shape

The backend (~8.3k lines: the computer/ engine, 3 platform backends, the mcp/ client, skills + mcp + computer-use storage, 3 plugins, migration 0023, +318 server-route lines, keys.rs vision slots, prompts + golden fixture) was written in the prior session whose context died before verification; R61-main-1 resurveyed, repaired the 4 failing suites + 12 typecheck + 6 lint errors, verified the whole backend green, and wrote the shared frontend contract; two sub-agents built the UI; the orchestrator integrated; this agent wrote the docs.

| ID | Workstream | Files owned |
|---|---|---|
| R61-main-1 (orch) | Backend rescue + verify + the frontend contract (api.ts client, computer-monitor store, stream intercept, sidebar tab type) | agent-core/src/computer/**, plugins/{computer-use,skills,mcp}.ts, storage/{computer-use,skills,mcp}.ts, mcp/manager.ts, migration 0023, server.ts ROUND-61, keys.rs, prompts.ts + golden, src/lib/{api,computer-monitor-store,stream-store,right-sidebar-store}.ts |
| R61-2-a | The THREE settings tabs (Skills / MCP / Computer Use) + tests | src/components/settings/{SkillsTab,McpTab,ComputerUseTab}.tsx + tests (new files only) |
| R61-2-b | The monitor: right-sidebar ComputerPanel + the floating ComputerMiniWindow + tests | src/components/right-sidebar/ComputerPanel.tsx, src/components/ComputerMiniWindow.tsx + tests |
| Integration (orch) | SettingsPage sections, RightSidebar tab + panel mount, AppShell mini-window mount, icons | src/pages/SettingsPage.tsx, right-sidebar/RightSidebar.tsx, shell/AppShell.tsx |
| R61-2-d (docs) | This round file + the two runbooks + IMPLEMENTED-API/CHANGELOG/HANDOFF/TESTING/README updates | docs/** |

Suite: **1348 → 1491 tests in 102 files** (+143: 93 backend computer/skills-mcp + 50 settings/monitor UI), lint/typecheck clean, agent-core alone 786/786 in 48 files.

## 1. The computer-use engine (R61-main-1)

The engine is `agent-core/src/computer/` (the uploaded spec's 01..12, code-side):

- **types.ts** — the contract types: app refs, targets (element | coordinate — the two coordinate spaces NEVER mix: image pixels are the only thing the agent submits; the server owns image→global), snapshots/elements, frames, receipts (`acute-cua-action-receipt-v1`, `actionSent`/`dispatchStatus`/`retryAction` — never promises), the 22 refusal codes, the monitor event ring, the vision-mode types.
- **errors.ts** — the refusal factory: every refusal (a) names the reason machine-readably, (b) explains in one sentence, (c) states nothing-was-sent when true, (d) prescribes the EXACT next step (doc 11's self-teaching shape).
- **session.ts** — the process-singleton control session: snapshot store (keep-8, TTL 120 s, CONSUMED after any element write — supersession), frame registry (keep-8, 10 s freshness), held-button ownership, the ENFORCED kill switch, the 200-entry monitor ring + stats.
- **audit.ts** — the append-only JSONL journal at `<project>/.acute/computer-use/audit.jsonl` with on-write redaction (credential-shaped strings scrubbed; text/clipboard/value → length markers; 2000-char caps; no rasters ever).
- **dispatch.ts** (1 337 lines) — the brain: universal gates (killSwitch → session liveness → scope identity → foreground rule on Win/Linux → held-button consistency), the doc-07 routing matrix (a11y semantic vs raw vs fail-closed), receipt wrapping, journaling, raster cache for zoom/vision.
- **vision.ts** — the relay (below).
- **backends/** — interface.ts (the CuaBackend protocol: command capsules, the honest capability matrix, "refuse never degrade") + linux.ts (wmctrl/xrandr/gdbus-AT-SPI/xdotool/import-or-scrot/xclip; X11-only raw input, Wayland reported honestly) + windows.ts (PowerShell + UIA, DPI-aware, AttachThreadInput activation with postcondition verification) + macos.ts (osascript/AX + screencapture + cliclick, TCC-gated) + index.ts (platform detection + the real runner).

The **plugin** (`plugins/computer-use.ts`) registers exactly the **30 doc-02 tools** behind the settings gate: default OFF (createTools returns [] until `computerUse.enabled`), the observe posture registers only the 11 read-only tools, and the act posture's consent gate rides the SAME approval channel as run_command for the real-input risk classes (ask permission-mode; auto posture and full mode skip). The dispatcher's mutation gate (`allowMutations: permission !== "observe"`) is the second wall — even a called allowlisted mutation refuses `host_policy_denied` in observe posture.

## 2. The separate vision model (the owner's core directive)

`computerUse.vision.mode`: **off** (default — screenshots return raster metadata, nothing breaks) · **separate** (the configured provider + model with the DEDICATED key slot — keyring pseudo-provider `<providerId>-vision`, credential target `ACUTE-CODE/provider/<id>-vision`, env `ACUTE_PROVIDER_<ID>_VISION`, the exact R51 slot pattern; honest primary-key fallback when no dedicated key was pasted) · **main** (the turn's model, gated on the model row's `supports_vision` flag — `models.supports_vision` is a new column, prefilled from the catalog, editable per row). The relay (`computer/vision.ts`) is deliberately fetch-direct: one POST, one image part, terse text back; `chat-completions` and `anthropic-messages` wire formats; used ONLY for `screenshot`/`zoom` with `describe:true`.

## 3. The monitor (R61-2-b)

Two surfaces over ONE merged store (`src/lib/computer-monitor-store.ts`):

- **The right-sidebar Computer tab** (`ComputerPanel.tsx`) — the full feed: OFF/STOPPED/LIVE/Idle status chip (master switch wins), the 4 stat cells + elapsed clock + backend, the newest-first event ring (kind icon, label, tool chip, refusal-code chip), the STOP kill switch, the pop-out button. Polls `GET /computer-use/session` 2 s while active / 10 s idle.
- **The floating mini window** (`ComputerMiniWindow.tsx`, app-wide via AppShell, renders only while open) — a 340 px fixed-position draggable card (title bar = drag handle, viewport-clamped) answering the owner's three questions in order: WHAT it's doing (newest event, biggest weight), HOW it's going (stats strip + refusal/vision spotlights), HOW to stop it (full-width STOP).
- **The data path**: every tool execution emits one `{type:"computer-use", kind, tool?, code?}` SSE envelope at dispatch time; `stream-store.ts` intercepts these BEFORE the liveTurn guard → `pushLiveEvent` (live updates even for background turns, zero polling latency); the polled session truth (server labels + stats + kill-switch state) lands via `refreshFromServer` (server rows win).
- **STOP** = `POST /computer-use/stop` — the kill switch engages, a session-held button is released with a real mouse-up at its recorded point (the only sanctioned auto-release), and every further computer-use call refuses `kill_switch_active`.

## 4. The extensibility surfaces (R61-main-1 + R61-2-a)

- **Skills** (Settings → Skills): SKILL.md-style modules with progressive disclosure — name + description ride the system prompt (`## SKILLS (load with read_skill)`), the body loads via `read_skill` (≤60 000 chars). The built-in `computer-use` skill (doc-09 condensed) is seeded INSERT-OR-IGNORE (edits persist; deletion of built-ins refused with a note — disable instead); user skills full CRUD. Migration 0023 appends `read_skill` to template + default-agent allowlists; explicitly user-curated lists untouched.
- **MCP servers** (Settings → MCP): stdio JSON-RPC (initialize → tools/list → tools/call, 10 s/60 s timeouts, one-strike respawn) with a SANITIZED child env (PATH/HOME/TMPDIR/LANG/TERM + configured; every `ACUTE_PROVIDER*` name stripped — no credential leak). Tools bridge as `mcp__<server>__<tool>` (≤32-char slug so the grammar fits; over-length skipped + logged). A broken/unconfigured server contributes nothing (fail-soft). The tab: probe (reachable · N tools · X ms), expandable live tools list, delete kills the child.
- **The plugins listing** (`GET /plugins?projectId=`): the 12 built-ins' metadata (computer-use listed even while gated off — the gate is settings, not existence), the computed live tool catalog, and the external `.mjs` file report with loaded bits + the honest load-error note.
- The settings tabs (R61-2-a): SkillsTab (chips, switch, editor, two-step delete, rejected-delete message surface), McpTab (command line, probe/tools/delete, parsed args/env create), ComputerUseTab (the master card with a REAL optimistic switch + posture radios + Test readiness; the vision card — separate: provider select + supports-vision-filtered model datalist + the masked dedicated-key row; main: the per-row eye toggle PATCHing `supportsVision`; the safety card).

## 5. The prompts upgrade ("improve its tool calling skill using")

`agent-core/src/agents/prompts.ts` + the golden fixture (`agent-core/tests/fixtures/prompt-golden-r61.txt`): three tool-discipline rules (read errors fully before reacting / pick the MOST SPECIFIC tool / NEVER fabricate results), the honest-reporting rule in the AGENTIC LOOP ("a truthful failure report the user can act on beats a confident fiction"), the closing contract in COMMUNICATION (state what you did, what you verified and how, follow-ups), and three gated sections — SKILLS (when enabled skills exist), COMPUTER USE (the always-on discipline while the master switch is on, incl. the observe-only posture line), MCP SERVER TOOLS (when `mcp__*` tools are in the set).

## Architecture summary

```
Settings → Computer Use (PUT /computer-use/config)
  └─ computerUse.{enabled,permission,vision.mode/provider/modelId} (settings table)
       ├─ plugins/computer-use.ts createTools: [] unless enabled; observe → 11 read-only tools
       │    ├─ consent gate (act + ask-mode) → requestCommandApproval (the run_command channel)
       │    ├─ ComputerDispatcher.dispatch (gates → matrix → receipt → audit)
       │    │    ├─ backends/{linux,windows,macos} via realRunner() (CommandCapsules)
       │    │    ├─ getComputerSession() (singleton: snapshots/frames/held/killSwitch/ring)
       │    │    └─ appendAudit → <project>/.acute/computer-use/audit.jsonl (redacted)
       │    ├─ emit {type:"computer-use"} per execution → SSE → stream-store intercept
       │    │    └─ useComputerMonitorStore → ComputerPanel + ComputerMiniWindow (+ GET session polling)
       │    └─ vision relay (describe:true) → separate slot "<provider>-vision" / main supports_vision
       └─ keys.rs store_vision_key → credential ACUTE-CODE/provider/<id>-vision + env at spawn
skills table → prompts SKILLS section + read_skill tool (migration 0023 appended allowlists)
mcp_servers table → mcp/manager.ts child (sanitized env) → mcp__<server>__<tool> tools
```

## Verification

- **Root suite: 1491/1491 in 102 files** (was 1348/91) — re-run by this docs agent at
  2026-09-02 (`npx vitest run`: 102 files, 1491 tests, all passing; agent-core
  alone: 786/786 in 48 files). `pnpm lint` CLEAN · `pnpm typecheck` CLEAN
  (per R61-main-1/2-a/2-b; the contract-layer gaps — RightSidebar icon map,
  supportsVision fixtures — were closed by the integration wave) ·
  `pnpm docs:check` 0 failures.
- **New suites**: computer-dispatch 33 (gates, matrix, receipts, audit, app-ref
  resolution), computer-session 12 (lifecycle, kill switch, snapshot/frame
  stores, the ring), computer-errors-audit 15 (refusal catalog shapes, journal
  redaction), computer-use-plugin 13 (settings gates incl. default-OFF + the
  exact 30 names + observe subset, output shapes, consent gate, vision wiring,
  audit trail), computer-vision 10 (slot resolution, both wire formats,
  main-mode gating), skills-mcp 10 (skill seed/CRUD/builtin-delete-refused,
  MCP storage, the manager: sanitize/round-trip/fail-soft/probe/banner) ·
  frontend: SkillsTab 11, McpTab 12, ComputerUseTab 12, ComputerPanel 8,
  ComputerMiniWindow 7.
- **Migration 0023** applied on fresh + upgraded DBs (memory-tools +
  models-catalog pin the 24-name allowlists + the template appends).
- **Live verification: NOT DONE — honestly.** This sandbox is headless; the
  dispatcher is unit-tested against an injected fake backend and the plugin
  tests run the real Linux backend headless (shape contracts pinned, GUI
  paths fail closed). The Windows + macOS backends have never run on live
  hardware. The LIVE-VERIFICATION CHECKLIST (master switch + Test readiness
  → list_apps → get_app_state → one act-mode approval action → the mini
  window + STOP) is in `docs/runbooks/COMPUTER-USE.md` and is the FIRST item
  of the owner's next session.

## Known limitations

- **All three platform backends are live-unverified** (see above) — the code
  is complete per the spec, the logic is tested, the GUI paths are not.
- **Two frontend/server contract drifts found by the docs agent — both
  FIXED in the close-out**: (a) `POST /computer-use/test` now composes the
  UI verdict server-side (`ok` + `issues` ride the report object; the raw
  accessibility/screenCapture fields stay); (b)
  `GET /computer-use/session`'s `state()` now sends `stopReason` (null
  while running) exactly as the frontend type expects.
- **MCP + external plugins load honesty**: a broken server/plugin is skipped
  with a logged diagnostic (the UI shows the honest error/loaded bit) —
  there is no auto-repair; the owner reads the engine log.
- **The vision relay is fetch-direct** chat-completions/anthropic-messages
  only (the `responses` apiFormat is not relayed) — the same honest
  limitation the chat seam carries.
- **Linux raw input is X11-only** (Wayland has no generic injection — the
  backend reports it); **Linux window-scoped typing = NO** (honest matrix).
- **macOS raw input** approximates foreground semantics via osascript/
  cliclick; the private-API window-scoped path is deliberately not used.
- One control session per engine process (the doc's singleton rule);
  `resetForTests` is the only reset.

## Owner-visible summary (for the next session's verdict)

1. Settings → **Computer Use**: master switch (OFF by default) + posture
   (observe / act-with-approvals [recommended] / auto) + **Test readiness**.
2. **The vision model is its own thing**: off / separate (provider + model +
   its OWN key slot, masked) / main (only when the model row is marked
   supports-vision — the eye toggle).
3. The agent can **observe your desktop** (a11y tree first) and **act** with
   your approval in act mode — receipts, named refusals, and an audit
   journal per call.
4. The right-sidebar **Computer tab** + the **floating mini window** show
   every step live (what it's about to do, stats, refusals) with the
   **STOP** kill switch.
5. Settings → **Skills** (add/edit your own; the built-in computer-use
   skill is there) and Settings → **MCP** (add servers, probe, see tools).
6. The system prompt got the tool-discipline + honesty upgrade, and loads
   the new sections only when their surfaces are on.
7. **Before trusting computer use, run the live-verification checklist** in
   `docs/runbooks/COMPUTER-USE.md` — the sandbox could not verify real GUI
   interaction.
