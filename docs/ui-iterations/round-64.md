<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 64 — The capability round: computer use actually sees the desktop + the always-on-top STOP bar + the chat/polish backlog

**Date:** 2026-09-02 · **Branch:** `main` · **Version:** 0.64.0 · **Owner directive (verbatim intent):** "the computer use skill was not functioning as it was supposed to be. It was supposed to grant the agent full access to my computer, like it could see what is on my screen currently, interact with it, click buttons… know the buttons which are present… [the floating window] needs to be very minimal. It needs to be clean. It needs to be beautiful. It will be shown at the top of each and every single one of the screens… The floating one will automatically show up as soon as the agent starts to use the computer skill… There is actually no need to show the computer use in the right sidebar menu at all."

The owner live-tested 0.63.0 on Windows (the desktop update flow **verified working** — "It updated the application exactly as it was supposed to") and filed the first REAL computer-use bug report with tool output: `list_apps → []`, `get_app_state("Notepad") → app_not_found`, `list_displays → []`, screenshot working at 1280×1024.

| ID | Workstream | Files owned |
|---|---|---|
| R64-a | Windows backend: JSON array collapse, EnumWindows enumeration, tiered app resolution + runningApps payload, skill rewrite, empty-result diagnostics | `agent-core/src/computer/**`, `storage/skills.ts`, `tools/plugins/computer-use.ts` |
| R64-b | The always-on-top floating monitor (OS window + web pill) + right-sidebar Computer tab removal | `src-tauri/src/mini.rs`, `mini.html`, `src/mini/**`, `ComputerMiniWindow.tsx`, right-sidebar store/panel |
| R64-c | Chat UX: ChatMarkdown, always-visible intermediate text, context popover portal+live, 1.5s toasts, delegated-row claim matching | `AgentChatPanel.tsx`, `ChatMarkdown.tsx`, `WorkingSection.tsx`, `ContextDonut.tsx`, `Toaster.tsx` |
| R64-d | Model picker config-only + live permission-mode re-read + the safe-command expansion | `ModelSelector.tsx`, `approvals.ts`, `tools/approval-deps.ts` |
| R64-e | Per-API-key usage (migration 0024) + the GPT-style token estimator | `usage.ts`, `migrations/0024`, `runtime.ts`, `orchestrator.ts`, `context.ts`, `KeyCards.tsx` |

## 1. Why the owner's Windows run saw nothing (the three real bugs)

The engine's PowerShell capsules ran fine (screenshot worked). Three bugs
stacked to produce "the bridge can't enumerate your running apps":

1. **`ConvertTo-Json` pipeline array collapse.** `OutJson` piped arrays into
   `ConvertTo-Json`. PowerShell 5.1's pipeline UNWRAPS arrays: **0 elements
   emit NOTHING; 1 element emits a bare OBJECT**; only 2+ emit an array. The
   JS side then either parsed `""` (→ `[]`) or threw on `.map` (→ catch →
   silently `[]`). Every list-shaped probe (apps/windows/displays) died
   here whenever the count was 0 or 1 — which on a single-monitor machine
   with a folded window list is exactly the common case. Fix: a shape-aware
   `OutJson` — list-typed values ride `ConvertTo-Json -InputObject @($arr)`
   (parameter binding preserves the wrapper), 0 short-circuits to a literal
   `'[]'`, hashtables ride `-InputObject` positionally (unchanged shapes).
2. **Get-Process-only enumeration.** `list_apps` read
   `Get-Process`'s CACHED `MainWindowTitle` — one window per process,
   fragile and stale. Now: a real **EnumWindows** walk (a C#-5-safe
   collector compiled into the same single `Add-Type` — visible + titled +
   non-toolwindow + non-zero-size filtering), one app per pid with `name`
   = the largest titled window AND **`processName` = the executable name**;
   `list_windows` returns ALL of a pid's top-level windows (main + focused
   flags honest); a Get-Process fallback survives EnumWindows failure.
