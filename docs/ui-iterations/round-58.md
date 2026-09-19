<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 58 — The desktop-polish round: the first fully-working Windows session, and every UX bug it surfaced, fixed

**Date:** 2026-08-31 · **Branch:** `main` · **Version:** 0.58.0 · **Owner directives:** the eleventh Windows test session — the first COMPLETE success on the desktop path (the R57 engine-bundling fix held): *"This time the application works properly. The app opens up without any errors or any issues at all. Everything is proper and I am quite satisfied with it."* — followed by a dense, precise defect list: the native title bar, the browser panel's five failures, the stop-flow's error spam, the missing live write preview, the post-task session regurgitation, the thinking block's "AI glow," the context popover's instant hover, the Models & Providers presentation, the Sub-agents/Advanced duplication, the hidden keys, and the need for a **terminal testing harness** so long sessions can be driven without the UI.

## The round's shape

For the first time the engine needed no structural work — R57's fix held —
so this was six parallel workstreams over one tree, each with strict file
ownership (two agents editing the same file is how rounds lose hours):

| ID | Workstream | Files owned |
|---|---|---|
| R58-orch | Tauri config + engine backend (this doc's author) | tauri.conf.json, capabilities/, agent-core/src/agents/{chat,runtime}.ts |
| R58-a | Frameless window + custom TitleBar | src/App.tsx, shell/AppShell/Sidebar/ConnectionGate/SetupWizard, new TitleBar.tsx |
| R58-b | Browser panel's five bugs | src-tauri/src/{browser,lib}.rs, right-sidebar/BrowserPanel, lib/native-browser |
| R58-c/cf | Stop honesty + live write preview + thinking redesign + hover intent | engine runtime + stream-store/api/WorkingSection/Composer/ContextDonut |
| R58-d | Settings restructure + visible keys + picker honoring config | settings/**, SettingsPage, ModelSelector, key-pool, server.ts keys region |
| R58-e | The CLI chat harness | scripts/acute.mjs, docs/runbooks/CLI-HARNESS.md |

## 1. The frameless window (R58-a)

`tauri.conf.json` gains `"decorations": false, "center": true`; the
capability set gains the four window-control permissions
(`core:window:allow-start-dragging/minimize/toggle-maximize/close` —
verified against the shipped ACL manifest before writing). The new
`src/components/shell/TitleBar.tsx` is a 40px VS Code-style bar:

- renders **null outside Tauri** (`isTauri()` — web mode byte-identical);
- drag + double-click-maximize via `data-tauri-drag-region` (repeated on
  every non-interactive child — the attribute only fires on the mousedown
  target);
- min/max-restore/close through `window.__TAURI__.window.getCurrentWindow()`
  (the repo's no-npm-`@tauri-apps/api` convention — `withGlobalTauri`
  injects the whole API);
- maximize state tracked via `isMaximized()` + `tauri://resize`;
- App.tsx wraps the tree in an `h-screen flex-col` with the TitleBar above
  ConnectionGate so the wizard, splash, and offline screens are covered;
  AppShell/ConnectionGate/SetupWizard `h-screen` → `h-full`; the floating
  sidebar toggle and mobile logo drop 32px in Tauri mode only.

8 tests; the suite grew 1074 → 1082 with zero regressions.

## 2. The browser panel's five bugs (R58-b)

1. **The white pop-out window** — `open_browser_window` was a SYNC Tauri
   command calling `WebviewWindowBuilder::build()`, which blocks on a
   channel to the main thread — the same deadlock `browser_tab_create`'s
   own doc comment documents (that command was made async for exactly
   this). The pop-out now mirrors it. The injected nav overlay moved from
   lost `eval` calls to `.initialization_script(NAV_OVERLAY_INIT)` (runs
   in every document at document-start; the overlay script gained a
   readyState guard).
2. **"Open in system browser" swallowed** — `window.open(_blank)` inside
   a wry webview never reaches the OS. New Rust command
   `open_external_url` uses the already-registered shell plugin's
   `ShellExt::open` (Rust-side calls bypass the JS ACL wall; http/https
   validated first). No new capability entries needed.
3. **URL draft stomped mid-typing** — the draft-sync effect now skips
   while the input holds focus.
4. **Dishonest viewport readout** — clamped presets now say so
   (`843×590 (clamped from 1920×1080 — panel too small)`).
5. **The "isolated profile" tooltip lied** — pop-out and tabs have always
   shared `browser_profile_dir()`; the copy now says shared.

No cargo on the sandbox: the agent installed rustc via rustup, built a
signature-faithful stub-crate harness from the REAL tauri 2.11.5 +
tauri-plugin-shell 2.3.5 sources, and `cargo check`ed the verbatim files —
0 errors. (Caught that the brief's `None::<&str>` would not compile — the
real signature is `Option<open::Program>`.) CI's cargo check is the
authoritative gate.

## 3. Stop honesty (engine R58-c + frontend R58-cf)

The owner: *"it should not show me the 'generation failed' error, 'body
stream buffer was aborted'… It should properly show me a dedicated message
that it stopped by the user."*

Server-side (`agent-core/src/agents/runtime.ts`), the ABORTED return paths
now: **flush the in-flight partial segment** (the streamed text no longer
vanishes from the transcript — this is also what makes Continue work),
record the usage of completed iterations, touch, and **reset the session
to `queued`** — the row stayed "running" until the next boot before, which
is exactly the eternal sidebar spinner. The outcome message says
"stopped by user."

Client-side (`stream-store.ts`): `abortStream` is now a deliberate stop —
it flags the session immediately, fires `POST /sessions/:id/stop`, and a
2500ms grace timer hard-aborts the local fetch only if the stream is still
open. The catch classifies deliberate stops (no `liveError`, no
"Generation failed" card — a quiet **TurnStoppedCard** renders instead),
and `streamSessionMessage` no longer synthesizes `STREAM_DISCONNECTED`
for abort exceptions. Race hardening: a terminal `done`/`error` that
beats the stop click retracts the armed stop.

**Continue**: the composer grows a Continue button (appears after a
user-stopped turn) that sends `Continue from where you left off.` — the
persisted partial + tool results give the model its place back.

## 4. Live file-write preview (engine R58-c + frontend R58-cf)

The owner: *"while it was writing the files I was not being shown the live
preview… After it had written the whole file then it showed me."*

The AI SDK v7 fullStream has `tool-input-start` / `tool-input-delta` parts
(the model's JSON args streaming BEFORE the call is complete) — chat.ts
never forwarded them. Now: chat.ts normalizes them (`{id,toolName}` /
  `{id,delta}` part shapes — the UI-message types at the top of the .d.ts
use DIFFERENT field names; TypeScript caught the first attempt), the
runtime forwards them on SSE (and flushes the text segment at
input-start, so the event log's text→tool boundary matches the live
UI's), the store accumulates them per toolCallId, and WorkingSection
renders a live `writing <file> — N chars` preview using a tolerant
incremental JSON-string extractor (`streaming-args.ts` — decodes the
`"content"` value while the JSON is still being written).

Live-verified end-to-end (battery S58-2): the owner's exact 3-file task
streams 40+ arg deltas during generation; input-start precedes tool-call.

## 5. The session regurgitation cap (engine R58-c)

The owner: *"after completing the task it started to hallucinate… it
copied and pasted the whole session."*

`assembleHistory` replayed EVERY tool's full output (≤4 000 chars each) as
user-role `<tool_results>` blocks on EVERY outer-loop iteration — tens of
KB of stale output the model was invited to echo. Now the last 8 tool
results keep full fidelity, older ones collapse to 200-char stubs, blocks
are bounded at 48k (stubbing oldest-first), and `COMPLETION_SIGNAL` grew
the phrasings real summaries use ("Task completed.", "The task is
complete.") — the owner's 3-file task ended with a summary matching NONE
of the old signals, forcing one more full-history call that produced the
regurgitation.

## 6. Thinking redesign + hover intent (R58-cf)

The owner rejected the "AI-style" left-side highlight on thought blocks:
`border-l-2` accent rails removed from ThoughtRow's body AND the
working-section spine (and SubAgentPanel's shared row) — replaced by a
self-contained notes block (subtle 4% wash, rounded, mono 11px). The
ContextDonut popover opens after ~600ms of pointer rest (focus/click stay
instant; the 220ms close bridge unchanged).

## 7. Settings restructure (R58-d)

- **Models & Providers**: keyless seeded presets collapse into a
  "Not configured (3)" group; the provider list is content-sized
  (220px min); preset providers hide base-URL + API-format ("Preset
  provider — endpoint and format are fixed"); disable is a
  `role=switch` toggle with an agent-impact confirm; the OpenRouter
  catalog no longer merges into custom providers; reveal eyes on the
  primary key and every pool slot (fetched on click, never on mount,
  copy buttons, honest no-key states).
- **Key reveal route** (`POST /providers/:id/keys/reveal`): returns the
  real values — the owner's explicit demand, consciously reversing R47's
  no-keys-in-responses invariant for this single authenticated route
  (documented in the route comment; keys still never logged).
- **Sub-agents** is now the single home: keys, model, parallelism (moved
  from Advanced), supervision. **Advanced** keeps connection + memory.
  The old double-render of the entire SubAgentsSection is gone. Deep
  links stable; both tab registries unchanged.
- **ModelSelector** merges models-config: hidden models excluded even
  under "All", displayNames replace raw ids, configured models marked.

## 8. The CLI chat harness (R58-e)

`scripts/acute.mjs` (122 → 730 lines, legacy commands untouched):
`chat:new`, `chat:sessions`, `chat` (sync), **`chat:stream`** (live SSE —
text to stdout, collapsed thinking status, tool lines with live
`tool-output` chunks, approval banners, `--auto-approve`, `--raw` JSONL,
`--quiet`), `chat:stop`, `chat:events`, `chat:ctx`, `approvals/approve/
deny`. **SIGINT during chat:stream POSTs /stop and waits for the
stopped/done frame** — the harness itself is the stop-path test.
Live-verified against a dedicated sidecar with real free-model calls
(including a tools turn that wrote a file and an approvals round-trip).
Documented in `docs/runbooks/CLI-HARNESS.md` — long sessions can now be
driven entirely from the terminal.

## 9. The live battery (this round's proof)

`scripts/battery-r58.mjs` (permanent artifact, R51 battery pattern — the
sandbox reaps background processes, so the battery supervises its own
sidecar):

| Check | Result |
|---|---|
| S58-1 dedicated sidecar boots on 5199 | PASS |
| S58-2 the owner's exact 3-file task, streamed — 4-5 tool calls, files on disk, 40-83 `tool-input-delta` frames, input-start precedes tool-call | PASS |
| S58-3 stop mid-generation — `stopped` frame, status `queued`, partial (418 chars) persisted | PASS |
| S58-4 "Continue from where you left off." completes | PASS |
| S58-5 reveal route returns the real key | PASS |

Two battery-script bugs were caught and fixed by the battery itself
(projectless sessions have no tools; Fastify 400s a content-type with no
body) — the script is now the reference for both gotchas.

## 10. Gates

- Root suite: **1169/1169 in 80 files** (was 1074/77).
- agent-core: **631/631 in 38 files** (was 620+8 new).
- lint CLEAN · typecheck CLEAN (root + agent-core) · docs:check 149/0 ·
  version:check 0.58.0 ×4.
- Browser verification: settings pages + wizard + dashboard live-checked
  via agent-browser (structures + zero console errors); TitleBar
  web-mode absence + Tauri-mode stub verified by its agent; the Rust
  changes stub-crate `cargo check`ed + CI cargo check on push.
- The dev stack was reaped by the sandbox between invocations — every
  live check runs inside ONE command (the battery pattern); the R58
  notes carry the workaround.

## What's next

- **The owner's Windows re-test** of v0.58.0 (title bar, browser pop-out,
  stop/continue, live write preview, settings).
- The prompt-section registry (modular prompt overrides per section —
  the `.acuterules`/`.acute/rules/` extension point grows into a real
  registry; the deepseek-harness modularity reference the owner cited).
- Long-session CLI soak (the harness exists now — run a 50+ turn session
  through it and watch the compaction/capping behavior).
- R50 leftovers: usage screen section 2, plugin tool system polish.
