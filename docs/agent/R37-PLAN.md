<!-- last-reviewed: 2026-09-11 round-87 -->
# ACUTE-CODE — Round 37 Plan

**Status:** APPROVED-WITH-AMENDMENTS (v2 — plan review passed; amendments folded
in below) — round 37, 2026-08-25
**Author:** Z.ai Code orchestrator
**Owner directives covered:** (1) chat-continuity overhaul with a collapsible
Working section per turn, (2) minimal/quiet tool-call presentation, (3) removal
of the sparkle-avatar "AI slop" iconography, (4) chat panel width/empty-space
fix, (5) settings + Models&Providers redesign (flat provider list, Add Provider
flow, API format selection), (6) real command execution with an interactive
human-approval flow (allow once / always / deny), (7) better logging + docs.

---

## 0. Context — what the owner reported (verified against the code)

Owner screenshots: `DASHBOARD/UPLOADED/Capttture.PNG` (the break),
`proposed.PNG` + `proposed2.PNG` (the target UX — Claude-Code-style).

| Owner complaint | Root cause (verified) |
|---|---|
| "a new chat started… the heading and the logo… breaks the experience" | `toProjectChatItems` emits ONE `ai` item per `message.assistant` event; the runtime persists N assistant segments per turn (flushSegment at every tool-call boundary + per iteration + stats-carrier). `AiMessage` renders the Sparkles avatar tile + "Acute" name row **unconditionally per ai item**. The live renderer deduplicates via `firstText` — but `liveSegments` are cleared post-stream, so the folded log re-introduces the repeated headers. |
| "tool calls… not minimal… too highlighted" | `ActivityBlock` is a big bordered card w/ 1.5px border + shadow + icon tile + "Completed N actions" banner; `FileChangeCard`/`TerminalCard` are heavy. |
| "right side… completely empty" / width not proper | `ChatFocusLayout` caps the conversation column at `max-w-[900px]` centered inside a full-width card → dead surface on wide windows. (3-panel mode with Code hidden also leaves a fixed 400px chat + void.) |
| "I really hate the SVG sparkle icon" | `Sparkles` lucide icon at 5 sites: AiMessage avatar, empty-state hero, live first-segment avatar, pre-first-delta "Thinking…" row, ActivityBlock header. |
| "settings look like AI-generated slop"; provider flow wrong | Master-detail ModelsProvidersTab with grouped lists, disabled API-format selector; `apiFormat` exists in DB + API but is dead weight (chat.ts hard-codes `createOpenAICompatible`). |
| "agent does not have the ability to run commands… ask me for permission" | `run_command` exists but fail-closes on anything outside the static SAFE_PREFIX list with a refusal string. The approval engine is 100% stub (approvals.ts categorize() never called; approvals table never written; no routes/events/UI). |

---

## 1. Design — chat continuity (R37-A)

### 1.1 Turn model (frontend fold, `src/lib/api.ts`)

New persisted-view item type; **no backend migration needed** — turns are
derivable from the append-only log (everything between `message.user` events):

```ts
export type WorkingEntry =
  | { type: "thinking"; text: string; ts: number; thinkingMs?: number }
  | { type: "text"; content: string; ts: number }
  | { type: "tool"; tool: ToolUseEntry };

export interface AssistantTurnItem {
  kind: "turn";
  seq: number;               // seq of first event in the turn
  ts: number;                // turn start
  endTs: number;             // last event ts
  agentId?: string;
  working: WorkingEntry[];   // thoughts, interim narration, tool calls
  finalText: string;         // text AFTER the last tool call = the answer
  usage?; ms?; model?;       // turn-level stats (from last segment/carrier)
}
```

Fold algorithm v2 (`toProjectChatItems`):
1. Sort by seq; `message.user` → flush turn, push user item.
2. Inside a turn: `tool.use` → working tool entry; `message.assistant` thinking
   → working thinking entry; assistant content → if a later `tool.use` exists in
   the SAME turn → working text entry, else → `finalText` (last wins).
3. Stats: last assistant event with usage/ms/model (incl. the empty
   stats-carrier, which now merges into the TURN, not an ai item).
4. Turn with empty working → plain answer row (no Working section).
   Empty turns dropped. Old flat `ai`/`activity` items are REMOVED from the
   persisted path (all consumers migrate to `turn`).

### 1.2 Runtime additions (small, additive)

