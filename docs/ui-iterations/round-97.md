<!-- last-reviewed: 2026-09-14 round-97 -->
<!-- round: 97 -->
# Round 97 — the context-popup + thinking-freedom + UI-quality round (v0.94.0 → v0.95.0)

The owner's eighth walkthrough report (v0.94.0): at first look everything works,
but six areas need real care. This round's contract is below, itemized from his
message; every item is answered by a workstream with a root cause verified in
the tree.

## §0 The owner's report, itemized (the round's contract)

1. **The context-window popup regressed**: "When I tapped it previously it
   showed me a much better, detailed, well-formatted, well-handled, and
   properly structured one but apparently currently it does not show me that
   kind of view." — R96-G moved the popover into the menu-overlay window as
   a PLAIN label/value card (`buildUsageCardSections`): the DOM popover's
   visuals (the big donut, the breakdown mini-bars, the full session rows
   with tokens sent/received AND cost) never crossed the payload boundary.
   The owner wants it well-formatted with visuals, proper section separation,
   the session price shown, and NOTHING hidden. — workstream C.
2. **The Kilo-style stats bar**: "In the Kilo Code at the very top, it shows
   the stats of the various things used, the tokens used for, and such, in bar
   format. I kind of like that format and I would like you to implement that
   kind of format in our application but in the context window popup" —
   a segmented usage BAR at the top of the popup. — workstream C (research:
   workstream A2's Kilo/Cline/Cursor survey, §1a).
3. **The thinking loop must not cage the model**: "Currently the thinking
   loop is quite bad and it does not allow the model to think as it needs
   to… we should give the user the option in the settings to turn it on or
   off. By default it will be turned off." + "give the user the option and
   flexibility to edit the thinking loop management." — the R95-E watchdog
   (120s/24KB, hardcoded) becomes a Settings domain, DEFAULT OFF, thresholds
   editable. — workstream D.
4. **Thinking-loop stops are not errors**: "The thinking loop stopping and
   other things like that should not be shown as errors like 'generation
   failed.' These should be highlighted in a separate way." — today a
   ThinkingLoopError renders the RED TurnErrorCard. It becomes a distinct
   amber "thinking stopped" presentation. — workstream D.
5. **Failures must still report tokens**: "if a model fails, then it does not
   show me the total number of tokens sent, total number of tokens received…
   It should show that info properly." — `ErrorTurnItem` carries NO usage
   fields today; the SSE error frame neither. — workstream E.
6. **The chat window: functionality, usability, customizability** + "in the
   thinking, if it shows a code block, then that code block should clearly be
   highlighted… formatted in colors" — the thinking area renders PLAIN TEXT
   today (`whitespace-pre-wrap` mono); `CodeBlock` has NO syntax coloring.
   — workstreams F (thinking markdown + syntax highlighting) + H (chat
   polish).
7. **The UI is too simple / "AI slop"**: "I want a modern, clean, beautiful
   UI… I don't want you to just outright build things directly in terms of
   the UI. I want the UI to be adaptable. I want the UI to be aware of its
   states." — NOT a big-bang redesign: a state-aware quality pass over the
   design system + the highest-visibility surfaces (distinct
   loading/empty/error/ready states, consistent depth/borders/hover,
   micro-interactions, typographic rhythm). — workstream I.
8. **The browser is not integrated + no settings home**: "The inbuilt
   browser is still not handled properly… it is ugly… It does not feel like
   part of our application… add a dedicated section in the settings for the
   browser." — there is NO Browser tab today (10 settings sections, none
   browser); BrowserPanel (2,072 lines) needs the integration + polish pass.
   — workstream G.
9. **Research before building**: "learn some things from Kilo Code too,
   learn some things from the client [Cline] too… Do it with proper
   research, understanding, verification, testing." — workstream A2
   (delivered: §1a).
10. **Discipline**: regular progress notifications, subagent review passes,
    quality over speed, document everything. — workstreams J/K (continuous).

## §1 Workstream map (with the root-cause notes from the survey)

