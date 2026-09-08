<!-- last-reviewed: 2026-09-08 round-79 -->

# Round 30 — Windows Bug Fixes + Session Management + Sidebar/Chat Redesign

**Status:** DELIVERED — all 6 owner-reported issues fixed, live-tested in a real
browser against the real OpenRouter API, 212 tests green, pushed.

**Owner directive (R30 opening message):** owner tested the real product on
their Windows device via `ACUTE.bat` and reported (verbatim themes):
1. "the left sidebar definitely does not look good… You have added the demos
   section, which is apparently not needed at all so maybe try removing it"
2. "I am not able to delete any of the sessions… All of the sessions are
   exactly the same. Each one of those sessions should be different. They
   should have different context… The only thing we have in common should be
   the project itself"
3. "When I click on any one of those sessions… those should be clearly
   highlighted as the currently selected one"
4. "the chat window needs a complete redo… needs a complete UI overhaul"
5. "When I send it a message it does not stream the responses properly… it
   should properly start showing me the results"
6. "after each message it shows me an error and says 'Failed to fetch'…
   running into some issues in my environment [Windows]"

---

## Root causes (all found hands-on, verified with live batteries)

### Issue 6 + 5 — "Failed to fetch" + no streaming (THE critical bug)

**Root cause: the SSE streaming route dropped its CORS headers.**
`POST /sessions/:id/messages/stream` calls `reply.hijack()` and writes the
response via raw `res.writeHead()`. Headers set with `reply.header()` in the
`onRequest` CORS hook are **silently discarded** once the reply is hijacked —
Fastify never serializes them. Result: the SSE response shipped WITHOUT
`Access-Control-Allow-Origin`, the browser (page at `localhost:5173`, sidecar
at `127.0.0.1:5178` — cross-origin) blocked the response, and `fetch()`
rejected with `TypeError: Failed to fetch` on EVERY streamed message.

