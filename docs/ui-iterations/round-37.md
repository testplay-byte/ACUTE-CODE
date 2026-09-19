<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 37 — Chat continuity (Working section) · Provider rebuild · Approvals

**Date:** 2026-08-25 · **Branch:** `work/round-37` · **Owner directives:**
the Capttture.PNG break report + proposed.PNG/proposed2.PNG target UX + the
settings/approvals directives (full text in `docs/agent/R37-PLAN.md`).

## What shipped

### A. Chat continuity (ADR-0023)

- **One turn per user message**: `toProjectChatItems` folds the event log into
  `AssistantTurnItem` — `working` entries (thoughts w/ measured `thinkingMs`,
  interim narration, tool calls, approval exchanges) + `finalText` (text after
  the last tool call) + turn-level stats. The R35 stats-carrier merges into
  the turn; failed turns keep their user bubble; ends-on-tool turns render
  working-only.
- **WorkingSection** (new `src/components/project-chat/WorkingSection.tsx`):
  borderless, minimal — live header `Working · mm:ss` (counting up, pulsing
  dot) → `Worked for Ns · N actions` on completion, auto-expand while live,
  auto-collapse when done (manual taps always win). One-line ThoughtRow
  (auto-expand while thinking, auto-collapse when the thought completes),
  one-line ToolLine (verb labels: Listed/Read/Wrote/Ran/…; expands to
  diff/terminal/output/SubAgentCard detail), ApprovalRow.
- **The answer renders OUTSIDE the section** — collapsing work never hides it.
- **Live view builds the same shape**: streamed text below the section as the
  presumptive final; a tool-call flushes it in as narration. R35 fixes #2/#6
  preserved verbatim.
- **Sparkles removed at all 9 sites** (chat + sessions + agents screens); the
  empty state uses the approved AcuteLogo. No avatars/name headers on
  assistant messages.
- **Width fixes**: focus-mode column max-w 1500px (was 900); 3-panel mode
  fills the freed Code space with chat.

### B. Settings & providers

- **Models & Providers rebuilt** (owner spec): ONE flat list (no groups, no
  nested vendor-picking); **Add Provider dialog** (preset choice →
  name/baseURL/apiFormat/key fields; presets prefill; already-added presets
  badge); EVERY provider editable (rename, base URL, API key, enable/disable)
  and deletable — built-ins tombstone on delete (migration 0010) so the boot
  seed doesn't resurrect them; re-adding clears the tombstone.
- **apiFormat is real** (owner: "he can select the API format… so that he can
  add any kind of custom API provider"): `chat-completions` |
  `anthropic-messages` | `responses` — threaded through prepareTurn → chat.ts
  (`@ai-sdk/anthropic`, `@ai-sdk/openai` `.responses()`); unit-tested per
  branch; live-tested on chat-completions only (the honest limitation — no
  anthropic/responses keys).

### C. Approvals (ADR-0024)

- **Policy engine** (single source of truth): blocked → deny forever ·
  destructive → ask ALWAYS (never rule-able; `remember=always` silently
  downgrades) · auto (read-only/build/test) → run · project exact-match rule
  → run · else ask. `npm install`/`git commit` class commands moved from the
  old auto list to **ask**; `env`/`echo` dropped.
- **Interactive wait**: in-process resolver map (no DB polling) resolved by
  `POST /api/v1/approvals/:id/decision`; 120s timeout + abort-race deny;
  boot sweep expires crash-orphaned rows and wakes zombie waiters.
- **Fail-fast non-interactive**: sync turns + sub-agent children deny
  non-auto commands immediately.
- **Events**: `approval.requested`/`approval.resolved` ride SSE AND persist
  (they fold into the turn's working section — the exchange renders after
  reload). Frontend ApprovalCard: Allow once / Always allow / Deny.
- Migration 0009 (approvals gains project_id/remember/expires_at;
  approval_rules table).

### D. Logging

- `agent-core/src/lib/log.ts`: zero-dep JSON-lines logger (stdout +
  `.dev/acute.log`; `ACUTE_LOG_PATH`/`ACUTE_LOG_LEVEL`) — turn lifecycle,
  tool calls (name + argsSummary ONLY), approval lifecycle, boot sweeps.
  Security rule: never outputs, never key values.

## Evidence

- **251 tests green** (was 227): +13 fold tests (turn shape), +3 chat-format,
  +9 approval-flow, +1 compound-command bypass (review B1), +2 provider
  tombstone/patch, engine tests updated. lint / typecheck / build / e2e /
  license audit green (112 prod deps).
- **Live browser battery** (scripts/live-r37.sh + live-r37-settings.sh,
  agent-browser + VLM-verified screenshots, zero console errors):
  - The money question ("Which files are in the COW folder?") ran a REAL
    multi-step turn (32.9s, thinking + list_dir): live "Working · 0:26"
    section with one-line rows → completed to "Worked for 2s · 1 action" →
    final answer ("H8.jpeg, L3.jpeg") BELOW the section — NO repeated
    avatars/headers, chat fills the panel width.
  - Thought rows: one-line collapsed by default, expandable to full mono
    text, live row expanded while thinking.
  - Approval flow LIVE-PROVEN: "printf live-proof > approval-evidence.txt"
    → amber Permission card (command in mono, Allow once / Always allow /
    Deny, "waiting for approval" in the Working header) → Allow once →
    command executed → **file on disk contains "live-proof"**.
  - Settings: flat provider list; provider detail with editable name, base
    URL, the three API format buttons, key; Add Provider dialog with
    presets (already-added disabled) + custom form.
  - Structured log (.dev/acute.log) captured the full lifecycle:
    turn.start → tool.call(list_dir) → turn.end(32.9s, tokens) →
    turn.start → approval.requested → approval.resolved(approved, once) →
    tool.call(run_command, ok) → turn.end.
- Sub-agent adversarial review: 1 BLOCKER (compound-command policy bypass —
  fixed + regression-tested), 2 MAJOR (live-thinking collapse, no-op
  injection guard — both fixed), 9 minors (fixed 8, documented 1).

## Known limitations (honest)

- anthropic-messages / responses formats: wired + unit-tested, not
  live-tested (no keys). Connection-test/model-listing buttons remain
  chat-completions-only; manual model rows work for any provider.
- Sub-agent approval propagation (a child asking through the parent's UI) is
  future work — children never get interactive approvals in v1.
- The sessions screen (`ChatView`) still uses its own fold (per-turn grouping
  there is a later round).