| ID | Scope | Root cause / plan |
|---|---|---|
| A2 | Research: Kilo/Cline/Cursor context UIs | DONE — see §1a. Kilo: 3-segment bar (used / reserved-for-output / available), 4px, compact counts flanking, red ≥50%, hover tooltips. Cursor: ring → breakdown tray, SEGMENTED BAR + category list with MUTUAL hover-highlighting. Cline: hover accordion (Used/Total/Remaining + prompt/completion/cache rows). Cline REMOVED click-on-bar-to-set-threshold (accidental compaction) — we will not add it. |
| B | This plan | round-97.md + the TODO board + per-stage ntfy pings |
| C | The context popup overhaul | `buildUsageCardSections` builds plain label/value lines; the overlay `UsageCard` paints them. REBUILD the payload: segmented context bar (one segment per breakdown category + reserved-for-output + free track), donut, per-row mini-bars, session TABLE (Turns/Calls/Sent/Received/Cost per Main/Sub-agents/Combined), the note footer. The overlay renderer + height estimator grow the visual kinds. The DOM popover gains the SAME segmented bar (parity). |
| D | Thinking-loop freedom + presentation | New `thinkingLoop` settings domain (enabled: boolean, DEFAULT FALSE; stallSeconds 30–600 default 120; reasoningBytesKB 8–256 default 24) — storage/settings.ts + GET/PUT /settings/thinking-loop + the shared type. chat.ts's watchdog reads the runtime-threaded config (input.thinkingLoop); runtime reads getThinkingLoopSettings(db). Presentation: `thinking_loop` renders a NEW amber "Thinking stopped by the thinking-loop guard" card — NOT TurnErrorCard, no red, no "Generation failed" — with the Settings pointer + what happened + the partial output kept. |
| E | Failure usage truth | The streamed adapter accumulates stepInput/stepOutput but the error path drops them. Thread the partial usage onto the error frame (SSE) + `ErrorTurnItem` (shared + api.ts mirror) + render tokens sent ↑/received ↓ in TurnErrorCard (and in Copy details). |
| F | Thinking code blocks + syntax colors | The thinking body switches from plain mono text to the markdown renderer (ChatMarkdown variant, muted), so fenced code renders as CodeBlocks; CodeBlock gains REAL syntax highlighting (prismjs, MIT — the license audit allows) themed to light/dark via the design system. |
| G | Browser settings + integration | New Browser settings section (id `browser`, sidebar + SettingsPage + deep link): default search engine, homepage, default zoom, quick links (editable), new-tab behavior — all WIRED to BrowserPanel behavior (no dead settings). The BrowserPanel toolbar/tabs get the design-system polish pass (the "part of our application" feel). |
| H | Chat window polish | Chat text size (Appearance, S/M/L → CSS var), timestamps toggle, message hover affordances audit — small, real, wired. |
| I | UI quality pass | State-awareness sweep (loading/empty/error/ready) over the highest-visibility surfaces + depth/hover/micro-interaction consistency per DESIGN-SYSTEM.md; NO big-bang redesign (the owner's adaptable/state-aware directive). |
| J | Subagent review | A review agent audits the round's diffs for defects (the owner's standing directive), findings fixed before release. |
| K | Docs + release | round-97.md completed, CHANGELOG 0.95.0, status.json, HANDOFF, ORCHESTRATION-WORKLOG, README index, version ×4, push/CI/release, DASHBOARD data.json, the ntfy close-out. |

### §1a The research verdict (workstream A2 — what the bar should be)

- **Kilo's ContextProgress** (the owner's named reference): a 3-segment
  horizontal bar — used (solid; red ≥50%), reserved-for-output (dimmed),
  available (track) — 4px tall, compact token counts flanking (`1.2K`
  style), 0.3s ease width transition, hover tooltip: used/reserved/available.
- **Cursor's breakdown tray**: the ring CLICK opens a tray with a segmented
  bar + category list; **hovering a segment highlights the matching row and
  vice versa** — the cross-highlight interaction we will mirror.
- **Cline's accordion**: Used/Total/Remaining + Token Usage (↑prompt,
  ↓completion, ←cache writes, →cache reads) — monospace numbers.
- **The anti-pattern to avoid**: Cline SHIPPED click-on-bar-to-set-compact-
  threshold and REMOVED it (v3.65.0) after accidental clicks silently set
  aggressive compaction. We link to Settings instead of embedding the
  threshold control in the popup.

## §2 Verification plan (the round's gates)

- Unit/type/lint: `pnpm lint` + both typechecks + the full vitest suites
  (frontend + agent-core) green with our own eyes before every push.
- Per-workstream focused suites: the new payload builder pins (segments
  math, table rows, threshold colors), the settings domain pins (defaults,
  clamping, 400s), the error-usage pins, the thinking-markdown render pins,
  the prism highlighting pins (light + dark themes).
- Browser verification for every UI change (agent-browser screenshots of the
  popup, the thinking card, the settings tabs; the VLM pass for the surfaces
  that changed).
- The owner's TEST CHECKLIST in §9 mirrors §0 item for item.

## §3 Workstream C — the context popup overhaul (the Kilo-style bar)

(to be completed with the implementation evidence)

## §4 Workstream D — the thinking-loop settings + the non-error presentation

(to be completed with the implementation evidence)

## §5 Workstream E — the failure usage truth

(to be completed with the implementation evidence)

## §6 Workstream F — thinking markdown + syntax colors

(to be completed with the implementation evidence)

## §7 Workstream G — the browser settings + integration

(to be completed with the implementation evidence)

## §8 Verification (the full pipeline)

(to be completed at close-out)

## §9 The owner's TEST CHECKLIST (what to try on v0.95.0)

(to be completed at close-out)
