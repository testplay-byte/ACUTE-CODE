<!-- last-reviewed: 2026-09-10 round-83 -->
# Round 49 — The file-tools repair (migration 0019: the default agent's allowlist was narrowed to 5 tools) · browser sub-resources actually load (absolute proxy rewrites) · nested sub-agents + the tool-intent nudge · the memory master switch · the cat logo · Sessions fully removed

**Date:** 2026-08-29 · **Branch:** `main` · **Owner directives:** every fix in
this round traces to the owner's second Windows test session after R48.
Satisfied: the folder picker ("working perfectly… I am satisfied with the
look and feel"), the project colors ("perfect… exactly like how I wanted"),
the collapsing rail, the memory rows, the Files tab ("everything was
working properly"). Broken, in his words: *"even my main agent said that it
could not do the task"* — the agent reported its only tools were
`browser_control, memory_save, memory_recall, memory_list, delegate_task`
and *"the system prompt references write_file, read_file, list_dir…
but they're not actually wired into this session"*; the embedded browser
*"opened it up properly. This time, finally, it did not give me any
errors… but the page was not rendered properly. There was no CSS or JS; it
was just blank HTML"*; the branding *"should be a silhouette of the face of
a cat"*; *"completely remove the sessions navigation. It should not be
available anywhere"*; and *"maybe try giving me a setting in the settings
to turn off this memory functionality"* plus *"there is some kind of
memory leak in between the agents and the sub-agents… that same session
should not be used for the sub-agents either. The sub-agents will have
their own independent context."* Chat bottom-bar/model-switcher remains
**EXPLICITLY DEFERRED** by the owner. Plan: `agent-ctx/R49-plan.md`
(sandbox). Verified live end-to-end against real OpenRouter keys
(`scripts/battery-r49.mjs`, all 5 checks green — §Verification).

**Commits:** `bb127e6` (the round: migration 0019 + runtime/tool fixes +
browser proxy fix + frontend + the battery script + docs) → `7601c28`
(the CORS allow-methods PUT fix found by the live browser pass + docs
truth-sync); version **0.49.0** across all four manifests + CHANGELOG.
CI: run 33267143225 @ bb127e6 success and run 33268127374 @ 7601c28
success, both API-verified before this claim.

## What shipped

### A. THE root cause of "I have no file tools": migrations 0014+0015 turned `[]` (= ALL tools) into an explicit 5-tool allowlist — migration 0019 repairs it

The smoking gun was the owner's own paste: the main agent listed its
available tools as exactly `browser_control, memory_save, memory_recall,
memory_list, delegate_task` — five tools, no files, no git, no run_command.
That set is not random: **the default "Acute" agent
(`agt_default_nova`) is seeded with `allowed_tools = '[]'`, which per
ADR-0019 means "ALL tools" — and migrations 0014 + 0015
(`json_insert(allowed_tools, '$[#]', …)`) appended `delegate_task`,
`browser_control` and the three `memory_*` tools to that empty array "when
missing".** The append turned the semantic "all tools" into an explicit
allowlist of exactly the five appended tools. Every install whose database
was seeded before R43 (the owner's Windows machine included) silently lost
the ENTIRE project tool set for the default agent — and because sub-agent
children run the PARENT's agent row, children inherited the same 5-tool
cripple (the owner's sub-agent reported the identical list). Fresh sandbox
databases were never damaged (migrations run BEFORE the agent seed on a
new database — `openDatabase` order), which is exactly why every previous
round's tests and batteries passed while the owner's real machine failed.

- **Migration `0019_repair_default_agent_tools.sql`** resets
  `agt_default_nova.allowed_tools` back to `'[]'` — but only under a
  FINGERPRINT: the row's list must be non-empty AND every entry must be
  one of the five tools the damaging migrations could append. Any list
  that also contains a real project tool (`write_file`, …) is a
  deliberate owner restriction and is left untouched; user-created agents
  and template rows are never modified. Idempotent (reopening applies
  nothing further); audit-logged like 0013/0014/0015/0018.
- **Tests:** `tests/migration-0019.test.ts` builds a real pre-R49 database
  (migrations 0001–0018 by hand), inserts the damaged default row in both
  the full and the 0014-only intermediate form, plus deliberate
  restrictions and a user-created agent with the damaged-looking
  fingerprint, and asserts: default → `[]`, everything else byte-identical,
  audit row present, idempotent on reopen.

### B. The embedded browser renders full pages now — rewritten sub-resource URLs are ABSOLUTE

The R48 ticket fix made pages *load* (no more 401 flash-loop) — but they
rendered as unstyled HTML without scripts. Root cause, line-verified:
`rewriteHtml` injects `<base href="UPSTREAM_URL">` into the document (so
runtime-relative fetches by page JS resolve against the upstream origin —
correct), but `buildProxyUrl()` emitted **path-relative** rewrite targets
(`/api/v1/browser/proxy?…`). Path-relative URLs resolve against the
document's BASE — so every rewritten stylesheet, script and image was
being requested from **the upstream site**
(`https://en.wikipedia.org/api/v1/browser/proxy?…` → 404), and the page
fell back to bare HTML. Exactly the owner's report.

- `RewriteCtx` now carries `proxyOrigin` — the sidecar's origin **as the
  requesting client sees it**, derived from the live request's `Host`
  header in the proxy handler — and `buildProxyUrl()` stamps every rewrite
  (`href`/`src`/`srcset`/`action`/`url()`/`@import`/form-fallback) as an
  absolute `http://<sidecar-host>/api/v1/browser/proxy?…` URL that
  survives the injected base. No Host header (HTTP/1.0 oddity) falls back
  to the legacy relative behavior.
- **Sub-resource errors are no longer HTML error pages**: a CSS/JS/img
  fetch that fails upstream (4xx/5xx/502) now returns an EMPTY body with
  the upstream status + content-type (`sec-fetch-dest` is the signal;
  `Accept: text/html` is the fallback; navigations/iframe loads keep the
  friendly error card). Previously the browser parsed our error-page
  markup as CSS/JS — console noise on every broken sub-resource.
- **Tests:** the browser-proxy suite (38→39) pins the new contract —
  every rewrite asserted absolute against a deterministic
  `Host: sidecar.local:5178`, the ONLY relative proxy URL left in a
  rewritten document is a value that was already a proxy path in the
  source (pass-through, not a rewrite), and the new empty-body sub-resource
  error test covers style/script/navigations distinctly.
- **Live:** battery S49-5 serves a real page (external CSS + JS + img)
  from the vite dev server through the proxy: 3 absolute rewrites, and
  fetching a rewritten stylesheet through the proxy returns
  `text/css` with the CSS body intact.

### C. Sub-agents can delegate too (nested, depth-capped) + the tool-intent nudge

- **Nested delegation.** The owner: *"It was supposed to be exactly like
  how the main agent works… Everything about it should be the same. The
  only difference should be that it will have our separate context and it
  will utilize the separate API keys."* Children now keep `delegate_task`
  below `MAX_DELEGATION_DEPTH = 3` (a sub-agent can spawn sub-agents,
  which can spawn sub-agents); at/beyond the cap the runtime strips
  `delegate_task` from the tool set — the recursion guard, bounded by
  construction (`delegationDepth()` walks the `parent_session_id` chain,
  cycle-safe). Note `delegate_task` IS in `TOOL_NAMES` (added R43) — the
  old "strip for children" filter was doing real work; the new
  `withoutDelegate()` keeps filtering it from `TOOL_NAMES` at the cap.
- **The tool-intent nudge** (live-battery find): free/cheap models
  intermittently answer a WORK request by DESCRIBING the tool call in text
  (`"I'll delegate this to a coder agent.\n\n\`\`\`python\ndelegate_task(…)\n\`\`\`"`)
  instead of emitting a real tool call — the outer loop's zero-tool-break
  then ended the turn with nothing done. Both the sync path (sub-agents)
  and the streamed path (the main chat) now spend ONE in-memory nudge
  ("ACTUALLY CALLING the tool(s) — a real tool call, never text…") when a
  zero-tool reply EVIDENCES tool intent (it names a real tool or announces
  delegation). Conversational replies still break immediately (the
  ROUND-33 "hello, how are you" lesson holds — asserted by test), a
  second stall breaks for good (one nudge per turn — asserted), and the
  nudge is NEVER persisted (it is a machine correction, not a chat turn —
  asserted). 4 tests in `tests/runtime-nudge.test.ts` (3 sync + 1
  streamed).
- **Live:** battery S49-3 ran the owner's EXACT scenario end-to-end
  against `deepseek/deepseek-chat-v3.1` — the main agent called
  `delegate_task`, the child ran
  `todo_write → create_dir → write_file → read_file → run_command →
  search_code` and reported back; `ShortStories/story.md` exists on disk
  with a title heading, section headings and a horizontal rule.

### D. The memory master switch + context isolation (Settings → Advanced)

- **`memory.enabled`** (settings table; `GET`/`PUT /api/v1/settings/memory`;
  default ON). While OFF: no memory digest is injected into ANY system
  prompt, the `memory_save/recall/list` tools are not registered (the
  model never sees them), and the right-sidebar Memory panel carries an
  amber OFF notice. Saved memories are never deleted — a re-enable
  restores them; the panel stays browsable/deletable while off (pruning
  stale memories is exactly what you want while debugging).
  Frontend: `MemoryCard` in Settings → Advanced (a real role="switch"
  toggle, invalid-input error surface, optimistic invalidation) +
  `fetchMemorySettings`/`updateMemorySettings` in api.ts.
- **Sub-agents no longer receive the project memory digest at all** — the
  owner: *"that same session should not be used for the sub-agents either.
  The sub-agents will have their own independent context."* Their context
  is the delegated task text plus project facts (codebase index), nothing
  else. (This also kills the observed poisoning vector: the owner's
  project memory contained a STALE note claiming "the sub-agent can only
  use browser_control, memory_* — no write_file" — written by a
  sub-agent during an earlier broken round — and that note was being
  auto-injected into every subsequent turn, main sessions included,
  teaching agents to believe they had no file tools. Migration 0019
  repaired the real allowlist; this change stops stale memories from
  overriding the real tool set in children.)
- Session-to-session isolation was verified structurally intact:
  `assembleHistory`/`assembleWithCompaction` read ONLY the session's own
  event log (grep-verified — no cross-session reads anywhere in the
  turn path).
- **Tests:** settings round-trip (storage + HTTP route + invalid-type
  400), toolset gating in `buildProjectTools` (allowlisted memory tools
  absent while off; other tools intact), and a `runSingleAgentTurn`
  triple-assertion: main+ON → digest present; main+OFF → absent; child+ON
  → still absent. MemoryPanel: the OFF notice renders with the list still
  browsable; no notice while ON.

### E. The cat-face logo (brand round 3)

The "A_" mark is replaced everywhere by a **white cat-face silhouette** on
the orange gradient tile: two pointed ears, a gently dipping crown, rounded
cheeks tapering to a soft chin, two slanted almond eyes and a small
triangular nose punched out via `evenodd` holes (the tile gradient shows
through) — "detailed enough" to read as a cat from 16 px (favicon) to
52 px (chat empty state) without turning to mud. Updated in lockstep:
`AcuteLogo` (Sidebar.tsx — sidebar header, mobile drawer trigger, floating
show-sidebar button, chat empty state all inherit), `public/favicon.svg`
(1:1 mirror), and `src-tauri/icons/icon.ico` (regenerated as a 6-size
PNG-in-ICO container, 16→256 px, rasterized from the same SVG via the
headless Chromium shell).

### F. The CORS allow-methods list was missing PUT (live-browser find)

While verifying the new memory toggle in a real browser, every cross-origin
PUT died at preflight with `Failed to fetch` — GET/POST/PATCH worked. The
sidecar's CORS headers advertised
`access-control-allow-methods: GET, POST, PATCH, DELETE, OPTIONS` — **PUT
was never in the list**, so every browser-side PUT route (Settings →
Advanced toggles, the key-pool slot writes, PUT /browser/viewport) has been
dead since the CORS wall shipped; nobody had driven a PUT from the UI
before this round's toggle. Fixed in both `corsHeadersFor()` and the
onRequest hook; pinned by a preflight regression test (OPTIONS with
`access-control-request-method: PUT` from `http://localhost:5173` → 204 +
allow-methods containing PUT + the origin echoed). Verified live: the
memory switch now flips server-side and in the UI on every click.

### G. Sessions navigation fully removed

R48 removed the nav entry but kept the route ("for deep links"); the
owner overruled: *"It should not be available anywhere in our project at
all."* The `/sessions` route, the `SessionsScreen` component, its test
file (13 tests) and the now-orphaned `useSessionSearch` hook are deleted.
Project chat sessions (create/rename/fork/revert/delete inside a project)
are untouched — verified by the existing suite (ChatView, NewSessionDialog
and the session API tests all still green). `App.test` already asserted
the absence of Sessions in the sidebar chrome; the route is now gone too.

## Verification

**Gates (all green at the tip):** `pnpm lint` clean · `pnpm typecheck`
clean · `pnpm test` **750/750 in 62 files** (agent-core 470/29 — was
460/27 at the R48 tip; +10: migration-0019 +1, browser-proxy 38→39,
orchestrator +2 (nested-delegation depth ladder + the /settings/memory
route round-trip), memory-tools 21→24, runtime-nudge +4 new; frontend
280/33 — MemoryPanel 4→5; −13 SessionsScreen tests). Suite delta from
752 → 750 = −13 removed + 11 added, exact.

**Live battery (`scripts/battery-r49.mjs`, real OpenRouter keys, full
dev stack booted inside the run):** all five checks PASS —

- **S49-1** memory settings round-trip (default on → off → persists → on;
  invalid → 400);
- **S49-2** migration 0019 applied on the real pre-R49 dev DB; default
  agent `allowed_tools = []` (ALL tools);
- **S49-3** the owner's exact scenario: delegation end-to-end, 1
  sub-agent, child tools `[todo_write, create_dir, write_file, read_file,
  run_command, search_code]`, 57 s turn (model pinned to
  `deepseek/deepseek-chat-v3.1` — the seeded free GLM intermittently
  writes tool calls as TEXT, a model limitation the nudge now rescues;
  see C);
- **S49-4** `ShortStories/story.md` on disk with markdown
  title/sections/rule;
- **S49-5** browser proxy: 3 absolute sidecar-origin rewrites on a real
  page with external CSS/JS/img, and a rewritten stylesheet fetched
  back through the proxy returns `text/css` content.

**Browser self-verification (agent-browser, live stack):** the dashboard
renders clean (no console errors, v0.49.0); `/sessions` renders the
Not-found placeholder (route gone); Settings → Advanced shows the Agent
memory card with a `role="switch"` toggle; the toggle flips the server
state AND the UI on every click (after the CORS fix above — the clicks
initially exposed the missing-PUT bug); the logo tile VLM-verifies as "a
recognizable cat face silhouette (white, pointed ears, eyes, nose) on an
orange tile, no glitches". Screenshots: `agent-ctx/r49-*.png` (sandbox).

Battery-infrastructure honesty: three earlier battery drafts failed on
HARNESS bugs (wrong response shapes, a reused project root 409ing project
creation — which silently created a project-less, TOOL-LESS session and
reproduced the intent-text stall the nudge targets, a
`/sessions/:id/events` route that never existed) — each diagnosed and
fixed before the green run above; none of them masked a product failure.

## Known limitations (honest)

- The regex rewriter still single-pass; runtime-JS-built URLs (SPA
  fetch/XHR) resolve against the injected base and bypass the proxy —
  heavily scripted sites remain partial (v1 design, documented in
  browser-proxy.ts).
- Nested delegation inherits the parent's KEY down the chain (the child
  keyring view exposes the same slot key on two slot ids, so a
  grandchild's per-key semaphore accounting can double-count one physical
  key — bounded by maxParallel). The UI surfaces per-child status on the
  direct parent's panel; deeper descendants' status envelopes nest and
  are not yet unwrapped by the frontend stream store.
- The seeded default model `z-ai/glm-5.2:free` remains unreliable at
  STRUCTURED tool calling (text-form tool calls); the nudge rescues most
  stalls, but a stronger default model is an owner decision (Settings →
  Models & Providers, or `orchestration.subagentModel` for children).
- The memory digest isolation covers the system prompt; a main-session
  agent can still CHOOSE to run `memory_recall` and read project memories
  while the switch is ON (that is the feature); with the switch OFF the
  tools are gone entirely.
- icon.ico is regenerated but unused while `bundle.active = false` (dev
  distribution is the launcher kit; the bundler would pick it up on the
  future installer round).