This single bug explains BOTH owner symptoms:
- "Failed to fetch" after each message (the fetch rejection, surfaced by the
  catch-block's `setSendError(err.message)`).
- "does not stream the responses properly… completes all tasks then shows
  results" — the catch-block invalidated the session query; when the backend
  (which completes the turn server-side regardless) finished, the canonical
  reply appeared in one piece. No live typing, ever.

**Fix** (`agent-core/src/server.ts`): extracted `corsHeadersFor(origin)` and
spread it into the raw `writeHead()` of the hijacked SSE reply. Live-verified:
`curl` with `Origin: http://localhost:5173` now returns
`access-control-allow-origin` on the streaming response; the browser test
shows **0 fetch/CORS errors** and the reply streams token-by-token (poem
screenshots 03–05 show progressive growth: partial → 6 lines → complete).

Regression tests: e2e `SSE streaming responses carry CORS headers` asserts the
header on the live sidecar; unit tests unchanged (route internals).

### Issue 2 — "All of the sessions are exactly the same"

**Root cause: `AgentChatPanel` ignored the `?session=` URL param.** It always
bound the project's MOST-RECENTLY-UPDATED session (L757–766 pre-fix). Clicking
any session in the sidebar navigated to `?session=<id>` but the panel kept
rendering the latest session's log — and every message went INTO the latest
session, keeping it latest forever. Every session looked identical because
they literally all displayed the same session.

**Fix** (`AgentChatPanel.tsx`): `?session=` is now the authoritative selection
(param session if it belongs to this project → else latest fallback). Sending
the first message in a new session pins the param via `setSearchParams`. The
sidebar's session rows write the same param. Live-verified: Session A (empty)
and Session B (bananas exchange) in the same project have completely separate
event logs (`sqlite3` inspection) and the browser shows each correctly.

### Issue 2b — "not able to delete any of the sessions"

**Fix (full stack):**
- `storage/sessions.ts` — `deleteSession()`: one transaction removing
  `session_events`, `usage_events`, `approvals`, `file_snapshots`, `sessions`.
- `server.ts` — `DELETE /sessions/:id` (404 unknown / 204 deleted).
- `api.ts` — `remove()` on `SessionsBackend` (http + fixture backends).
- `use-sessions.ts` — `useDeleteSession` (removes the detail query cache +
  invalidates the list).
- `Sidebar.tsx` — hover trash button per session row; deleting the open
  session drops the `?session` param (falls back to the latest remaining).

Tests: 3 new unit tests (204+404+401, events/usage cascade, survivor intact) +
1 e2e (delete → GET 404). Live-verified in the browser: "Session A cat"
deleted via the sidebar trash; API list then contains only "Session B math".

### Issue 3 — selected session not highlighted

**Fix:** `SessionRow` compares its id against the `?session=` param (the same
source of truth as the chat panel). Active row: accent-tinted fill + bold text
+ 2.5px accent indicator bar on the left edge. VLM verification of the
screenshot: *"the session row labeled 'Session B math' is highlighted with an
orange accent bar on its left edge and a slightly lighter background."*

### Issue 1 — sidebar "ugly", Demos "not needed at all"

**Fix:**
- **Demos nav button REMOVED** (the `/demos` route stays registered but is no
  longer discoverable from the sidebar — the owner called the nav entry
  "not needed at all").
- **Distinct surface color** — new derived theme tokens `sidebarBg` /
  `sidebarBorder` / `sidebarHover` (`themes.ts`): light mode mixes 12% of the
  theme accent into the bg (Nova cream + orange → warm sand), dark mode mixes
  16% accent into cardDark (warm charcoal). Every theme gets a harmonious but
  clearly-different rail without per-theme hand-picking. First pass at 7–8%
  read as "subtly distinct" in VLM review and was raised.
- All sidebar hovers/borders now use the sidebar tokens.

VLM verification: *"the sidebar features a warm, reddish-brown tint, whereas
the main chat area is a plain dark gray"* (dark) and *"a warm, peach-tinted
background that is clearly distinct from the plain white main chat area"*
(light).

### Issue 4 — chat window "complete UI overhaul"

**Fixes (in-place modernization of `AgentChatPanel.tsx`):**
- **Empty state:** centered hero — big accent icon tile with glow, "How can I
  help with {project}?" greeting, agent/model subtitle, and 4 suggestion chips
  (Explore / Find a bug / Explain architecture / Write a plan) that pre-fill
  the composer.
- **Assistant messages:** avatar tile + name header (Claude/ChatGPT pattern)
  instead of anonymous card bubbles; content directly on the panel surface.
- **Live streaming row:** mirrors the final assistant layout (avatar + name +
  "streaming…" label + pulsing avatar) so the transition from streaming to
  canonical message is seamless.
- **Composer:** auto-growing `<textarea>` (Enter sends, Shift+Enter newline,
  max ~6 rows) replacing the single-line `<input>`; dead disabled Paperclip
  button removed; send button gains accent glow + disabled state.
- New `ac-pulse` CSS keyframe (reduced-motion safe).

---

## Verification evidence

**Full pipeline (run hands-on after all fixes):**
- `pnpm lint` — 0 errors
- `pnpm typecheck` (frontend + agent-core) — 0 errors
- `pnpm test` — **212 passed** (was 207; +3 DELETE-session unit, +2 e2e)
- `pnpm build` — GREEN (pre-existing 678 kB chunk warning only)

**Live battery (real sidecar + real vite + real browser + real OpenRouter):**
1. Booted sidecar :5178 (with the staged OpenRouter key) + vite :5173.
2. Created project `r30-demo` + two sessions (A "cat", B "math").
3. Browser (Chromium via agent-browser) → Session B → typed → Enter.
4. **Streaming worked in the browser**: model reply "bananas are yellow"
   arrived live; screenshots show progressive poem growth mid-stream
   (6 of 10 lines at one capture); **0 fetch/CORS console errors**.
5. Session contexts verified separate at the SQLite level (A empty, B has the
   exchange — same project, different event logs).
6. Sidebar: Session B highlighted (accent bar + tint), Session A deleted via
   hover trash → API confirms only B remains.
7. VLM-verified screenshots (dark + light): sidebar clearly distinct; no
   visual defects reported.

**Screenshots (9, published to DASHBOARD `screenshots/round-30.zip`):**
`01-app-overview` · `02-composer-typed` · `03–05-streaming-mid-1/2/3` ·
`06-reply-complete` · `07-sidebar-dark-highlight` · `08-session-deleted` ·
`09-sidebar-light`

---

## Known non-issues (documented so nobody "fixes" them backwards)

- The e2e `SSE streaming responses carry CORS headers` test uses an
  unconfigured agent (409 error event over SSE) — the CORS headers land
  BEFORE any turn logic, so the error path still proves the header fix.
- The dashboard's first-run wizard (`acute.setupDone` localStorage flag)
  gates the sidebar behind onboarding on a fresh DB — by design.
- `ExperimentalLayout` still renders for `experimentalMode` users; the
  chat-focus layout is the default for normal use.