3. **Exact-title app resolution.** `resolveAppRef` matched the window TITLE
   exactly — `"Notepad"` never matches `"Untitled - Notepad"` →
   `app_not_found` even with perfect enumeration. Now a 5-tier matcher:
   pid → exact title → exact processName → unique substring (title or
   processName) → refusal, and the **`app_not_found` payload carries
   `runningApps`** (≤25 `{name, processName, pid}`) so the model
   self-corrects in ONE step; ambiguity lists the candidates.

Plus: `list_displays` had the same collapse (single-monitor machines
returned the FAKE 1920×1080 fallback — why the screenshot said 1280×1024
while displays said otherwise; the fake fallback is REMOVED — failures are
honest `[]` + diagnostics); every enumeration result now carries
**diagnostics** (`processCount`, `foregroundPid`, `enumWindowsCount`, …)
only when a list is empty, so any residual failure is debuggable from the
transcript; and the **built-in skill body was rewritten** around the
visionless UIA-first workflow (list_apps → processName/pid resolution →
get_app_state → element actions → verify after writes; the runningApps
recovery loop; the 0.5–1s post-launch wait; the frontmost rule; the
agent MAY act on its own window when needed; stop at task end).

> Honesty: PowerShell never runs in this Linux sandbox. All of this is
> verified by construction + script-text-pinning tests (24 new). The
> owner's next live Windows session is the real verification — and the new
> diagnostics keys exist precisely so any residual failure is READABLE.

## 2. The floating monitor — an OS window, always on top, everywhere

The owner's STOP button must be reachable **while the agent drives other
apps fullscreen**. That is not an in-app card:

- **Desktop:** `open_computer_mini` / `close_computer_mini`
  (`src-tauri/src/mini.rs`, mirroring the pop-out's async
  WebviewWindowBuilder pattern — the documented WebView2 sync-deadlock
  workaround) build a 360×96 frameless window: `always_on_top`,
  `skip_taskbar`, `shadow`, `focused(false)` (never steals focus while the
  owner types), parked top-right of the monitor the MAIN window is on.
- **The page** (`mini.html` — a THIRD vite entry — hosting `src/mini/**`,
  a standalone bundle that never imports the app's `api.ts`): the minimal
  bar — pulsing dot + "Agent is using your computer" + elapsed + the latest
  activity + the STOP kill switch; `data-tauri-drag-region` header; its own
  1s poll of `GET /computer-use/session` (bearer via `sidecar_info`); it
  **closes itself** once the session ends (kill switch/stop ≈6s grace,
  inactivity ≈8s).
- **Auto show/hide:** the main app's `ComputerMiniWindow` is now a
  CONTROLLER — the monitor store's `liveActivity` edge (the first live SSE
  computer-use frame) invokes `open_computer_mini` once per burst;
  `session_stop` schedules the close backstop. Nothing renders in-app on
  desktop (no double surface). **Web mode** gets the same minimal bar as an
  in-app pill (top-center, auto-shown/hidden).
