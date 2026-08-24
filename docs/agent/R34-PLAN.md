<!-- last-reviewed: 2026-08-24 round-34 -->
# Round 34 Implementation Plan (pre-review draft)

## Context
Owner verdict on R33: chat "does not handle multi-step tasks properly"; settings
designs provided (Acute-Settings.html demo + ZCode_FdXfTrR5Jq.png screenshot).
Owner requires sub-agent review of planning AND work.

## Part 1 — Chat multi-step reliability (Cline-pattern analysis)

### Findings (root causes, from code study of runtime.ts/chat.ts)
F1. **Tool results are never fed back across outer-loop iterations.**
    `asChatMessage` only extracts message.user/message.assistant. Outer-loop
    iteration 2+ re-assembles history WITHOUT tool calls or results — the model
    re-sees only its own past text. Cline always feeds the full tool I/O back.
    Within ONE SDK call the internal loop is fine (SDK handles feedback).
F2. **Tool outputs are not persisted at all.** tool.use payload =
    {toolName, argsSummary, ok}. No output summary → even if F1 were fixed,
    the data to reconstruct is missing.
F3. **UI shows tool calls but not outputs** — the owner can't see what a tool
    DID (run_command output missing entirely from the terminal card).

### Fixes
X1. chat.ts: tool-result stream event carries `outputSummary` (JSON of
    {ok, output} truncated to ~600 chars, key-scrubbed n/a — outputs are tool
    results, not secrets).
X2. runtime.ts: persist `outputSummary` into the tool.use event payload.
X3. runtime.ts: replace asChatMessage with assembleHistory that ALSO folds
    consecutive tool.use events into ONE synthetic user-role message:
    `[tool results] write_file(path: a.ts) → ok: file written` lines. This
    gives outer iterations + reopened sessions full continuity (Cline parity).
X4. ActivityBlock: ToolRow shows the output summary (truncated, title=full);
    TerminalCard shows the command OUTPUT (mono block) from outputSummary.
X5. Keep R33's zero-tools stop rule (Cline's natural stop: model ends turn
    when it replies without tool calls).

### Tests
- runtime test: multi-outer-iteration history includes tool results text.
- chat.ts test: tool-result event carries outputSummary.
- api test: tool.use payload with outputSummary → ToolUseEntry carries it.

## Part 2 — Settings page (from the owner's designs)

### S1. Sidebar transformation (demo frame 1a)
On /settings routes the sidebar renders settings sections (Appearance /
Agents / Models & Providers / Advanced) instead of NAVIGATION+PROJECTS, with
the logo + "← Back" affordance. Implementation: Sidebar reads
pathname.startsWith("/settings") → settings mode; section rows navigate
/settings?tab=X. Collapsed rail: 4 section icons.

### S2. Appearance page (demo frame 2 — owner LIKES)
- Page header: 22-28px font-black title + secondary subtitle.
- Interface Mode card: segmented Light/Dark with sliding indicator + LIVE
  badge (wizard's toggle anatomy).
- Theme grid: 3-across cards (Aa accent circle + name + palette strip + mini
  preview blocks); ACTIVE = accent border + check chip (wizard's cards).
- Density card: Comfortable/Compact segmented (NEW: theme-store field
  `density`, applied to chat column padding px-7 vs px-4).
- Sidebar tint card: Subtle/Warm/Bold segmented + live mini rail preview
  (NEW: theme-store field `sidebarTint` → mix percentages in themes.ts:
  light 2%/8%/16%, dark 3%/9%/18%).

### S3. Models & Providers (SCREENSHOT layout — master-detail)
Replace ModelsProvidersTab with a master-detail screen:
- LEFT list (~30%): grouped "Providers" (built-ins: OpenRouter, Anthropic,
  OpenAI, Google — green dot when hasKey, grey when not) + "Custom
  providers"; rows = cube icon + name + status dot; selected = tinted bg +
  accent indicator; "+ Add provider" button at bottom.
- RIGHT detail (~70%): header (provider name + Enabled badge + Disable /
  trash), fields: Base URL (mono input), API format (kind dropdown),
  API key (password input + eye toggle + Save via PUT /providers/:id/key,
  status from hasKey), Model list (rows from models-config: name + context +
  pricing, per-row edit/delete, + Add model inline form). Test connection
  button with result chip (latency/error).
- "+ Add provider" → selects a "new provider" draft in the detail pane
  (name/id/baseUrl/kind form + Add button → POST /providers). NO modal
  dialog (the owner prefers the simpler flow over the demo's dialog).
- Built-in providers: no delete, no baseUrl edit (OpenRouter fixed); custom:
  full edit + delete.

### S4. Agents + Advanced
Keep current components, mounted under the new sidebar sections (Agents
screen exists; Advanced = current advanced tab content).

## Part 3 — Verification
- Full pipeline (lint/typecheck/215+ tests/build/docs).
- Live battery: multi-step task ("create a file, then create a second file
  that imports the first, then run ls") → verify outer-loop continuation sees
  tool results (event log + UI), session interleave correct.
- VLM screenshot verification (settings appearance + provider master-detail,
  light + dark).
- Sub-agent code review of the diff.

## Risks
R1. ToolUseEntry shape change (outputSummary) touches api.ts + fixtures +
    tests — keep it optional to avoid breaking persisted old events.
R2. assembleHistory changes conversation sent to the model → prompt-budget
    math (assembleWithinBudget) must still hold (it operates on the message
    list AFTER assembly — fine).
R3. Sidebar settings mode + ?tab= routing — keep deep links working.
