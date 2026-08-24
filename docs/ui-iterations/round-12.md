<!-- last-reviewed: 2026-08-24 round-28 -->
# Round 12 — Live streaming, chat UI polish, per-reply stats, plug-and-play rename, sandbox wipe recovery (2026-08-23)

**Owner direction:** (1) remove the visible borders boxing the chat elements
in, cut side padding drastically (~10px → ~2px feel); (2) rename the default
agent Nova → **Acute**; (3) fix the inverted drag on the code/chat boundary
(right moved left); (4) **live responses** — stream text + tool calls into
the chat as they happen (not after the turn finishes); (5) reflect file
changes live in the explorer/code view; (6) per-reply stats (time, tokens
in/out, tok/s) + copy buttons + context-window display + model selection at
the composer; (7) the folder dialog appeared on Windows but without proper
presentation — make it modern and always-on-top; (8) start a proper DESIGN
SYSTEM doc so the UI is thought out from the start.

**Session event:** the sandbox was WIPED mid-round (all uncommitted work
lost). Recovery per `SANDBOX-RESTORE.md` was clean (clone → verify → redo),
and the round introduced **incremental WIP pushes to a work branch** so a
wipe can never again cost a round (memory lesson #33).

## 1. Live streaming (the big one)

- **Backend**: `streamAiSdkChat` (AI SDK `streamText` over the same
  openai-compatible provider, multi-step tools preserved; `fullStream` parts
  normalized to `text-delta | tool-call | tool-result | finish`). Usage is
  the awaited totals CROSS-CHECKED against per-step `finish-step` usage sums
  (some provider streams only report per-step; totals can resolve empty —
  take the larger).
- **`runStreamedAgentTurn`**: same event-sourced persistence and ordering as
  the sync turn (`message.user → tool.use as each call completes →
  message.assistant(+usage,+ms,+model) → usage row`), but every stream event
  is emitted live. Shared `prepareTurn` pre-flight; both paths accept an
  optional **model override** (the composer picker).
- **`POST /sessions/:id/messages/stream`** (SSE, bearer-walled): live
  `data:` frames + terminal `done|error`; client disconnect aborts the
  provider call; hijacked raw response (no buffering).
- **Frontend**: `streamSessionMessage()` SSE client; the panel renders
  **live tool pills** (spinner dots while in flight → ✓/✗ on result) and the
  **streaming assistant bubble with a blinking cursor**; on any
  file-mutating tool the explorer tree + open file invalidate IMMEDIATELY
  (live view, owner request); after `done` the canonical event-log items
  replace the live state. Fixture/demo mode still uses the sync hook.
- **Proof (curl, fresh DB)**: SSE frames timestamped as they arrived
  (tool-call → deltas → create_dir → write_file), persisted stats
  `ms=51655, in=7391, out=776`, `live/index.html` on disk (button + title).
- **Proof (browser, one invocation)**: composed a message in the real UI →
  streamed → `ui-demo/hello.txt` on disk with exact content; stats rows
  rendered; zero console errors; explorer refreshed live. (One model turn
  lazily created only the folder — a firmer prompt wrote the file; noted as
  model behavior, not a code issue.)

## 2. Per-reply stats, copy, context, model picker

Assistant events now carry `usage/ms/model`; the timeline mapper surfaces
them; each AI reply renders **chips: `12.3s · ↑ 7.4k · ↓ 776 · 15 tok/s ·
model`**. Hover any user/assistant message for a **copy button** (✓ flash).
The composer footer shows a **context meter** (`ctx ▮ 8.2k / 1.0M`,
per-model limits table) and a **model picker** (live provider catalog,
per-send override; the agent's model stays the default).

## 3. UI polish (borderless, tight, drag-fixed)

All four chat panels (TopBar/Explorer/Code/Chat) drop their outline borders —
clean surfaces separated by 3px gaps; the app shell drops to 2px padding on
the chat route; drag handles thinned to 5px. **Chat-resize drag sign fixed**
(the handle sits on the chat's LEFT edge, so dragging right now correctly
shrinks the chat / grows the code pane). Verified in screenshots + VLM.

## 4. Acute (default agent rename)

Seed + existing rows renamed Nova → **Acute** (fixed id kept so sessions
survive; a user who renamed it themselves keeps their name). Chat header,
code-view chip, tests updated.

## 5. Folder dialog (Windows presentation)

Method 1 is now the **modern Vista-style picker** (OpenFileDialog with
validation disabled) and every WinForms dialog gets a **hidden topmost owner
form** so it can never appear behind other windows; three methods with
fallback + marker protocol + full error surfacing (round-15 semantics kept).

## 6. Design system (owner-mandated doc)

New **`docs/design/DESIGN-SYSTEM.md`**: tokens, spacing scale (incl. the 2px
chat-route padding rule), the borderless-panel language, surface elevation,
motion constants, component anatomy inventory — the single reference for all
future UI work so everything stays consistent by construction.

## Verification

`pnpm verify` green (115 agent-core incl. 2 new streaming-runtime tests;
e2e updated for Acute ordering; build + license clean). Live: SSE curl
battery, browser E2E (disk + stats + live explorer refresh + zero errors),
screenshots `assets/round-12/{chat-borderless, chat-streaming-mid,
chat-streaming-final, chat-tall}.png` machine-verified (stats chips ✓,
borderless ✓, ctx meter + model ✓). Work branch
`work/round-16-streaming` used for WIP pushes, merged to main when green.

## Open items

1. Owner Windows re-test: Browse (modern dialog, always on top), streaming
   feel, drag direction, stats/copy/ctx/model picker.
2. Streamed turns don't yet emit "finish" stats into the UI live chips
   (final numbers arrive with `done` → refetch); acceptable now, refine later.
3. Dashboard usage-page redo remains queued (owner-gated next round).

**Status: delivered (streaming + stats + polish + rename + dialogs + design
doc); awaiting owner review.**
