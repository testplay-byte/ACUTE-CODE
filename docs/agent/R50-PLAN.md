<!-- last-reviewed: 2026-09-19 round-108 -->
# ROUND-50 PLAN — the owner's third Windows test round

Owner feedback (2026-08-30, verbatim goals extracted):

1. **Logo: APPROVED** — "exactly the kind of icon I was hoping for… for temporary use it is perfect." → DO NOT TOUCH.
2. **Browser**: still broken on some sites (ticket-expired error page shipped). Owner wants a
   **proper full-fledged browser of our own, Chromium as the base** — not the fetch-proxy iframe.
3. **Sub-agent**: works, calls tools properly now (R49 tool repair CONFIRMED by owner), but:
   - live view shows no RAW text/thinking streaming (must stream live like the main agent);
   - a rate-limit failure "failed after three attempts" → owner wants **at least five attempts**;
   - live-view stats footer: total time, tokens sent, tokens received, tokens/sec, model.
4. **Main chat composer rework** (detailed spec, see R50-c1/c2):
   - empty state: composer centered, slightly below middle;
   - composer box with its own background; toolbar INSIDE the box;
   - bottom-left: Add Context (Windows file picker, @ project files, drag-and-drop, attachments);
   - next: permission mode switcher (Full Access / Ask / Plan / Editor);
   - bottom-right: Send · thinking level (Default/Low/High/Max) · model selector
     (provider name + full model name; popover: providers at top w/ hover model flyouts,
     Manage Models at bottom → /settings?tab=api) · context donut
     (used/total + breakdown: messages, MCP tools, system tools, system prompt, skills, meta;
     cache hit rate; session cost + token totals);
   - memory master switch: owner found it, tested OFF — keep as-is.
5. **Models & Providers page**: left/right scroll INDEPENDENTLY; right pane UI polish;
   advanced model config — pick models from catalog, set input/output/cache prices etc.
6. Docs kept proper; quality over speed; English.

## Task graph (sequential waves where files overlap)

| ID  | Scope | Key files |
| --- | --- | --- |
| R50-a  | Native embedded browser (Tauri child webviews = WebView2/Chromium inside the main window; iframe proxy stays as non-Tauri fallback) | src-tauri/src/browser.rs, lib.rs, Cargo.toml, BrowserPanel.tsx, new src/lib/native-browser.ts |
| R50-d  | Models & Providers page (independent scroll, polish, catalog picker, per-model pricing editor) | ModelsProvidersTab.tsx, api.ts, server.ts (model routes, additive only) |
| R50-b  | Sub-agent live streaming + retries + stats footer | chat.ts, orchestrator.ts, runtime.ts (toolDeps chatStream), tools/index.ts, stream-store.ts, SubAgentPanel.tsx, sessions.ts, api.ts |
| R50-c1 | Composer BACKEND (modes, thinking, attachments, context report, cached tokens) | migrations/0020, sessions.ts, server.ts, runtime.ts, chat.ts, prompts.ts, context.ts, dialogs.rs, api.ts |
| R50-c2 | Composer FRONTEND (spec-exact UI) | AgentChatPanel.tsx, new Composer/, api.ts |

Waves: **a ∥ d** (disjoint files) → **b** → **c1** → **c2** → integration + docs + CI (orchestrator).

## Verified technical facts (do not re-litigate)

- tauri 2.11.5 source fetched to /tmp/tauri_webview_mod.rs + /tmp/tauri_window_mod.rs:
  - `Window::add_child(builder, position, size)` EXISTS (window/mod.rs:1129) but is gated
    `#[cfg(any(test, all(desktop, feature = "unstable")))]` → **Cargo.toml needs tauri
    features = ["unstable"]**.
  - `WebviewBuilder::data_directory` (webview/mod.rs:963), `on_navigation` (:528) exist.
  - `Webview::{set_position, set_size, hide, show, set_focus, eval, url, navigate, close}` all exist.
  - Events: `tauri::Emitter::emit` on AppHandle; frontend `window.__TAURI__.event.listen`
    (withGlobalTauri already on).
- "failed after three attempts" = the AI SDK default `maxRetries: 2` (3 total) — chat.ts
  must pass `maxRetries: 4` in BOTH generateText and streamText.
- Sub-agents run the SYNC path (`runSingleAgentTurn` → generateText + onStepFinish snapshots)
  → no live deltas. Fix: children run `runStreamedAgentTurn` (chatStream must be plumbed into
  toolDeps for delegate_task).
- Models table ALREADY has pricing columns (input/output/cached per Mtok, context window,
  maxOutputTokens, supportsThinking, hidden) — R50-d mostly UI + route field pass-through.
- Settings tab id for Models & Providers = `api` → Manage Models deep-link `/settings?tab=api`.
- sessions table has NO permission_mode column yet → migration 0020 (+ usage_events cached
  tokens column, same migration).
- Main window label = "main" (tauri.conf.json default).

## Golden rules (standing)

- Every agent: read `/home/z/my-project/worklog.md` BEFORE working, APPEND its section after.
- Gates before any commit: `pnpm lint` + `pnpm typecheck` + `pnpm test` all green.
- No version bumps / CHANGELOG / commits by subagents — orchestrator does docs centrally.
- Secrets never in code, tests, logs, or model output. credentials.txt is read-only.
- After push: poll the GitHub Actions API until real SUCCESS; never claim CI green from hope.
- Completion: ntfy.sh → topic **TASKISDONE**.