- **The right-sidebar "Computer" tab is REMOVED** (owner: "There is
  actually no need to show it there at all") — the store even migrates
  persisted `computer` tabs away (v3→v4). `ComputerPanel.tsx` deleted.

## 3. The chat polish backlog

- **Full markdown** (`ChatMarkdown.tsx`, dependency-free): headings, lists
  (one nesting level), tables (GFM separators + alignment + mono numeric
  cells), quotes, rules, bold/**italic**/strike/links, inline code — and
  the ROUND-40 path pills + CodeBlock moved in verbatim. Applied to final
  answers, **intermediate text**, and the **live streaming answer** (an
  unterminated fence renders as a code block; dangling marks degrade to
  plain text).
- **Intermediate text is never hidden**: `AssistantTurn` segments the
  working entries — text renders as always-visible markdown blocks BETWEEN
  the collapsible tool sections (the owner's "after thinking it showed me
  the bottom response only" — the earlier part was folded away).
- **The context-window popover**: a `document.body` PORTAL, position:fixed,
  MEASURED from the donut (left-clamped, maxHeight = the real space above,
  internal scroll) — no more viewport clipping; refined border/shadow; and
  it updates LIVE (the turn's working-entry count joined the queryKey +
  2.5s refetch while streaming).
- **Internal notifications dismiss at 1.5s** (permission requests and
  failures stay persistent — they need a decision).
- **One sub-agent per Delegated row**: `assignDelegateChildren` —
  completed rows claim their parsed child id; pending rows (in timeline
  order) claim the earliest-created unclaimed live child; expanding a row
  shows EXACTLY its own child.

## 4. Pickers, permissions, keys, tokens

- **Model picker = config-only**: the hover flyout lists exactly the
  provider's models-config rows (hidden excluded, display names applied);
  the live catalog no longer leaks models the owner never added. Empty →
  "No models configured — add them in Settings".
- **Permission changes apply to the NEXT command**: the approval deps'
  `permissionMode` is a live GETTER (re-reads the session row per gate) —
  a mid-turn ask→full flip auto-approves the very next ask-tier gate;
  nothing bypasses allowlists (pinned by tests).
- **Safe commands never ask**: the auto list grew the provably read-only
  Windows/PowerShell reads (`Get-Content`, `Get-ChildItem`, `Get-Item`,
  `Get-Process`, `Get-Service`, `Get-Date`, `Get-Command`, `Select-String`,
  `findstr`, `tasklist`, `systeminfo`, `ver`) + search tools (`rg` —
  word-boundary fix, `fd`, `ag`, `ack`, `command -v`, `whereis`, `file`,
  `stat`, `du`, `df`, `tree`, `more`, `fc`, `md5sum`, `sha256sum`, `uname`,
  `whoami`) + read-only git (`git grep`, `git remote -v`, `git ls-files`,
  `git stash list`, `git describe`, `git rev-parse`, `git shortlog`,
  `git blame`); whitespace-normalized matching; fd exec-style flags demote
  to ask; compounds NEVER auto-run.
- **Per-API-key usage**: migration 0024 (`usage_events.key_slot`, 0 =
  primary — the DEFAULT is the truthful reading of history; children carry
  the pool slot the orchestrator acquired via `TurnDeps.keySlot`);
  `/usage/detailed` gained the `keys` aggregate; the Usage screen's "API
  keys" section renders one card per key (provider, Primary/Pool slot N,
  masked preview, requests, tokens ↑↓, cost, last-used, share bar;
  configured-but-unused keys AND removed keys render honestly).
- **The token estimator** (`context.ts`): a GPT-style BPE approximation —
  unicode pre-tokenization (CJK singles, letter runs with underscore
  joins, ≤3-digit groups, whitespace runs, symbol codepoints) + calibrated
  per-segment costs (CJK 1/char, letters L/4.5+0.1, digits 1/group, common
  ASCII punct 0.5 with a word-prefix refund, wide punct 1, other symbols
  1.5, single leading spaces free). Kills the chars/4 extremes (CJK
  undercounted 4-8×, digits ~60%). Calibrated against documented cl100k
  ratios (±15%) — tiktoken is not available in the sandbox; the method is
  documented in the file.

## 5. Verification

- Root `pnpm test`: **1664/1664 in 109 files** (baseline 1542/104; +122:
  computer backend 42+24…, ChatMarkdown 23, mini window + controller +
  sidebar-removal ~35, delegated claim matching, config-only picker, live
  permission getter 5, safe commands +8, keys + estimator + usage).
- agent-core: **885/885 in 52 files** (baseline 801/50).
- `pnpm lint` + `tsc --noEmit` CLEAN on both workspaces; `docs:check`
  green; version:check 0.64.0 ×4.
- **Live battery** (dev stack, agent-browser): the app boots with ZERO
  console/page errors — onboarding → dashboard → usage → a fresh session
  chat (composer: permission mode, context donut, model selector, thinking
  level; the right sidebar's quick-menu has NO Computer entry) — and
  `mini.html` renders its honest web-mode notice.

## 6. What this round does NOT claim

- The Windows backend fixes (EnumWindows, ConvertTo-Json shapes, the
  resolver tiers) are **code-complete + construction-tested only** — the
  owner's next live Windows session is the verification; the empty-result
  diagnostics make any residual failure readable from the transcript.
- The always-on-top window's OS behavior (above fullscreen apps,
  skip_taskbar, the drag region) needs the owner's desktop run; CI
  compiles the Rust.
- The estimator is a heuristic, honestly calibrated — not tiktoken.
