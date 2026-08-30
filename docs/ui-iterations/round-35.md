<!-- last-reviewed: 2026-08-30 round-54 -->

# Round 35 — Thinking + Interleaved Tool Calls + Chat Centering + Settings Polish

**Status:** DELIVERED — sub-agent reviewed (8 findings, all fixed), 219 tests
green, live-proven with a real interleaved multi-step build, pushed.

**Owner directive (R35):** the settings design prompt was missing; the back
button belongs BELOW the heading / ABOVE content; the chat window is too tall
/ not wide enough / must be centered; thinking functionality (dialed-out,
collapsible); tool-calls preferences in settings; tool calls must show
mid-message where they happen, then the message continues.

---

## 1. Design Prompt 4 (the owner's ask, delivered)
`docs/design/AI-DESIGN-PROMPT-4.md` — every settings page in depth: shared
page skeleton (header + back-button placement + content zone), Appearance
(mode/themes/density/tint + the NEW Tool Calls card), Agents (list + editor
with allowed-tools grid), Models & Providers (the approved master-detail),
Advanced (data/diagnostics/danger/about), variant checklist + guardrails.

## 2. Thinking functionality (dialed-out, collapsible)
- `chat.ts`: `reasoning-delta` → `thinking-delta` stream events.
- `runtime.ts`: thinking accumulates per segment; persisted with each
  assistant segment payload (`thinking`, capped 4000 chars head+tail — review
  fix #5); history assembly does NOT feed thinking back to the model.
- UI `ThinkingBlock`: muted italic "Thought process" toggle with brain icon +
  chevron + preview line; collapsed by default; mono, tertiary tone,
  accent-tinted left border when open. Live variant streams with ellipsis.

## 3. Interleaved tool calls (the big one)
- `runtime.ts flushSegment`: when a tool call arrives mid-message, the
  text-so-far is flushed as an interim assistant SEGMENT — the event log
  becomes text → tool work → more text, exactly the owner's directive.
- Stats: only the FINAL segment of an iteration carries usage/ms/model; when
  the iteration's text all preceded its tools, a stats-CARRIER event (empty
  content + usage) keeps the badges alive — `asChatMessage` skips it for
  history and `toProjectChatItems` MERGES it into the last real message
  (review fix #1, end-to-end).
- Live UI: `liveSegments` (text/tools alternating) renders the stream exactly
  as it happens — text grows, the activity block appears mid-message, then
  more text. StrictMode-safe immutable updates (review fix #2) + orphan
  tool-result rows restored (fix #6) + growing-text auto-scroll (fix #4).
- `asChatMessage` skips empty-content assistant messages (fix #3 —
  Anthropic-protocol 400 guard).
- LIVE-PROVEN: "create hello.txt → create bye.txt → BUILD COMPLETE" → event
  log: user → assistant[thinking] → create_dir → assistant[thinking] →
  write_file → … → "BUILD COMPLETE"; files on disk; VLM confirms thinking
  blocks + interleaved activity + centered column.

## 4. Chat window
Conversation column CENTERED at 900px (was left-hugging 4xl) — the owner's
"too tall / not wide enough / centered on the screen".

## 5. Settings
- **Back-to-dashboard pill** BELOW the header, ABOVE the content (the exact
  placement the owner specified) on every settings page.
- **Tool Calls preferences** (Appearance): Detailed / Compact / Hidden option
  cards with radio dots + descriptions + tiny inline mocks — wired to the
  theme-store `activityMode` (persisted; the ActivityBlock header popover
  writes the same store now).

## Verification
lint 0 · typecheck 0 · **219 tests** (+1 R35 interleaving/thinking runtime
test, +1 carrier-merge api test; the streamed-events test now asserts the
carrier) · build GREEN · live battery (interleaved task with thinking +
settings + VLM cross-checks) · 0 console errors. Sub-agent review: 8 findings
(2 HIGH: stats regression + live state mutation; 3 MEDIUM: empty-content
history 400s, auto-scroll, thinking cap; 3 LOW) — ALL fixed.

**Screenshots (7, published to DASHBOARD `screenshots/round-35.zip`).**
