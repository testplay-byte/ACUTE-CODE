<!-- last-reviewed: 2026-09-10 round-83 -->
# Round 43 — The owner's verdict round: embedded proxy browser INSIDE the app · free-model catalog + fallback chain · failed turns get loud · chat geometry · sub-agent provider settings · CI green again

**Date:** 2026-08-26 · **Branch:** `main` · **Owner directives:** the round-42
verdict message (9-item). **Good:** launcher auto-open browser, notification
menu clamp, desktop notifications, session auto-rename, chat min-width
(mostly), the prompt-clamp feature itself. **Bad / new work:** embedded
browser opened GitHub in an external tab + popup-blocker error ("should be
handled in the backend and shown inside the app"), sub-agent panel "not
proper, not beautiful", the default model is DEAD ("cut off" mid-chat), chat
fails silently ("I only see the message which I sent"), dead space on the
right of the chat + a bottom scrollbar, max-width "gets restricted", sidebar
sessions need depth/borders/better icons, clamp 10 → 6 lines, CI red must be
fixed, a free-only model filter, a dedicated (temporary) sub-agent key/model
section. Security holes: **deferred by the owner to later rounds.**

**Commits (in order):** `3afadcc` (rust: `user_data_dir` → `data_directory`)
· `6eb10ea` (ci: `workflow_dispatch`) · `2523ecd` (rust: `on_navigation` is a
builder method) · `66413d9` (wave 1) · `f4272f6` (wave 2) · `e2ef2fd`
(wave 3) · `b826f4a` (live-battery hardening).

## What shipped

### A. CI green for the first time since R38 (two real Rust E0599s)

The R42 audit's P0-1. Both bugs were Tauri-2 API misuse in
`src-tauri/src/browser.rs`, verified against the pinned tauri 2.11.5 docs
(no local cargo — CI is the only Rust oracle, ADR-0012):

- `:165` — `WebviewWindowBuilder.user_data_dir(...)` does not exist in
  Tauri 2; renamed `data_directory(self, PathBuf)`.
- `:175` — `on_navigation` is a **builder** method in Tauri 2 (takes
  `&Url`, must be called before `.build()`), not a method on the built
  `WebviewWindow`. Every other tauri API in the file was doc-audited.

`ci.yml` gained a `workflow_dispatch:` trigger (push events lagged 4–10 min
in the sandbox that day). **Verified green by watching the run to
completion:** dispatch run `32991398513` @ `2523ecd6` → `conclusion:
success`, including "Type-check the Rust shell" — the first green CI since
R38 (`a007a23d`). Later push runs for `66413d9` / `f4272f6` / `e2ef2fd`
also completed `success`.

**The audit's "`branches: ain]` YAML rot" was a sandbox display artifact,
not a real defect.** The Bash tool's output layer strips `[m`-style ANSI
sequences, eating the literal `[m` in `[main]`. Byte-dump verified on disk,
via `git show HEAD:`, and via the GitHub contents API: both repos' workflow
YAML was already correct. **No YAML edits were made.** (Lesson recorded for
all agents: verify raw bytes before "fixing" bracketed text.)

### B. Free-model catalog + retirement of the dead model (wave 1)

`stealth/ox-alpha` died upstream. Replacement, sourced from the
2026-08-26 `openrouter.ai/api/v1/models` snapshot (417 models):
`agent-core/src/storage/models.ts` now carries a typed static catalog —
**46 entries: 18 free chat-capable models + 28 notable paid ones** with
real context windows, per-Mtok snapshot pricing, and capability flags
(tools / structured outputs / vision). Defaults:
`DEFAULT_MODEL_ID = "z-ai/glm-5.2:free"` (256K ctx, tools + structured
outputs, purpose-built for project-level engineering) and
`SUBAGENT_DEFAULT_MODEL_ID = "nvidia/nemotron-3.5-lightning:free"` (1M ctx,
high-throughput agentic). `openrouter/free` (the meta-router across free
models) is catalogued as the resilience slot.

- Migration `0013_default_model_refresh.sql`: conservatively rewrites
  agents' dead openrouter model ids → `z-ai/glm-5.2:free` (never touches
  custom providers, `:free` ids, or catalog ids), deletes only the
  KNOWN-dead `models`-table override rows, writes an `audit_log` row.
  Historical usage telemetry deliberately NOT rewritten.