- `thinkingMs` on assistant payloads: capture thinking-start ts at first
  `thinking-delta`, close at first subsequent `text-delta`/`tool-call`/`finish`
  per segment → "Thought for Ns" labels become truthful.
- No other event-shape changes. (Live SSE events unchanged.)

### 1.3 Renderer (`AgentChatPanel.tsx` + new components)

New `AssistantTurn` replaces `AiMessage`+`ActivityBlock` for the folded view:

```
[user bubble]                          (unchanged)
"Worked for 8s · 3 actions   v"        ← WorkingSection header (muted, borderless)
  Thought for 3s  "The user asks…" v   ← ThoughtRow: 1-line preview, click=expand
  Analyzed  src/lib/api.ts        v    ← ToolLine: 1 line, mono, status glyph
  Let me check the tests…              ← interim narration (muted, small)
The COW folder contains 2 files: …     ← finalText OUTSIDE the section
↑ 4.2k ↓ 312 · 28s · model             ← hover stats (turn-level)
```

- **WorkingSection**: borderless (no card chrome, no icon tile). Header is a
  muted button row: live → `Working` + pulsing dot + counting-up `mm:ss` timer +
  action count; done → `Worked for Ns · N actions` + chevron. Auto-EXPANDED
  while live, auto-COLLAPSES on turn completion (animated). Manual toggle
  always wins over auto while the user is interacting.
- **ThoughtRow**: `Thought for Ns` + one-line 60-char mono preview; expanded =
  full text block (existing ThinkingBlock body styles). Live streaming thought
  = expanded + ellipsis; auto-collapses when it completes (unless the user
  manually opened it earlier).
- **ToolLine**: 16px monochrome icon + tool label + argsSummary (mono,
  truncate) + status glyph (✓/✗/spinner) + chevron. Click → expanded detail
  reuses the existing specialized bodies (FileChangeCard diff, TerminalCard
  output, WebRow, SubAgentCard) but borderless/quieter. `delegate_task` keeps
  the SubAgentCard integration.
- **activityMode preference** maps: Detailed → section expanded by default,
  Compact → collapsed by default, Hidden → section not rendered (final answer
  always visible).
- **Sparkles removal** (all 5 sites): assistant rows get NO avatar and NO name
  header (per proposed2 — pure text). Empty-state hero swaps to the approved
  AcuteLogo. "Thinking…" pre-delta row → muted text + soft pulsing dot (no
  icon tile).
- **Width fix**: `ChatFocusLayout` drops the `max-w-[900px]` cap → the column
  fills the panel (`w-full`) with comfortable padding (px-6/px-8); composer
  matches. 3-panel mode: when Code hidden, chat wrapper becomes `flex-1`
  instead of fixed `chatWidth` (the freed space goes to chat).

### 1.4 Live streaming view

`liveSegments` renderer produces the same shape live: a live WorkingSection
(growing) + the CURRENT streaming text rendered BELOW it (presumptive final).
When a `tool-call` arrives, the streamed-so-far text moves INTO the section as
an interim text entry (what the owner described: narration lives inside the
working area). Turn completion → section collapses to "Worked for Ns".

---

## 2. Design — settings / providers (R37-B)

### 2.1 Models & Providers tab rebuild (`ModelsProvidersTab.tsx`)

- **One flat list** of ALL providers (built-in + custom together, no groups,
  no master-detail split). Rows: name, baseUrl host, key-status dot, format
  chip. Click a row → inline expandable detail (accordion) — not a side pane.
- **Add Provider flow**: `+ Add Provider` → dialog:
  - "Custom provider" (name, base URL, API key, API format) — the free-form path.
  - Preset cards (OpenRouter, Anthropic, OpenAI, Google) — prefill name/URL/
    format; key + name still editable.
- **Provider detail (editable for custom, partially for built-ins)**: display
  name, base URL, API key (masked, save → keyring), **API format** selector
  with the three real options (Anthropic messages / Chat completions /
  Responses), Test connection, Delete (custom only; built-ins can be disabled),
  key-pool section (R36) retained.
- Visual language aligned to the owner's `Acute-Settings.html` demo: 1.5px
  borders, 12-16px radii, uppercase tracking labels, JetBrains Mono for
  mono, Space Grotesk display, orange accent, danger zones in red tint.

### 2.2 API format — real wiring (`agent-core/src/agents/chat.ts`)

- Thread `apiFormat` through `PreparedTurn` → `ChatTurnInput` (provider row
  already stores it).
