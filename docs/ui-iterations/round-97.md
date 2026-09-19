<!-- last-reviewed: 2026-09-19 round-108 -->
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
5. **Failures must still report tokens**: "if a model fails, then it does
   not show me the total number of tokens sent, total number of tokens
   received… It should show that info properly." — `ErrorTurnItem` carries NO usage
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

DELIVERED (commit 768a0e2). The payload (`lib/menu-overlay.ts`) grew the full
visual vocabulary: the category palette (`usageSegmentHex` — one shared
mapping; Messages rides the theme accent, the rest fixed distinguishable
hues, "reserved" the dimmed output-reserve block), `UsageContextBarPayload`
+ `UsageDonutPayload` + the session TABLE + per-line mini-bar fields
(`barFrac`/`barColor`), and the height estimator's context-bar/donut/table
arithmetic. The BUILDER (`ContextDonut.buildUsageCardSections`) now emits:
the donut header block (projected/estimated/measured/model + the SESSION COST
headline with turns/calls — the owner's "show the proper price" ask), the
segmented context bar (six category segments + the reserved block + usedPct),
the breakdown rows with palette dots + mini-bars, the cache hit-rate bar, and
the session TABLE (Group/Turns/Calls/Sent/Received/Cost per
Main/Sub-agents/Combined — the full split, compacted; nothing hidden). The
OVERLAY renderer (`MenuOverlayApp.UsageCard`) paints the donut ring + header
lines, the segmented bar with flanking compact counts + hatched reserved
block + per-segment tooltips, the dotted/mini-barred lines, and the grid
table — with the Cursor-style MUTUAL HOVER-HIGHLIGHT (a segment lights its
breakdown row and vice versa, the others dim). The DOM popover (web mode +
the fallback leg) renders the SAME context bar + the same mutual highlight —
the two views stay twins. Tests: the payload contract pins (the donut header
lines, the table rows incl. the pre-R83 em-dash honesty, the
segments/barColor pairing, usageRingColorKey grading), the estimator's
arithmetic pinned both ways (5 lines beat the 54px floor; 2 lines keep it),
the palette resolution pinned; the ladder test re-pinned to the visual
payload.

## §4 Workstream D — the thinking-loop settings + the non-error presentation

DELIVERED (commit d1939d2). The STORAGE domain (storage/settings.ts):
`ThinkingLoopSettings {enabled (DEFAULT FALSE per the owner's explicit
directive — "By default it will be turned off so that the model can think as
much as it needs to"), stallSeconds 30–600 default 120, reasoningBytesKB
8–256 default 24}` + get/set with the setRetrySettings partial-patch
pattern + clamped reads (a corrupt row never arms an impossible guard). The
ROUTE: GET/PUT /settings/thinking-loop (validated; field-named 400s). The
WIRING: the streamed runtime reads getThinkingLoopSettings per turn and
threads `thinkingLoop {enabled, stallMs, reasoningBytes}` into
streamAiSdkChat — `enabled:false` (or absent) → NO watchdog at all (the model
thinks freely); `enabled:true` → the owner's OWN thresholds replace the R95
hardcoded pair. The PRESENTATION (the owner: "should not be shown as errors
like generation failed… highlighted in a separate way"):
`ThinkingStoppedCard` — amber (never red), `role=status` (never alert), a
Brain icon (never the warning triangle), "Thinking stopped by the guard"
(never "Generation failed"), the explanation + the Settings → General pointer
+ Retry; wired at BOTH render sites (the folded error item + the live stream
error) for `errorClass === "thinking_loop"`. The SETTINGS UI: the General
tab's `ThinkingLoopCard` (the RetryConfigCard pattern) — the master switch +
the two threshold inputs (disabled while off — the honest posture), the
footer line explaining the semantics. Tests: agent-core +13 (the storage
domain pins: defaults=OFF, partial patches, 400s, clamped reads; the route
pins incl. the 401 wall; the R95 watchdog suite re-pinned to the ARMED
config with the owner-reversal citation + FOUR new default-off/
custom-threshold tests: absent-config completes the stream that used to
throw, enabled:false never fires, a 60s/8KB guard catches what 120s/24KB
would not, a 600s/256KB guard tolerates what the defaults catch); frontend
+3 ThinkingStoppedCard pins (role=status + NO "Generation failed", the
Settings pointer + model chip, the Retry wiring).

## §5 Workstream E — the failure usage truth

DELIVERED (commits 95ef983 + the R97-J M2/m7 completion). chat.ts: every
error leaving `streamAiSdkChat` carries the SO-FAR usage on a symbol property
(`readStreamPartialUsage` — null for 0/0, never a fake "0 sent"): the wrap
covers mid-stream error parts, SDK iterator throws, AND the post-loop
truncation error. The runtime's terminal error path: `failedUsage` =
completed iterations' totals + EVERY failed attempt's streamed-so-far (the
R97-J m7 fix: the catch accumulates `readStreamPartialUsage` per attempt
before any retry branch — a ladder whose attempt 1 streamed 50K tokens and
died no longer reports only the instant attempt-2 death; pinned by the
six-attempt ladder test), riding BOTH the persisted turn.error payload AND
the SSE error frame's details. The frontend: `TurnErrorInfo`/`ErrorTurnItem`
gain `usage` (the live + the folded legs both map it defensively); the
TurnErrorCard renders the "X sent ↑ · Y received ↓" chip (`data-error-usage`)
+ the Copy-details block carries the lines. Tests: the adapter pins (4) +
the RUNTIME contract pins (3 — the real `streamAiSdkChat` rides as chatStream
with only the AI SDK mocked: the auth-class mid-stream failure carries
1500/120 on BOTH the persisted payload and outcome.details (the SSE frame
spreads it verbatim); the no-spend failure stays undefined on both surfaces
(never fabricated zeros); the LADDER pin — attempt 1 streams 1200/80,
attempts 2–6 die instantly, the full burn survives with attempts: 6) + the
fold pin (payload.usage → ErrorTurnItem.usage incl. the malformed-object
guard) + the chip pins on BOTH legs (folded 3.8k/460, live 1.5k/120 — and NO
chip without usage).

## §6 Workstream F — thinking markdown + syntax colors

DELIVERED (commit 3657abf + the R97-J m4 completion). prismjs (MIT, audit
clean) + `src/lib/highlight.ts` (27 grammars incl. the markup-templating dep
prism-php declares); CodeBlock renders Prism token spans through the app's
OWN design-system palette (light+dark, no Prism CSS); the THINKING body
renders fenced blocks as REAL CodeBlocks (`splitThinkingFences`,
streaming-safe). The R97-J m4 fix: the per-line split — `highlightLines`
walks Prism's TOKEN STREAM (never the output HTML — tokens span newlines)
and re-opens the enclosing token classes on each continuation line, so
highlighted blocks render the SAME numbered rows as the plain fallback
(the R97-F single-`<code>` render had silently dropped the line-number
gutter) and both paths wrap identically. Tests: +10 (the fences split, the
highlight round-trips, the unknown-language fallback, the per-line re-opened
token classes, the gutter's structural pins).

## §7 Workstream G — the browser settings + integration

DELIVERED (commit 7047597 + the R97-J M1/m6 fixes). The BACKEND domain:
`BrowserSettings {searchEngine (duckduckgo/google/bing/brave, default
duckduckgo), homepage (default acute://home), defaultZoom (0.25–3
fractional, default 1), quickLinks (1–12 editable links, default the R87
trio)}` + GET/PUT /settings/browser (validated; the fractional zoom read;
corrupt rows read back defended). The SETTINGS TAB (id `browser`, the
Sidebar row + the deep link + the BrowserTab): the engine picker, the
homepage input, the default-zoom stepper, and the quick-links editor
(add/edit-on-blur/remove, 12 cap) — the RetryConfigCard pattern. The PANEL
WIRING (no dead settings): the address bar's query fallback uses the
SETTINGS engine; the quick-links row renders the SETTINGS list; the new HOME
button navigates the homepage. The R97-J M1 fix (the review's only
must-fix): the HOME button now WORKS in both modes — the tab slice carries
`homeView` + `homeAnchorUrl`: the 4s poll's re-adopt is suppressed for the
page we left (the pre-fix web mode flashed home ≤4s then bounced back;
native mode never showed it at all — the webview painted over the DOM),
re-engages when the server lands on a DIFFERENT URL (an agent navigation
the instant SSE frame missed), and the panel HIDES the native webview while
home is set (webviewHidden + the R91 visibility watchdog both respect it).
The R97-J m6 fix: the default-zoom pristine sentinel is the store-persisted
`zoomTouched` flag (set by any explicit zoom) — a user-shaped 1.0 zoom is
no longer indistinguishable from "never touched" (the old value sentinel
re-applied the default on every panel remount). Tests: 7 storage/route pins
(the defaults, partial patches, the four-engine validation, the zoom
bounds, the quickLinks shape, the corrupt-row reads, the 401 wall) + the
panel test re-pinned (the settings fetch joins the mount; the mint is the
first /browser/session POST).

## §7a Workstream H — the chat window's customizability

DELIVERED (commit 8a7895e). The STORE (theme-store.ts): `ChatTextSize`
(small/medium/large, default medium = the pre-R97 sizes byte-identical) +
`TimestampsMode` (hidden default / hover), persisted via the existing
zustand persist. The TEXT-SIZE LADDER: one CSS var (`--ac-chat-scale` on the
transcript root, `data-chat-size` attr) scales the three READING surfaces —
`.chat-prose` (the answer text: final + interim + live stream),
`.chat-thinking` (the thinking block), `.chat-narration` (the interim
narration rows) — capped at ±12% (0.92/1.12) so the layout rhythm never
breaks; medium renders NO css at all. The TIMESTAMPS: `TimestampChip` — the
hover-revealed 10px-mono time chip in the same visual language as the
error/stopped/queued cards, joining the user bubble's hover-actions cluster
AND the turn footer's meta row; today renders the clock alone, an older day
prefixes its short date ("Aug 26 · 10:00"); default hidden keeps the clean
look; reveals on keyboard focus-within too (the R97-J n2 fix). The SETTINGS
UI (Appearance): "Text Size" + "Timestamps" sections (the Tool-activity
card pattern extracted into the shared `ChoiceCard` — the R97-J m8 fix
migrated the original section onto it too; the tab is FIVE sections now,
pinned). Tests: +5.

## §7b Workstream I — the state-awareness sweep

DELIVERED (commits d5803cd + 1e7a715 + 40c164b + ce9bcf0). The audit (a
dedicated subagent) ranked the gaps; the sweep killed the top nine:

- **THE CHAT'S FALSE GREETING (the audit's #1+#2)**: the transcript now
  renders its honest states — `chatHistoryLoading` (the sessions list OR
  the session log in flight) holds a chat-shaped `TranscriptSkeleton`
  (alternating accent-tinted user bubbles + subtle assistant lines, stacked
  toward the composer, `role=status "Loading conversation"`); a fetch
  failure with nothing to render shows the retryable `ChatLoadErrorCard`
  (`role=alert`, the danger token, Retry re-drives both queries); a
  populated transcript ALWAYS wins (a background-refetch failure keeps the
  messages). The false "Create an agent in Settings first" flash while
  agents load is dead (gated on `!isPending && !isError`).
- **The shared primitives** (`src/components/shared/Skeletons.tsx`):
  `SkeletonBlock` + `SkeletonRows` — one spelling for the DESIGN-SYSTEM §6
  loading rule; decorative (aria-hidden), themed (`styles.subtle`).
- **The sidebar**: the false "Add your first project" is dead — skeleton
  rows in the real row geometry while loading, a retryable error row on
  failure (its Retry re-drives both queries), the true empty state only
  when settled; the minimized rail skeletons its tiles.
- **The dashboard**: the stat row NEVER paints false zeros — four
  StatCard-shaped skeletons until every source settles (usage rides
  isFetching: demo-idle is settled, not loading); the loadError banner
  includes a failed usage/projects fetch (the R97-J m2 fix) and is RETRYABLE.
- **ProjectView**: a fetch error is no longer "Project not found" — the
  honest retryable card, gated by the populated-wins rule (the R97-J m1
  fix).
- **The five General-tab settings cards**: a failed GET hung on "loading …
  settings…" FOREVER (the `isLoading || current === undefined` gate
  swallowed errors) — each card now renders `SettingsLoadErrorCard` (the
  cause + Retry) inside its own testid'd section; the amber `warning` token
  joined SEMANTIC_COLORS + DESIGN-SYSTEM §1; ChatView's banned
  string-suffix alpha hexes and SettingsPage's divergent `#e5484d` red ride
  the tokens.
- **UsageScreen**: the error banner is retryable.
- Tests: +17 (the skeleton holds the column while `list()` hangs; the error
  card replaces the greeting on rejection + Retry recovers; the sidebar/
  rail/dashboard/project-view/usage gates; the settings 401 → honest error
  + Retry recovery; the primitives' pins) + 7 honest re-pins (the
  layout/composer harnesses await the READY state — the greeting renders
  only after the queries settle).

## §7c Workstream J — the review pass

DELIVERED (commit 14e7... the R97-J commit). A dedicated review agent
audited `git diff 19b2640..HEAD` (11 commits, +5070/−390): verdict
SHIP-WITH-FIXES — zero blockers, 2 majors, 8 minors, 6 nits. EVERY finding
was fixed and pinned before release: M1 (the HOME button — see §7), M2 (the
usage contract's runtime+frontend halves — see §5), m1 (ProjectView's
populated-wins gate), m2 (the dashboard's usage-only false zeros), m3 (28
amber literals → the warning token + the overlay ringHex), m4 (the code
gutter — see §6), m5 (the threshold steppers commit on blur/Enter via
`CommitNumberInput`), m6 (the zoomTouched sentinel — see §7), m7 (the
ladder's per-attempt usage accumulation — see §5), m8 (the ChoiceCard
dedup), n2 (the TimestampChip focus reveal). The verified-clean list:
the watchdog's default-off semantics, the symbol leak impossibility, the
CSS var plumbing, the greeting truth table (no blank column reachable, no
populated transcript flips to skeleton), the a11y of every new surface, and
the non-vacuity of the round's tests.

## §8 Verification (the full pipeline)

| Gate | Result |
|---|---|
| `pnpm lint` | clean |
| root `tsc --noEmit` + agent-core `tsc --noEmit` | clean |
| Full root suite (`pnpm test` — frontend + e2e) | 3,498/3,498 (186 files) |
| agent-core suite | 2,255/2,255 (111 files) |
| Round-focused suites | every touched file green individually (see each §) |
| docs:check | 204/0/0 (stamps refreshed) |
| version:check ×4 manifests | 0.95.0 all agree |

## §9 The owner's TEST CHECKLIST (what to try on v0.95.0)

Mirrors §0 item for item:

1. **The context popup**: hover the composer's total-token usage → the card
   opens in the menu-overlay window. The TOP of the card is the Kilo-style
   SEGMENTED BAR (one segment per category, compact counts flanking, the
   dimmed reserved block). Below it: the donut + the SESSION COST headline
   (turns/calls), the breakdown rows (palette dots + mini-bars), the cache
   hit-rate, and the session TABLE (Main / Sub-agents / Combined ×
   Turns/Calls/Sent/Received/Cost). Hover a bar segment → its row lights
   and the others dim; hover a row → the segment lights. NOTHING is hidden
   behind hover that isn't also visible in the card's sections.
2. **The thinking loop**: Settings → General → "Thinking-loop guard" — the
   switch is OFF by default (a fresh install's model thinks freely, no
   guard). Turn it on → the stall-seconds + reasoning-KB inputs arm; type
   `5` then `5` — the value commits on blur/Enter (no mid-typing PUTs).
   When the guard fires, the card is AMBER with a brain icon, "Thinking
   stopped by the guard" — never red, never "Generation failed" — with a
   Settings pointer + Retry.
3. **A failed turn's tokens**: make a turn fail (a bad key, a dead
   provider) → the error card shows the chip "3.8k sent ↑ · 460 received
   ↓" (whatever was actually spent, including retried attempts) + Copy
   details carries the numbers. A turn that spent nothing shows no fake
   0/0.
4. **The chat's customizability**: Settings → Appearance → Text Size
   (Small/Medium/Large — the answer, thinking, and narration scale
   together; Medium = the old look exactly) + Timestamps (Hidden / On
   hover — hovering a message reveals the time chip; today shows the clock,
   an older day shows "Aug 26 · 10:00").
5. **Thinking code blocks**: ask the model something that makes it think
   in code → the thinking area renders FENCED CODE with REAL syntax colors
   (the app's own palette, both light + dark) AND line numbers — same rows
   as any other code block.
6. **State awareness**: open a project with history → a chat-shaped
   skeleton holds the column (no more greeting-then-flash). Kill the
   sidecar → the honest "Could not load this conversation" card with Retry
   (never a cheerful empty chat). The sidebar never flashes "Add your
   first project" while loading; the dashboard never paints "0 Projects"
   zeros; a failed settings fetch shows the error + Retry instead of
   hanging on "loading…".
7. **The browser's settings home**: Settings → Browser (its own sidebar
   row): the search engine, the homepage, the default zoom, the editable
   quick links — all wired (the address bar's query fallback, the
   quick-links row, the HOME button). **The HOME button works now**: click
   it → the quick-links screen appears (and STAYS — the poll no longer
   bounces back); click a link or type an address → browsing resumes. The
   agent navigating (or any real navigation) still takes over the tab.
8. **The default zoom**: set it to 1.5 → NEW browser sessions start at
   150%; a tab you zoomed yourself is never re-zoomed.

*(The round's commits: 73bce1c the plan, 768a0e2 C, d1939d2 D, 95ef983 E,
3657abf F, 7047597 G, 8a7895e H, d5803cd + 1e7a715 + 40c164b + ce9bcf0 I,
the R97-J review-fix commit, and this docs commit.)*