- **Free-only / All filter:** persisted shared store
  (`src/lib/settings-store.ts`, `modelsFreeOnly` default **true**) with
  shared filter helpers. Settings → Providers shows a segmented
  "Free only | All models" control over a merged live-catalog list (FREE
  badges, "N free of M"); the chat composer's per-send model picker honors
  the same pref with an inline toggle + "N paid models hidden" escape
  hatch; the sub-agent model picker (§F) reuses it too.

### C. Failed turns are LOUD, PERSISTED, and RETRYABLE (no more silent death)

Root cause of the owner's "only my message, nothing below it": the streamed
turn's catch returned a 502 envelope **without persisting anything to the
event log**, and an abnormal socket end resolved the client stream silently.

- Backend: `persistTurnError()` appends a `turn.error` session event
  (payload `{code, message, model, providerId, providerError
  (secret-scrubbed), userSeq}`) and flips the session back to `queued`
  (retryable, immune to the boot sweep's crash→failed path). Wired into
  the streamed catch (user-stop/ABORTED persists NOTHING — stop ≠ error),
  and both sync-path failure points.
- SSE protocol: the terminal error frame `{type:"error", status, code,
  message, details:{providerError, model, userSeq, errorTs}}` is now
  self-describing; a route-level crash still emits a terminal frame (never
  a bare socket end); the client synthesizes
  `{code:"STREAM_DISCONNECTED"}` when the HTTP body ends without any
  done/error/stopped frame.
- Frontend: `turn.error` folds into the timeline as an error item
  (partial tool work before the crash still renders); **TurnErrorCard**
  renders live AND after reload — model chip, reason, timestamp,
  **[Retry]** (re-sends the failed user message; disabled mid-stream) and
  **[Copy details]**. E2E-verified on a temporary sidecar: forced provider
  failure → session returns `queued` with `[message.user, turn.error]`.

### D. Chat geometry — measured, root-caused, fixed (wave 2)

All three owner symptoms reproduced with numbers before fixing:

- **Dead space (1326px at 2560):** the chat panel root was a flex child
  with no `w-full`/`flex-1` — it shrink-to-fit its CONTENT (empty state =
  455px inside a 1783px card). Fixed: panel `w-full`.
- **Bottom scrollbar:** one-axis `overflow-y-auto` computes
  `overflow-x:auto` → any wide token minted a horizontal scrollbar. Fixed:
  `overflow-x-hidden` on the scroller + `min-w-0 break-words` on text +
  PathPill truncation; code blocks keep their own internal scroll.
- **The R42 280px cap-floor regression:** three different minimums fought
  (cap floor 280 / render floor 240 / drag clamp 360) — below a 771px
  container the row overflowed and clipped the sidebar's collapse button.
  Fixed: `sidebarWidthCap(w) = max(0, w−491)` (no floor) + render floor
  36 (the collapse sliver); chat keeps its 480px floor whenever physics
  allows.

Verified live at 700/900/1100/1440/1920/2560px:
`documentElement.scrollWidth === clientWidth` at every width; at 2560 the
chat card is 1783px with the panel filling it and a readable **1080px
centered content column** (shared by messages + composer).

### E. Sub-agents settings section (temporary — owner-scoped)

New Settings tab ("Sub-agents", deep-link `?tab=subagents`; also rendered
inside Advanced until the sidebar gains the entry):

- **Temporary OpenRouter key slots** → pool slots **2/3/4** through the
  existing `PUT/DELETE /providers/openrouter/keys/:slot` routes (slot 0 is
  NEVER written; masked re-display from `poolInfo`; add-row offers the next
  free slot ≥5). Copy states these are temporary and sub-agent traffic
  prefers these keys so parallel agents don't compete with main chats.
- **`orchestration.subagentModel`** (settings-table key, default `null` =
  inherit the parent's model): validated on write to be a known catalog id
  AND tool-capable (children are mandated tool users). `delegateTask` and
  `retryChild` pass it as the child's model override; agent records are
  never rewritten. Free-first picker with the shared Free-only/All filter;
  tool-less rows render disabled with a hint; nemotron-3.5-lightning is
  the pinned recommendation.

### F. Embedded browser, backend half — the sidecar proxy (the flagship)

XFO/CSP sites (github.com — the owner's exact failure) render **inside the
app** via a server-side proxy in `agent-core/src/browser-proxy.ts` (1,256
lines, zero new deps), mounted in an ENCAPSULATED child scope
`registerBrowserRoutes(scope, token)`:

- **Per-tab ticket auth:** iframes cannot send Authorization headers, so
  `POST /api/v1/browser/session` mints a random 192-bit `bt` ticket bound
  to the tab's sessionId; proxy URLs carry `&bt=` and a scope-local hook
  promotes a valid ticket to the real bearer header. Tickets rotate on
  re-mint, 12h TTL, die with session eviction.
- **GET/POST `/browser/proxy?url=…`**: manual redirect walk (≤10 hops,
  every hop re-guarded; 301/302/303 demote POST→GET), 20s deadline, 25 MiB
  streaming cap, Range pass-through. HTML → rewritten (strip `<base>` +
  CSP/XFO meta → inject `<base href=FINAL-URL>` → tag-scoped attribute
  rewrite for a/area/link/script/img/source/iframe/form/… → style blocks →
  escape hatch → script bodies restored); CSS → `url()`/`@import`
  rewritten; everything else → byte passthrough. Framing headers (XFO,
  CSP, COOP, COEP, HSTS) simply never forwarded. Upstream ≥400 → dark-card
  HTML error page keeping the status; failures → 502 HTML page.
- **Escape hatch** (injected before `</body>`): `window.open` →
  postMessage `{type:"acute:open"}` (the PANEL decides in-panel vs
  external); `acute:title` + title MutationObserver; `acute:location`.
- **Security:** scheme allowlist http/https; private-net guard
  (localhost/127./::1/10./192.168./172.16-31…, redirect hops re-guarded)
  with a small editable allowlist for the dev origins; **no cookie /
  Authorization / set-cookie forwarding in either direction** (v1:
  logins do not persist through the proxy).
- **History + viewport state:**
  `GET /browser/history?sessionId=` (`entries/index/canBack/canForward`,
  LRU ≤32 sessions / ≤50 entries, forward-tail truncation),
  `POST /browser/navigate` (`{url}` record | `{direction:back|forward|reload}`),
  `GET/PUT /browser/viewport` — presets mobile-sm 375×667 / mobile-md
  390×844 / tablet 768×1024 / laptop 1280×800 (default) / desktop
  1440×900 / full-hd 1920×1080 + custom, zoom 0.25..3, rotate; validation
  200..3840 × 200..4320. `DELETE /browser/session` drops tab state.

Live-verified through the proxy: github.com → 200, 608 KB,
`<base href="https://github.com/">` injected, assets re-proxied, real
title, no XFO/CSP on our response; `file://` → 403 HTML; viewport PUT
mobile-md + rotate verified. 26 route tests.

### G. Embedded browser, frontend half — BrowserPanel rewrite + `browser_control` tool (wave 3)

- **BrowserPanel** (814-line rewrite): in-sidebar iframe rendering through
  the proxy with per-tab ticket auth; chrome bar (back / forward / reload,
  address bar with Go, loading state); **viewport presets 375→1920 +
  custom W×H + zoom + rotate + fit-scaling** (the panel scales the
  oversized viewport to fit); postMessage handling (`acute:title` → tab
  title, `acute:open` → in-panel vs external decision); "Open externally"
  is an explicit secondary button only. Per-tab browser state lives in
  `src/lib/browser-store.ts`. The old web-mode "open a new tab" path and
  the R41/R42 Tauri native-window control panel are REPLACED by this
  panel (the native `acute-browser` window code remains in the shell but
  the product path is now in-app).
- **`browser_control` agent tool** (19th tool): `navigate / back /
  forward / reload / set_viewport {width,height,preset} / get_state` →
  URL, title, viewport. It reads/writes the SAME viewport + history state
  the panel renders, so agent-changed dimensions appear in the user's
  panel and the agent sees what the user sees. Prompt guide tells the
  agent it can test layouts at display sizes.

### H. SubAgentPanel redesign + sidebar rows + 6-line clamp (wave 1)

- **SubAgentPanel**: ONE card per phase in execution order — Task →
  Activity (live tool timeline) → Files (manifest) → Final report (only
  once terminal — no premature "final report" while running). Coherent
  queued/running/retrying/done/failed/cancelled status chip with pulsing
  dot, live m:ss clock, near-bottom-only autoscroll (never yanks), FAILED
  banner with the reason + a styled **Retry** (calls the existing
  retry endpoint; resumes from the last completed step).
- **ClampedText default 10 → 6 lines** everywhere (owner: "six lines
  would be a better option").
- **Sidebar session rows**: dedicated hairline border on every row
  (hover/active/failed accents), 1-level depth shadow + inset highlight,
  state-aware leading icon (running spinner / failed alert / idle chat
  bubble) composing with the R38 pixel-stream; softened tree rail.

### I. Live-battery hardening (the round's closing discoveries)

- **OpenRouter free-model FALLBACK CHAIN** (`agent-core/src/agents/chat.ts`):
  for openrouter requests on a `:free` model, the fetch wrapper rewrites
  the body to `models: [model, "openrouter/free"]` — the provider itself
  retries across free models when the primary is rate-limited or dead.
  **Live-verified through a real 429 storm: a glm-5.2:free turn completed
  via the fallback.** This is the durable mitigation for dead/rate-limited
  free models (the exact incident class that killed ox-alpha).
- **Migration `0014_delegate_browser_tools.sql` + `TOOL_NAMES` fix —
  delegation was UNREACHABLE.** The seed allowlist
  (`TOOL_NAMES`) never included `delegate_task`, so every seeded template
  agent (the ones the owner actually uses) COULD NOT delegate — the whole
  sub-agent system was inert from the templates. `0014` appends
  `delegate_task` + `browser_control` to template/default-agent allowlists
  in existing DBs (idempotent, audit-logged, never touches user-created
  agents). After the fix, **sub-agent fan-out worked end-to-end LIVE for
  the first time from a seeded agent**: a researcher child completed and
  reported correctly (running on a nemotron-3.5-lightning override).

## Verification

- `pnpm lint` / `pnpm typecheck` (root + agent-core) CLEAN.
- **Tests: 389 unit + 8 sidecar e2e = 397** (baseline was 262). New suites
  include models-catalog (12 + migration simulation), r43-turn-error (6),
  stream-error (9), TurnErrorCard (4), SubAgentsTab (9),
  r43-subagent-provider (8), browser-proxy (26), browser-tool,
  BrowserPanel, chat-geometry regressions (ChatFocusLayout 2→9,
  AgentChatPanel 7), SubAgentPanel (6), ClampedText (4), sidebar rows (+3).
- `pnpm license:audit`: clean, 131 prod deps.
- **CI: verified green on main** — dispatch run `32991398513` @ `2523ecd`
  plus push runs for `66413d9` (`32992645909`), `f4272f6` (`32995138172`),
  `e2ef2fd` (`32998203843`) all `success` (lint, typecheck, tests, build,
  e2e, license audit, cargo check on windows-latest).
- **Live battery (owner's keys, dev stack):** main chat turn BATTERY-OK on
  `z-ai/glm-5.2:free` through the fallback chain during a 429 storm;
  sub-agent fan-out end-to-end (researcher child completed, report
  correct, ran on the nemotron override); browser proxy live (github.com
  200 through the proxy, viewport presets); forced provider failure
  persisted `turn.error` and returned the session to queued.
- Launcher files untouched this round (no re-download needed).

## Known limitations (honest)

- **Proxy v1:** no cookie persistence — logins do not survive through the
  proxy (the native Tauri window remains the login path if it is ever
  re-exposed); runtime-JS-constructed URLs (SPA routers, client-side
  fetch) resolve against the injected `<base>` and bypass the rewrite, so
  heavily scripted sites render partially; POST multipart is forwarded
  opaque/untested; the private-net guard is hostname-only (a DNS name
  resolving into the LAN bypasses it — v1-accepted); UTF-8 decode only;
  srcset data:-URL re-merge is heuristic.
- **Web-mode/native window:** the R41/R42 "native Tauri window"
  browser path was replaced by the in-sidebar panel as THE product path;
  the shell code stays but is unexercised (cargo-check-covered only).
- **Free-tier reality:** 429 storms on `:free` models are real and
  frequent; the fallback chain mitigates but does not eliminate them
  (turns can still surface error cards — by design, loudly, with Retry).
- `thinkingmachines/inkling-small:free` returns 403 on the owner's
  account (needs TOS acceptance on openrouter.ai) — it is catalogued but
  not usable until accepted.
- The sub-agent key/model section is explicitly TEMPORARY (owner's words)
  and will be removed in a later round.
- Security holes (key scrubbing for child processes, contained auto tier,
  gated web tools) remain OPEN — deferred by the owner to the next rounds
  (audit Track 1 items P0-3..P0-5).
- The R43 plan's deferred items queue up next: packaging, memory system,
  PTY terminal, real search API backend, revert UI, session search/fork.