- `chat.ts` branches: `chat-completions` → `createOpenAICompatible` (current);
  `anthropic-messages` → `@ai-sdk/anthropic` (license-check; Apache-2.0/MIT);
  `responses` → `@ai-sdk/openai` `.responses()` with baseURL override.
- Unit tests assert the branch selection; live-testing remains
  chat-completions only (only OpenRouter key exists) — documented honestly.
- `ProviderView` (frontend type) gains `apiFormat`.

### 2.3 Settings shell polish

Keep the four sections (Appearance/Agents/Models & Providers/Advanced) — align
spacing/typography tokens with the demo where they diverge (focused pass, not
a rewrite; Appearance already matches the demo closely).

---

## 3. Design — approvals + run_command (R37-C)

### 3.1 Policy engine (`agent-core/src/approvals.ts` → real engine)

Layered decision for a command:
1. `BLOCKED` patterns (existing + destructive regexes) → **never runnable**,
   tool fails immediately with a clear reason (no prompt).
2. SAFE_PREFIX (read-only/build/test) → **auto-approve** (logged).
3. Project-scoped "always allow" rule (exact command match) → auto-approve
   (logged) — EXCEPT destructive patterns, which always ask (hard rule:
   never "always allow" destructive).
4. Otherwise → **ask**: create pending approval row, emit
   `approval.requested` (SSE + session event), wait for decision with a
   120s timeout → timeout = deny (fail-closed).

### 3.2 Persistence + API (migration `0009_approvals.sql`)

- `approvals` table (exists from 0001, now actually used) + new
  `approval_rules(id, project_id, command, created_at)` for "always allow"
  (exact match, project-scoped).
- Routes: `GET /api/v1/approvals?status=pending&projectId=`,
  `POST /api/v1/approvals/:id/decision` `{decision: approved|denied,
  remember?: once|always}`.
- Session events: `approval.requested` / `approval.resolved` (persisted, so
  the folded log renders the exchange) + SSE emit for the live card.
- Abort handling: request close/abort → pending approvals denied.

### 3.3 run_command tool rewrite (`tools/exec.ts`)

- Signature gains deps (db, sessionId, projectId, emit, signal) like
  delegate_task does today.
- Approval gate before spawn; keep 60s timeout + 64KB cap + secret scrubbing
  (env inheritance unchanged — keyring scrub already handles it).
- The SDK awaits `execute()` → the step naturally pauses while we wait.

### 3.4 Frontend — ApprovalCard

- Live: SSE `approval.requested` → highlighted card pinned in the chat
  (amber accent, 1.5px border): "Permission needed", mono command, risk note,
  buttons **Allow once / Always allow / Deny**. Decision → card resolves to a
  one-line muted record ("Allowed · npm install jest").
- Folded log: `approval.requested`/`approval.resolved` events render the same
  resolved line inside the turn's working section.
- While pending: the tool line in WorkingSection shows a waiting (amber)
  state and the Working header shows "Waiting for approval".

---

## 4. Logging (R37-D)

- `agent-core/src/lib/log.ts`: tiny structured logger (JSON lines →
  `.dev/acute.log` + console): turn start/finish, tool calls, approvals
  (requested/resolved/denied), orchestrator delegation, errors. No new deps.
- Advanced tab keeps the existing log-tail surface in mind (read-only API
  `GET /internal/logs/tail` — only if trivial; otherwise file only).

---

## 5. Test plan

- `src/lib/api.test.ts`: rewrite fold tests to the `turn` shape (grouping,
  final-vs-working split, stats merge, empty-turn drops, thinking entries,
  tool runs, tolerance cases).
- New `WorkingSection`-level fold tests as needed for `thinkingMs`.
- `agent-core`: approvals engine tests (layered decisions, rule hit,
  destructive-always-asks, blocked-never-runs, timeout-deny); run_command
  approval integration via the existing fake-chat app.inject pattern
  (command outside safe list → approval row pending → decision route →
  file on disk); apiFormat branch tests; logger smoke test.
- Full `pnpm verify` green (227+ tests, plus additions).

## 6. Verification plan (live, owner-standard)

Boot sidecar (OpenRouter key via env) + vite; agent-browser on the real app:
1. Multi-step task ("what files are in this folder") → ONE header per turn,
   Working section collapses to "Worked for Ns", final answer outside,
   minimal tool lines, no sparkle anywhere, no console errors.
2. Width: chat fills the panel on a wide viewport (screenshot).
3. Settings: flat provider list, Add Provider dialog (custom + preset),
   API format selector persists; provider card edit/delete.
