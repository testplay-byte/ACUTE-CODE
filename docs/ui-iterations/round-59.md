<!-- last-reviewed: 2026-09-11 round-87 -->
# Round 59 — The owner-feedback round: window polish, settings honesty, the feedback loop, and modular prompts

**Date:** 2026-09-01 · **Branch:** `main` · **Version:** 0.59.0 · **Owner directives:** the twelfth Windows test session (0.58.0) — the frameless title bar, the pop-out browser, the live file-write preview, the key pool, and the streaming stops all WORKED (*"There is now our own custom top navigation bar, which is perfect… I am quite happy with it"*) — followed by the polish list: rounded+inset title bar, custom chrome in the pop-out, minimal scrollbars, honest provider list, the API-key reveal, outright disable, pre-selection, **the response-rating loop with full context capture** (*"I think we should most definitely add this"*), console-like error monitoring, and the modular system prompts (*"built in multiple parts, modules, and such… everything is a module, everything is a plug-in"*).

## The round's shape

Sandbox restore #5 (fifth re-provision; baseline re-verified 1169/1169) then
six workstreams with strict file ownership:

| ID | Workstream | Files owned |
|---|---|---|
| R59-A (orch) | Rounded window frame + pill scrollbars | App.tsx, TitleBar.tsx, index.css |
| R59-B | Pop-out browser custom chrome | src-tauri/src/{browser,lib}.rs, vite.config.ts, popout.html, src/popout/* |
| R59-C | Models & Providers honesty | settings/ModelsProvidersTab.tsx + test |
| R59-D | Response rating (the feedback loop) | storage/ratings* + 0022, server.ts routes, api.ts, AgentChatPanel, stream-store, acute.mjs |
| R59-E | Diagnostics console | error-bus, ErrorBoundary, server ring, ConsolePanel, main.tsx, RightSidebar |
| R59-F | Prompt-section registry | agents/prompt-registry.ts, prompts.ts, acute.mjs, PROMPT-MODULES.md |

Suite: **1169 → 1302 tests in 88 files** (+133), lint/typecheck/docs:check clean.

## 1. The rounded window (R59-A — the owner: "make that top navigation bar rounded and give it padding on all four sides")

The app root in Tauri mode is now an inset FRAME: `p-2 gap-2` on the ambient
`--ac-frame-bg` (a text-tinted color-mix of the theme bg — reads darker in
light mode, lifted in dark; no new theme-table key), with the TitleBar and the
content area as separate rounded cards (`rounded-[14px]`, hairline border).
The TitleBar's window controls became inset rounded buttons (`rounded-[9px]`
h-8) so hover fills never break the corner radii; the old full-height VS Code
slabs are gone. Web mode keeps the pre-R58 full-bleed column byte-for-byte
(TitleBar renders null). 9 TitleBar tests incl. the new rounded-card contract.

## 2. The pill scrollbar (R59-A — "go with a better scroll bar… minimal and good-looking")

App-wide floating-pill language: a 10px gutter with a fully transparent
track/corner, and a rounded thumb inset by 3px transparent border
(`background-clip: padding-box`) tinted toward the text color (18%, 34% on
hover) — visible on every theme/mode, vertical AND horizontal (the owner
called out both). The `.auto-scroll` scroll-fade gutter joins the same
recipe. Firefox `scrollbar-color` mirrors the mix.

## 3. The pop-out browser window gets OUR chrome (R59-B — "It should be a custom one but apparently it was not")

The pop-out is no longer an external-URL window with a native bar + an
injected nav overlay. It is now a **decorationless window hosting a second
vite entry** (`popout.html` — a 10 KB standalone React bundle vs the 842 KB
main): the popout page paints the drag-region title bar (min/max-restore/
close via `getCurrentWindow`, maximize-swap on `tauri://resize`), the themed
URL bar (back/forward/reload, focus-guarded editable input with Escape-reset,
Go, "open in system browser" handoff), and hosts the page content in a
**child webview attached to the pop-out window** — `browser_tab_create`'s new
optional `window_label` (JS-missing-key → None → main window: every existing
call site unchanged). Same child-webview architecture as the in-app panel,
the ONE shared browser profile, the same `browser-navigated` sync. Sizing:
`clamp_popout_size` (pure, 5 unit tests) = min(1200×800, 70% of the primary
monitor's work area) floored at 640×480. The initial URL travels via a
Rust-side stash + `popout_initial_url` command; the `popout-navigate` event
closes the window-exists-but-page-still-mounting race; a page reload ADOPTS
the surviving content webview. NAV_OVERLAY_INIT is deleted (grep-verified no
other users). 21 new popout tests; BrowserPanel untouched (0 breakages).
Rust verified against the real tauri 2.11.5 source (no Rust toolchain in the
sandbox — CI's cargo check is the backstop, as every round).

## 4. Models & Providers honesty (R59-C)

- **Unconfigured presets are GONE from the list entirely** (owner deleted
  them by hand in 0.58.0): the R58 "Not configured" collapsed group is
  removed — the list shows only configured providers (hasKey or
  user-created). The Add-provider preset picker remains the setup path.
- **The API key field presents the STORED key** masked (slot-0 mask from the
  key-pool listing) with ONE "Show" (revealProviderKeys → full read-only
  value + Copy + Hide) and a separate "Rotate key" text button for the
  editable flow — the R58 dual-eye-on-an-empty-input ambiguity is dead.
- **Disable is outright**: the `confirmDisable` gate and its warning box are
  removed; the switch fires the PATCH immediately (the agent count survives
  only as a hover tooltip).
- **Pre-select**: opening the tab selects the FIRST configured provider and
  renders its details; deleting the selected provider falls to the next; an
  empty list keeps the placeholder card.
- Tests 29 → 40 (net +11, including the preset-absence and no-confirm
  contracts).

## 5. The response-rating loop (R59-D — "I think we should most definitely add this")

Every assistant reply carries thumbs up/down. Identity:
`(session_id, last non-empty message.assistant seq)` — wired into the
persisted turn model (`AssistantTurnItem.lastAssistantSeq`) and the live
stream items. Migration `0022_message_ratings.sql` (UNIQUE upsert key +
audit row; no FK per the sessions convention). `storage/ratings.ts` builds
the **immutable full-context snapshot at rate time**: user message, assistant
reply (content + usage + ms), tool events (≤50, 500-char summaries), any
`turn.error`, session title, agent name, model, event count — 8000-char field
caps with honest `truncated` flags (a later revert/fork can't alter the
evidence). Routes: `POST/GET /sessions/:id/ratings`, `GET /ratings?…`
(with context — the analysis path), `DELETE /ratings/:id`. Chat UI: ghost
thumb buttons with optimistic fill, same-thumb-click clears, a note input
appears on bad ratings ("What went wrong?" — the owner's context), error
reverts. CLI: `ratings [--session/--rating/--limit/--full]` + `ratings:rm`
— `--full` dumps the complete evidence JSON for dev-agent analysis.
**Live-verified on a real OpenRouter turn**: rate good → re-rate bad with a
note (upsert kept id + created_at), the `--full` dump carries the whole
turn. 26 storage/route tests + 15 chat tests + api client tests.

## 6. The diagnostics console (R59-E — "proper console-like error monitoring")

A right-sidebar **Console** tab (Activity icon, QuickMenu "Console / Error
monitoring") showing every error the app knows about, newest-first, 5s
polling: `src/lib/error-bus.ts` (pure ring store, 200 entries, 5s
same-error dedupe with ×count badges, scrubbed of Bearer/sk- material) fed
by a new `ErrorBoundary` (render errors + honest fallback card + Retry),
`window.onerror` / `unhandledrejection` handlers, and a TanStack
`QueryCache.onError` — merged with the sidecar's fastify error ring
(`GET/DELETE /diagnostics/errors`, bearer-walled, ≥500 + thrown errors
only: 4xx client mistakes are not engine errors; no bodies/auth captured).
Copy-all/Clear-all/Refresh; expandable `<pre>` detail with componentStack.
34 tests; live-verified in agent-browser (a dispatched ErrorEvent appeared
instantly; 3 rapid identical events → one ×3 row; Clear-all empties both).

## 7. The prompt-section registry (R59-F — "built in multiple parts, modules… used when necessary")

`agent-core/src/agents/prompt-registry.ts` enumerates the **20 real
sections** of the composed system prompt (identity, tool-use,
permission-mode, sub-agents, agentic-loop, efficiency, file-editing,
code-navigation, terminal, task-planning, todo-tracking, web-access,
browser-panel, communication, codebase-awareness, project-memory,
environment, custom-rules, git, tool-results-are-data — dynamic flags
documented per section). **`.acute/prompts/<section-id>.md` overrides a
section wholesale** (dynamic parts included — the owner's explicit intent);
an empty file REMOVES the section; `_order.txt` reorders (only when ≥1
override exists); unknown filenames ignored + diagnosed; 8000-char cap.
No overrides → the composition is **byte-identical to pre-R59-F** (pinned by
a 13.6 KB golden fixture). The context meter composes through the same hook
so it measures the EFFECTIVE prompt. CLI: `prompt:sections` (registry +
which files would override) and `prompt:show <id>` (override or built-in).
Runbook: `docs/runbooks/PROMPT-MODULES.md`. 28 tests. **Live-verified**: a
project with `.acute/prompts/efficiency.md` → a real streamed turn quoted
the override-only heading verbatim (7195 in / 219 out) — the override
reached the live system prompt end-to-end.

## Verification

- `pnpm lint` · `pnpm typecheck` (root + agent-core) · `pnpm docs:check`
  (151 docs, 0/0) — all clean.
- **`pnpm test`: 1302/1302 in 88 files** (was 1169/80 at R58; +133 across
  the six workstreams, zero regressions).
- Live batteries on the dev stack with the owner's real OpenRouter key:
  the rating loop end-to-end (chat:stream → rate → re-rate with note →
  `ratings --full` dump), the prompt override reaching a real streamed
  turn, the diagnostics routes (401/400/404 exclusion proofs + agent-browser
  console rendering), `curl` of `/popout.html` (200) + the web-mode fallback.
- Rust (browser.rs popout rework) verified against the tauri 2.11.5 source
  in-sandbox; CI cargo check is the compile backstop as every round.

## Known limitations / next

- The pop-out's live Windows behavior (drag, sizing on the owner's monitor,
  the child webview inside the pop-out) is the owner's re-test — the
  sandbox has no Tauri shell; web-mode + prod build were verified here.
- Ratings are per-session (sub-agent child turns rate through their own
  session if opened); the analysis path is the CLI dump — a Settings
  "Feedback" browser is future work.
- The console ring captures fastify-thrown errors (≥500); route-handled
  502 provider envelopes intentionally stay out.
- Future (owner's stated direction): multi-agent request formatter, agent
  web-app-testing tools, plugin tool system expansion.
