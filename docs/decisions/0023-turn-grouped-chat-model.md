<!-- last-reviewed: 2026-09-12 round-94 -->
# ADR-0023: Turn-grouped chat model (the Working section)

**Status:** Accepted (round 37, 2026-08-25)
**Owner directive:** the chat must read as ONE continuous conversation per user
message — a collapsible "Working" state (progress: thoughts, commands, interim
narration) followed by the actual answer below it; repeated agent headers,
the Sparkles avatar, and loud tool cards are retired.

## Context

Through round 35 the event log persisted N `message.assistant` events per turn
(one per `flushSegment` at every tool-call boundary + one per outer-loop
iteration + a stats-carrier), and `toProjectChatItems` folded EACH into its own
`ai` chat item. `AiMessage` rendered an avatar tile + "Acute" name row per
item, so a multi-step turn showed the header repeatedly — exactly what the
owner called out in his screenshot ("where things break and the logo of the
agent shows").

## Decision

1. **The fold groups by turn.** `toProjectChatItems` (src/lib/api.ts) folds
   everything between two `message.user` events into ONE `AssistantTurnItem`:
   - `working: WorkingEntry[]` — thoughts (with measured `thinkingMs`),
     interim narration, tool calls, and approval exchanges, in order;
   - `finalText` — the content of the last non-empty assistant event WHEN no
     `tool.use` follows it ("text after the last tool call"); a turn that ends
     on a tool call is working-only (`finalText: ""`);
   - turn-level stats (the R35 stats-carrier merges here);
   - user items ALWAYS render (failed turns never swallow the user's message);
     a turn with no working AND no finalText is dropped.
2. **The Working section is borderless and minimal** (WorkingSection.tsx):
   a muted header — `Working · mm:ss` (live, counting up) / `Worked for Ns ·
   N actions` (done) — over one-line expandable rows: ThoughtRow ("Thought
   for Ns" + one-line preview; auto-expanded while streaming, auto-collapsed
   when the thought completes unless the user tapped), ToolLine (verb label +
   mono args + status glyph; expands to the diff/terminal/output detail), and
   ApprovalRow. No card chrome, no icon tiles, no Sparkles.
3. **The final answer renders OUTSIDE the section** — collapsing the work
   never hides the answer (owner's explicit requirement).
4. **The live view builds the same shape**: the streamed text renders below
   the section as the presumptive final; a `tool-call` flushes it INTO the
   section as narration. R35 review fixes #2 (StrictMode immutability) and #6
   (orphan tool-result restore) are preserved verbatim in the new reducer.
5. **thinkingMs** is measured in the runtime (first reasoning delta → first
   text delta) and persisted on the assistant payload; old sessions render
   the duration-less "Thought" fallback.
6. **Width**: the focus-mode 900px cap is gone (soft 1500px readability cap);
   3-panel mode fills the freed Code-panel space with the chat (`codeVisible ?
   fixed : flex-1`).
7. **Sparkles is removed everywhere** (9 sites) — assistant messages carry no
   avatar and no name header; the empty state uses the approved AcuteLogo.

## Consequences

- `ProjectChatItem` is `{user} | {turn}` — the old `ai`/`activity` kinds are
  gone (AgentChatPanel was the only consumer; `itemKey`/ctx-meter migrated,
  the R33 stat-strip pass deleted as superseded).
- The Detailed/Compact/Hidden activity preference maps to section default
  open/closed/not-rendered; the mode popover moved to the section header.
- The sessions screen (`ChatView`) still uses its own fold — deferred (see
  R37-PLAN §8).