4. Approval: task that forces a non-safe command → ApprovalCard appears,
   turn pauses; Allow once → command runs, output in tool line; a second
   trigger + Always allow → auto-runs with a logged rule; Deny → clean
   refusal; timeout path unit-tested.
5. Screenshots → DASHBOARD zip; VLM cross-check on the money screens.

## 7. Docs

ADR-0023 (turn-grouping UI model + Working section), ADR-0024 (approval
engine v1), IMPLEMENTED-API truth update, DESIGN-SYSTEM chat anatomy update,
`docs/ui-iterations/round-37.md`, HANDOFF §3 refresh, AGENT-MEMORY additions,
ORCHESTRATION-WORKLOG snapshot, SANDBOX-RESTORE tip refresh.

## 8. Explicitly NOT in this round

- Anthropic/Responses adapters live-tested (no keys — branch + unit tests only).
- Multi-command prefix rules ("always allow `npm *`") — exact match only (safe).
- Sub-agent approval propagation (children inherit project rules; no UI yet).
- Sessions-screen `ChatView.tsx` bubble continuity (separate fold, later round).

---

## 9. V2 amendments (plan-review findings — folded into the design above)

1. **[MAJOR — policy]** ONE decision function in `approvals.ts` (layers 1–4);
   `exec.ts` delegates to it. Contradiction resolved: `npm install`, `git
   commit`, `git add`, `yarn`, `pip`, `go` etc. move from auto-run to **ask**
   (first use; then rule-able via "Always allow"); read-only + build/test
   remain auto. `env` + `echo` dropped from auto (`env` dumps non-keyring
   secrets; `echo` is harmless but pointless as an agent tool).
2. **[MAJOR — mechanism]** Approval wait = **in-process resolver map**
   (`approvalId → {resolve, reject}`) resolved by the decision route; DB row
   is audit + crash recovery only. Boot sweep: `pending` rows older than the
   timeout → `denied` (fail-closed). NO DB polling.
3. **[MAJOR — fold semantics]** (a) turn-ends-on-tool → `finalText: ""` +
   non-empty working renders as a working-only turn (header + rows, no
   answer); (b) leading assistant events before any `message.user` →
   synthetic turn; (c) flush at EOF; (d) user items ALWAYS render (failed
   turn = user + working-only turn, never swallowed); (e) "empty turn" =
   no working AND no finalText.
4. **[MAJOR — live reducer]** Preserve R35 review fixes #2 (StrictMode-safe
   immutable tools-segment construction) and #6 (orphan tool-result row
   restore) verbatim in the new live WorkingSection reducer. Auto-scroll deps
   gain working-entry count + collapse state; `mm:ss` timer interval cleaned
   up on unmount/stream end; stream-error terminal state = "Stopped · Ns"
   (section frozen, not a dead timer).
5. **[MAJOR — approvals plumbing]** `signal` threaded through `toolDeps`;
   sync path + sub-agent children = **fail-fast deny** (no 120s burn); the
   waiter races the abort signal itself (SDK v7 may not cancel pending tool
   promises); abort-mid-approval unit test.
6. **[MAJOR — icon scope]** Sparkles removal covers ALL 9 sites: the 5 in
   AgentChatPanel/ActivityBlock + `ChatView.tsx` (3: header avatar, empty
   state, ThinkingRow) + `AgentCard.tsx` (1).
7. **[MINORs]** call-site migration list: `itemKey` turn case, ctx meter →
   turn-level usage, R33 `finalSeqs` stat-strip pass DELETED (superseded);
   `0009_approvals.sql` adds `project_id` (+ decision values) to approvals;
   Test-connection + model-listing gated per apiFormat (documented limitation
   for non-chat-completions until adapters land); ModePopover relocates to
   the WorkingSection header; ThoughtRow duration-less fallback ("Thought")
   for pre-`thinkingMs` sessions; logger writes tool names/argsSummary only,
   never outputs or keyring values; thinking-only turn (0 tools) renders a
   bare ThoughtRow with NO Working header; fold tests add: leading-assistant,
   ends-on-tool, consecutive users, thinking-only, failed turn,
   approval-requested/resolved folding, delegate_task child-session parsing
   end-to-end. 3-panel width fix = `codeVisible ? fixed : flex-1`; focus-mode
   column gets a soft readability cap (~1500px) instead of uncapped full-bleed.
