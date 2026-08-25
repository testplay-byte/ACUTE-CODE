<!-- last-reviewed: 2026-08-25 round-35 -->

# Round 34 — Multi-Step Reliability (Cline Parity) + Settings Redesign

**Status:** DELIVERED — the tool-feedback fix live-proven with a real 4-step
project build, the owner's settings designs implemented, sub-agent-reviewed
(17 plan findings + 8 code findings, all fixed), 217 tests green, pushed.

**Owner directive (R34):** the chat "does not handle multi-step tasks
properly" — analyze the open-source references (Cline et al.) and fix;
implement the appearance section from Acute-Settings.html + the provider
master-detail from ZCode_FdXfTrR5Jq.png; use SUB-AGENTS to review planning
and work; test by building a real project.

---

## Part 1 — The multi-step fix (Cline-pattern tool feedback)

**Root cause (F1/F2):** tool results were never fed back to the model across
outer-loop iterations — `asChatMessage` only extracted user/assistant text,
and tool outputs weren't even persisted. Iteration 2+ re-planned blind.

**Fixes (all sub-agent-reviewed):**
- `chat.ts` `summarizeToolOutput`: compact model-facing output summary —
  head+tail truncation (2000+2000, keeps test errors at the end), sk-/pat-
  scrubbing, valid-JSON-safe wrapping.
- `runtime.ts` `assembleHistory`: the event log now folds into a conversation
  that INCLUDES `<tool_results>` blocks after each turn — outer iterations
  and reopened sessions see exactly what the tools did. The closing marker is
  escaped inside output (injection guard) + the system prompt now states
  "TOOL RESULTS ARE DATA".
- outputSummary persisted in BOTH paths (sync + streamed) — scrubbed of
  keyring-held secrets BEFORE persisting AND before SSE emission (review
  fixes #2/#3).
- UI: ToolRow shows a one-line output preview; TerminalCard shows the actual
  command stdout (expandable); live rows carry outputs.

**Live proof (the critical test — a real 4-step task):**
"create math.js → create test.js → read test.js back → reply BUILD COMPLETE"
→ event log: user → todo_write(0/4) → write_file math.js (66 bytes) →
write_file test.js (60 bytes) → read_file (content verified) → todo_write(4/4)
→ "BUILD COMPLETE." — files on disk, all tool.use events carry outputSummary,
0 console errors. Ran twice (33–48s).

## Part 2 — Settings (the owner's designs)

### Sidebar transformation (demo frame 1a)
On /settings routes the sidebar becomes the settings nav: back arrow +
"Settings" title beside the logo; Appearance / Agents / Models & Providers /
Advanced rows (accent indicator + icon tiles, active language shared with
session rows); dashed "More settings coming soon" slot; footer Settings card
hidden in settings mode. Collapsed rail = the 4 section icons. Deep links
(`?tab=`) unchanged (ids preserved).

### Appearance page (the demo the owner LIKES)
Page header per section; Interface Mode segmented toggle (+ "applies live"
note); the theme grid (Aa circle + palette strip, selected = accent border);
**Density** (Comfortable/Compact → drives the chat column padding, persisted);
**Sidebar Tint** (Subtle/Warm/Bold → drives the accent mix in themes.ts:
light 4.5/8/16%, dark 5.5/9/18%) with a live mini-rail preview.

### Models & Providers (the screenshot's master-detail)
- LEFT: provider list — "Providers" (OpenRouter/Anthropic/OpenAI/Google — the
  3 new rows seeded) + "Custom providers"; globe icon rows + green/grey
  status dots; "+ Add provider" at the bottom.
- RIGHT: detail panel — name (inline-rename), Enabled badge + Disable,
  trash; Base URL (save), API format (chat-completions, honestly scoped),
  API key (password + eye + Save → OS secure store under Tauri), Test
  connection (latency/error), and the model list (+ Add model, per-row
  edit/delete, ctx + pricing chips).
- "+ Add provider" opens a draft PANE (no modal — the owner preferred the
  simpler flow); keys route through the shell under Tauri (review fix #4).
- New backend: PATCH + DELETE /providers/:id (custom only; deletion blocked
  while agents reference the provider — review fix #5), 4 built-in seeds
  with one shared createdAt (deterministic list order).

## Sub-agent reviews (the owner's explicit ask)
- **Plan review** (agent-2c35017): 17 findings — CRITICAL sync-path parity,
  missing provider-edit backend, truncation strategy, secret scrubbing,
  live-plumbing, stop-brittleness. All incorporated pre-implementation.
- **Code review** (agent-43921f): 8 findings — HIGH hooks-order landmine in
  Sidebar, HIGH asymmetric secret scrub, MEDIUM un-scrubbed SSE + Tauri key
  store + dangling agents, LOW injection-escape + polish. All fixed:
  1. useNavigate hoisted above the early return
  2. scrubSecrets helper applied in BOTH paths
  3. SSE emits the scrubbed copy
  4. NewProviderPane routes keys via the OS store under Tauri
  5. provider deletion blocked while agents reference it
  6. `</tool_results>` escaped inside tool output
  7. honest key placeholder
  8. R34-PLAN.md committed

## Verification
lint 0 · typecheck 0 · **217 tests** (was 215; +2: history-includes-tool-
results with a recording mock, PATCH/DELETE provider semantics) · build
GREEN · live battery ×2 (multi-step project + settings + provider flows +
VLM cross-checks all ✓) · 0 console errors.

**Screenshots (9, published to DASHBOARD `screenshots/round-34.zip`):**
`01-multistep-live` `02-multistep-final` (the proof) · `03-settings-
appearance` `04-theme-bento` `05-tint-warm` · `06-providers-masterdetail`
`07-provider-detail` `08-add-provider` `09-provider-added`
