<!-- last-reviewed: 2026-09-23 round-120 -->

# Patterns — Chat (the WhatsApp-inspired conversation)

Files: `mobile/app/session/[id].tsx`, `src/components/composer.tsx`,
`src/components/transcript.tsx`. Round-115 rebuilt the anatomy around a familiar
grammar: **an identity header, a clean transcript, and a minimal dock.**

## Header — the identity bar

```
[ ← back arrow ]  [ project letter avatar ]  Project name        [ kebab ⋮ ]
                                               session name
```

- Avatar: the project's letter avatar (color + first letter) — the conversation's "DP".
- Title = project name (`TypeBodyStrong`), subtitle = session name (`TypeCaption`,
  tertiary, one line). The session's own title demoted to the subtitle — the project
  is the identity, the session is the context.
- Status moves OUT of the header text (no more "a turn is live · code · model" line).
  The right side is the **kebab menu**.
- **Back = the arrow (R118-D):** `QuietIconButton` 40 with `ArrowLeft 22` — never the
  chevron bracket (the owner's call; donts #6) — with a real 8dp gap to the avatar.
- **The bar renders as chrome (R118-D):** a header column filled `surfaceHeader`
  (bg +6% warm ink light / +30% black dark) pulled up through the status-bar inset
  (negative margin + paddingTop), a hairline `borderSubtle` separator at its bottom
  edge, and the live line pinned absolutely OVER that edge — the breathing accent
  bar replaces the hairline while a turn runs (its 550ms rhythm unchanged).
- **Kebab menu (R118-D):** the anchored panel carries the session controls as
  IN-PLACE sub-levels — Operating mode · Model · Thinking level · Context usage (+
  Stop turn while live). Main rows show the CURRENT value; a tap opens the level
  INSIDE the panel (back chevron + title row; selected rows carry the accent Check;
  Context is a read-only readout that stays at its level). Picks **apply and return
  to main** — the feedback loop closes where the owner will look. The composer
  carries NONE of these controls; there are no sub-sheets. (The model-level
  content spelling is superseded — see the provider accordion below.)
- **The two-step stop (R118-D):** the Stop row never fires one-shot — the first tap
  arms it ("Stop this turn" → "Do you want to stop?" flipped in place); the second
  tap stops; the armed state resets on menu close and when the turn dies.
- **The level swaps animate (R119-B):** the owner asked for "some animation while
  switching between the menus" — the panel's BODY (title row + content) is keyed
  by level and swaps with a **directional 12dp slide + crossfade**: drilling in,
  the new level enters from the RIGHT (180ms ease-out) while the root mirrors out
  LEFT (120ms); going BACK reverses it — the sub-level exits RIGHT the way it came
  in. The direction derives from level DEPTH (root = 0, every named sub-level =
  1), never a hardcoded per-menu flag; reduced motion = the plain 120ms fade. The
  panel's own entrance (spring 0.96→1) and exit fade are untouched —
  `PANEL_WIDTH 220` / `ENTRANCE_SCALE 0.96` / `EXIT_FADE_MS 120` stay frozen
  (`motion.md` §4.12).
- **The model level is a provider ACCORDION (R119-B):** the owner's ask — the
  model list "will show me only the provider names by default." ONE row per
  configured provider (its display name + the right-aligned "{n} model(s)"
  caption + ChevronRight; `accessibilityState expanded`); tapping a provider
  expands THAT ONE section beneath it — **one open at a time**, the previously
  open section closes; the expanded rows are one-line model names with the accent
  Check on the selected one; tapping a model **applies and returns to main** (the
  R118-D grammar). The open section dies with the keyed level body's unmount
  (close and back both reset it); the expansion is a 150ms content fade (reduced
  motion snaps); the list scrolls at maxHeight 360; the busy/empty/offline
  captions stay. And the level renders **no root rows of its own** — the explicit
  empty branch means the Mode/Model/Thinking/Context rows can never trail beneath
  the provider list (the owner's exact defect report: they rendered at the BOTTOM
  of the model list).
- **The avatar's live edge (R120-CM):** while a turn runs, the header avatar
  wears a 2dp accent ring breathing on the DELIVERY-EDGE rhythm —
  `mixHex(surfaceHeader, accent, 0.34↔0.62)` on the house 550ms legs
  (`LIVE_LINE_LEG_MS` + the transcript's exported `DELIVERY_EDGE_*` constants —
  the delivery-edge rhythm by construction), the static 0.55 mix under reduced
  motion, drawn OUTSIDE the avatar's own 36px box (inset −3) so the header
  layout never shifts; **NOTHING at rest** (`motion.md` §5). It is chrome, not a
  control — `pointerEvents` none + a11y-hidden. No glow, no spinner (donts
  #11/#14): the breathing ring is the sanctioned alive-but-calm idiom.
- **The Task list level (R120-P, item 33):** the owner's ask — "The kebab menu
  gains a **separator + 'Task list' option at the bottom**." The root level
  carries the strong-rule SEPARATOR row (HeaderDropdown's optional `separator`
  flag — the R118-B strong inset `Hairline`, 1dp `borderStrong` inset by the
  gutter) over the live-valued "Task list — {done}/{total}" row; the tasks level
  is the anchored panel's own level grammar (back-chevron + title row, scroll
  cap 320) with **CHECKABLE rows** — 15dp square r4 checkbox (success fill +
  white Check when done, the accent dot while the agent works it, line-through
  on done), the done/total-or-error footer line, a11y role checkbox,
  busy-disabled guard — through `POST /sessions/:id/todo` (optimistic flip,
  rehydrate catch-up, honest failure revert). The rows are CHECKABLE, not
  read-only, because the R88 owner-write route exists (max 30 items /
  200-char content / status enum validated server-side).

## Composer — the minimal dock

```
[ message input (grows to 6 lines) ]  [ + attach ]  [ send ● / stop ◼ ]
```

(R119-B: the input sits LEFT of the attach circle in every state — the diagram's
order is the law. R120-P supersedes the geometry: the attach control now DOCKS
INSIDE the input's own surface — see the docked-control law below.)

- **Exactly three controls.** The control pill row is deleted; the mode/model/
  thinking/context picks live in the kebab's in-place sub-levels (R118-D).
- Attach opens the existing "Add context" sheet (Attach a file / Choose from project) —
  unchanged behavior, polished rows. The control itself is the **attach circle**
  (R119-B — see the single-tier law below; R120-P supersedes the BESIDE clause:
  the paperclip's 40dp quiet circle DOCKS INSIDE the input's surface now).
- Send: circular accent button. While a turn is live: an **icon-only stop** (R118-D)
  — a 50px circle with a 1dp danger border and the Square glyph, no text label —
  which opens the **centered confirm dialog** before stopping (`components.md`
  §Dialogs); and a **conditional queue** button that renders ONLY when there is
  something to send (draft or attachments) — an always-mounted disabled arm is a
  control without content.
- **Input growth is native (R118-D; cap amended R119-B):** minHeight 44 → maxHeight
  **146** (6 lines; `6×21 + 2×10` — the R118-D cap of 176 was `6×21 + 10 + 40`,
  the last 40 being the band the single-tier law deleted), no controlled height, no
  `flex:1` desync — the field scrolls past the cap. The focus ring is **1.5dp** (a
  hairline whisper is not a ring).
- **The single-tier law (R119-B — SUPERSEDES the two-tier attach geometry; its
  ROW grammar stands, its BESIDE clause superseded by R120-P's docked-control
  law below):** the
  owner's verdict — "the text would be typed on the left side of the add file
  option, but apparently it was being typed above it," and the dock was "way too
  much taller in its height" at rest. ONE row in EVERY state:
  `[input (flex:1)][attach circle 40][send|queue|stop 50]`, `alignItems flex-end`
  so the circles ride the input's last line as it grows. The paperclip is its OWN
  40dp quiet circle BESIDE the input (RADIUS_ROUND, Paperclip 19, tertiary→accent
  on press, `hitSlop` 4) — never an absolutely-positioned overlay inside the pill,
  never a reserved band under tall text. The input's padding is CONSTANT (16
  horizontal / 10 vertical) — nothing reserves room. The dock's resting frame
  tightened 8/4 → 4/2. The pill→bar radius swap on tall stays.
- **The docked-control law (R120-P — SUPERSEDES the single-tier law's BESIDE
  clause; the owner's items 29+30, round-120 §1 H):** "The Add Context control
  sits OUTSIDE the 'Message the Agent' area — move it **inside, at the far
  right** of the input row," and "the text will **never overlap** with the 'Add
  Context' button." ONE row still — `[inputWrap (flex:1)][send|queue|stop 50]`,
  `alignItems flex-end` — but the 40dp paperclip control is ABSOLUTELY DOCKED
  inside the inputWrap at the input's BOTTOM-RIGHT corner: right inset
  `ATTACH_DOCK_INSET` 4, bottom inset `ATTACH_DOCK_BOTTOM_INSET` 2 (40 + 2×2 =
  44 centers it in the resting pill; it rides the input's last line when the
  input grows). **THE WRAP LAW:** the input's `paddingRight` =
  `ATTACH_DOCK_PADDING_RIGHT` = 4 + 40 + 8 (`ATTACH_DOCK_TEXT_GAP` =
  `spacing.sm`) = **52**, reserved on EVERY line — RN has no per-line float, so
  the owner's permissive "text CAN show above it" collapses to the reservation
  on all lines; the NEVER-OVERLAP guarantee is the hard law and holds by
  construction. `paddingLeft` stays 16, vertical padding stays 10/10, the cap
  stays 146, the pill→bar radius swap stays, the dock frame stays 4/2. The
  control: `RADIUS_ROUND`, Paperclip 19 / strokeWidth 2.2, tertiary→accent on
  press, `hitSlop` 4, testID `composer-attach`.
- **The @-mention menu ABOVE the input (R120-P, item 31):** the owner's ask —
  "Typing **@** opens a results menu ABOVE the input, filtering as the query
  continues." A plain sibling INSIDE the dock's column, rendered ABOVE the
  input row (lifted with the dock when the keys rise); it opens the moment an @
  token is ACTIVE and never vanishes on a bare "@": the busy row while the tree
  loads ("loading the project tree…" / "the host is offline" / "this session has
  no project"), "no files match" when empty, ≤8 live-filtered matches
  (`filterProjectFiles` — substring, case-insensitive) at maxHeight 176,
  `keyboardShouldPersistTaps` handled. Detection rides BOTH legs: `onChangeText`
  through `advancedCaret` (Android fires change BEFORE selection — a fresh "@"
  in an empty field read caret 0 and the menu never opened, the exact bug) and
  `onSelectionChange`'s authoritative re-detect. A pick strips the token, stages
  the chip (source "at"), fires `selectionHaptic`.
- **Attachment chips + the viewer pop-up (R120-P, item 32):** picked images
  carry `localUri` → a 28dp `RADIUS_PILL` thumbnail chip (project-read files
  keep the glyph — their bytes live on the host and never crossed to the
  phone); tapping ANY chip opens the **AttachmentViewer**: image → the
  transcript's full-screen ImageViewer, text → the centered clay card
  `min(520, w−40)` with the 60%-height scrollable selectable mono body + the
  honest "first 128 KB" caption, info → name + size + kind. Frozen motion:
  160ms scrim / 120ms exit / 0.96 entrance (scale→1, origin center — the
  centered-dialog grammar, `motion.md` §4.13). The chip's X keeps its own
  nested Pressable so a remove never opens the viewer.
- **The two-tier attach geometry (R118-D — RETIRED, deleted from the code by
  R119-B):** resting, the paperclip sat beside the line (paddingRight 52, pinned
  bottom-right); once tall, text took the full width above a reserved **40px attach
  band** under it. The owner rejected the tall state's geometry outright; the
  inputWrap/ATTACH_BAND/padding-swap are gone — recorded here so no round re-imports
  it.
- The dock owns the keyboard (see `session-screen.md` architecture in the wave spec:
  ADJUST_NOTHING + single animated paddingBottom expression; `keyboardDidHide`
  blurs the input so handles and selection clear — R118-D). **The bottom inset
  (R120-P, item 28):** the session screen's dock expression is
  `paddingBottom = max(insetsBottom, kbHeight) + COMPOSER_EDGE_BEAT` — the
  beat is `spacing.sm` 8: flat devices get the beat alone, home-indicator
  devices inset + beat, open keys keep the beat OVER the IME; the composer
  itself never pads its own bottom (R115-K's one-expression law). The dock
  never rides the device edge bare.

## Transcript — the message grammar

**User bubble (right):**

```
┌───────────────────────────┐
│ message text               │
│ [image thumbnail if any]   │
│ attachment chips           │
│                    14:32 ▾│   ← time INSIDE the bubble, bottom-right, 10px tertiary
└───────────────────────────┘
```

- Accent-tinted clay fill, r20 with a tighter bottom-right corner (16px — the WhatsApp
  tail hint), maxWidth 88%.
- Timestamp lives inside the bubble's bottom-right corner — never floating below.

**Assistant turn — SEPARATED ELEMENTS (R129 — SUPERSEDES R119-A's
single-container TurnBlock; the owner's device verdict: it "combines
everything together", the tool cards are "way too cramped", the thinking
"is combined with the tool cards", and the reply reads as a bubble —
"You should not utilize bubbles for the reply, but just directly writing
the text… like how most of the other modern ones handle it. It would give
us much more space."):**

The turn's elements render as SIBLINGS with real spacing — never inside
one shared clay container:

```
  Thinking ▾                              ← SEPARATE collapsible thinking row
  (mono-dim text behind the expand; 20-line cap + Show all)

  ┌──────────────────────────────┐
  │ ▸ icon  verb · target        │        ← TOOL CARD: one clay card per call,
  │ result line / [chip]         │          house card padding (12px), r12,
  └──────────────────────────────┘          8px gaps between cards
  ┌──────────────────────────────┐
  │ ▸ icon  verb · target        │
  └──────────────────────────────┘

  model · time                           ← meta line, only when content starts
  markdown content (streaming + caret)   ← THE REPLY — FLAT, full width,
                                           NO card, NO container, NO bubble
```


- **THE THINKING ROW is its own element** — a separate collapsible row
  ABOVE the tool cards and the reply, never inside a shared well with
  tool rows: the label ("Thinking…" live / "Thought for 8s" settled) +
  chevron; the dim mono text behind the expand (the retired
  ThinkingBlock's own voice — 20-line settled cap + "Show all"; live
  thinking never clamps, live-open). A turn with no thinking renders no
  row.
- **THE TOOL CARDS are proper cards** — one clay card per tool call with
  the HOUSE CARD PADDING (12px — not the well's cramped row insets),
  r12 (the tool-card corner — a local literal; the tokens ladder's RADIUS_CARD is 20, too round for a dense row), 8px vertical gaps between cards: icon + verb +
  target head line, the status/result line, the expandable body (the
  retired cards' content logic — the write family's streaming tail +
  "Wrote {file}" + `+A/−B` diff chips (the minus is the server's U+2212),
  the terminal family's output tail + exit summary, the read family's
  quiet one-liner, the generic fallback's humanized verb + target).
  Failed = the INLINE danger chip + the card's quiet danger wash;
  running = the small warning chip; success = NOTHING (the result rides
  the head line itself). Cards render OPEN by default (R123-W-m's law
  survives — the owner must SEE the work), each independently
  collapsible.
- **THE RAIL SURVIVES AS THE CARDS' SUMMARY** — the turn's ONE glance
  line ("Thought for 8s · 3 actions · `src/a.ts`, npm test" — the R120-CM
  hints law unchanged: the write family's file path, the terminal
  family's command, the read family's target, one hint per call
  (`toolHint`), ORDER-PRESERVING deduped (`toolHintList`), capped at
  `TOOL_HINT_MAX` 3 with the honest "+N more" tail; the hints ride BOTH
  the visible summary and the a11y label, pref-applied) renders ABOVE
  the cards as a plain tertiary line — NO container, no expand of its
  own. Live states unchanged: the breathing "Thinking…" (three
  staggered dots + the resolved model in micro mono) or the RUNNING
  tool's verb ("Reading a file…", the pure `runningToolWord` grammar) or
  "Writing…" — ONE line, never a thinking row AND a tool card stacked.
  A turn with no activity at all renders as the clean document — no
  rail. Breathing 0.85↔1 at 600ms legs only while the turn WORKS — once
  text streams, the shared LiveCaret owns the motion, never two
  breathing things for one state.
- **THE REPLY IS FLAT** — no card, no container, NO bubble: the meta
  line (model · time, 10px mono tertiary) above the first content chunk
  of the turn, the MarkdownText directly on the screen background, full
  width, the shared LiveCaret while streaming ("just directly writing
  the text… like how most of the other modern ones handle it").
- The item MODEL is untouched (the persisted fold + live reducer keep emitting the
  same `TranscriptItem` union; the grouping is a pure display memo) — new
  renderers must not fork the data model.
- **Retired as list items (R119-A → R129):** the standalone
  ThinkingPlaceholder card, the ThinkingBlock card, the AssistantBlock,
  and the single-container TurnBlock — their content logic lives in the
  SEPARATED elements (the thinking row, the tool cards, the flat reply).
  Interactive/terminal surfaces stay standalone: error, approval mini,
  question, todo, subagent, image, meta, debug.
- The toolActivity pref applies to the separated elements: hidden = no
  tool cards and the rail only while thinking text exists (the clean
  document — the summary never teases a count the cards will not show);
  compact = one-line cards, no expansion; detailed = the full anatomy.

**Queued user rows — after the in-progress turn, as a message (R119-A + R119-C):**

- The owner's mobile defect report: the queued message rendered "just below the
  first message" and only jumped to the right place when the model started
  responding. **THE LAW: a still-queued user row always renders AFTER the
  in-progress turn** (whose synthetic processing state lives in the live turn's
  elements)
  — never above it, never between a running turn and its reply. Delivered rows
  never move (the log flips queued → user in place). Both layers enforce it: the
  display memo's queued-after-turn partition and the remote-fold rebase.
- It renders AS A MESSAGE, never as a notification — the owner's PC verdict: the
  old banner "does not appear as a message, but rather as a notification or error
  message." The waiting state is CHROME around the bubble, never warning coloring
  on it: the same user-bubble idiom every sent message uses (PC: the plain
  `UserMessage` bubble at 0.75 opacity, the mono "queued" caption below + the
  hover-cluster Send-now/Remove; mobile: the dull sending rung of the delivery
  ladder). No amber, no bordered banner, no line-clamped pseudo-card.
- While a live overlay renders the in-progress turn, the persisted fold's copy of
  that same turn stays suppressed (the PC's `startedBySeq` anchor) — the owner's
  "exact same thought process… the exact same reply" double-render is dead by
  construction; the fold renders it exactly once at the handoff.

**Assistant message (left) — RETIRED spelling (R119-A; kept for the record):**

```
[model chip · time]           ← one micro meta line ABOVE, only when content starts
  markdown content
  [caret while streaming]
  [attachment/image renders if any]
```

- Full-width document style (no bubble) — it's a document, not a chat bubble.
- Thinking renders as the collapsible dim card ABOVE content, capped lines,
  live-open.
- Meta line: model + time, 10px mono tertiary — one line, above the first content
  chunk of the turn, not below.

(The meta-line-above-first-content and full-width document grammar SURVIVE inside
the TurnBlock's reply; the standalone thinking card above content does not — the
well owns thinking now.)

**Tool cards — RETIRED as list items (R119-A; the table's word grammar survives
as the TurnBlock's tool ROWS):** compact, one line per state:

| Tool | Idle/running | Done |
|---|---|---|
| write/edit file | "Writing {file}… {n} chars" + live tail preview | "Wrote {file} · {n} lines" + expand for diff-ish summary |
| terminal | "Running {cmd}" + streaming tail | "{cmd} · exit 0" + expand |
| read skill | **"Read skill · {name} · ✓"** — one quiet chip, never a full view | same |
| screenshot | image tile loading | inline image (rounded, tappable → viewer) |
| other | humanized verb + target + status | expand for details |

(The rows now render INSIDE the TurnBlock's well — one per call, the failed row's
inline danger chip + wash, the expandable detail behind the head line. The
read-skill "one quiet chip" special case collapsed into the normal row grammar:
"read skill · {target}".)

- Tool activity prefs (detailed/compact/hidden) still apply — inside the block
  (see the TurnBlock's bullet above).
- Images render **properly**: rounded r12, width ~72% of the column, aspect-kept,
  tap → the existing full-screen viewer. Never a squinted 240×120 tile for user-sent
  images (that size is for ephemeral screenshots only when loading).

**Processing (waiting for first delta) — RETIRED spelling (R119-A; the breathing
state lives INSIDE the TurnBlock's rail now):** the three-dot thinking card + the
resolved model micro line — enters immediately on turn.started, retires on first
real delta. Upload progress: per-attachment chip gets a small progress bar /
spinner while uploading (no more silent full-block spinner).

## Data honesty rules (the sync foundation; provider-error line added R119-P)

- The transcript is ONE `TranscriptItem` union fed by the persisted fold + live
  reducer + remote mirror — new renderers must not fork the data model.
- The model ladder displays honestly (override → session truth → effective → agent
  default). "Auto" never appears as a model state.
- **The provider's raw error text is the headline (R119-P):** when the wire carries
  `providerError`, the error card's PRIMARY line is the provider's own text — the
  owner's TokenHarbor report: a region-blocked answer read as a generic "provider
  call failed" on the phone because both mobile reducers dropped the field. The
  generic machine message demotes to the dim secondary line; blank/whitespace reads
  as absent; the 3-line clamp + expand ride the primary; "Copy details" carries
  both. The error card stays compact — the honesty is in the lines, not the size.
- **The markdown ladder is a pinned table (R120-CM, item 41):** `headingTier` in
  `features/markdown.ts` maps H1→Title **20/700**, H2→Heading **16/700**, H3→
  **16/600**, H4→BodyStrong **15/600** — importing the ladder constants
  (`TYPE_TITLE` / `TYPE_HEADING` / `TYPE_BODY`) so drift is a COMPILE error,
  with `accessibilityRole="header"` on every heading Text. A heading never
  renders smaller than its own body (the old flat 21/18/16/15 inline sizes
  with L4 at plain-body weight are dead); the strict step-down law is pinned.
  Code blocks carry the LANGUAGE label (the wire's own spelling, mono-micro
  tertiary) + the a11y "code block, {lang}" name.

## Model sheet (grouped)

Providers as section rows (their letter/icon + name + count); tapping a provider
expands its models inline (accordion, house spring); tapping a model selects it and
closes. "Agent default" row on top clears overrides. No flat mega-list.

**RETIRED (R118-D):** the sheet itself is deleted — the model picker is the kebab's
in-place Model level. **R119-B supersedes the level's content spelling:** the flat
fully-expanded provider sections (TypeMicro headers "{label} · {n} models" + every
model row always visible) collapsed into the provider ACCORDION — provider rows by
default, one section open at a time (§Header). The grouping law survives: no flat
mega-list, real models only.

## Mode sheet (operating mode only)

Full Access / Ask / Plan — three big rows, selected = accent border + check.
**Task mode section deleted from mobile** (round-115 verdict: it confused the mode
model; the desktop keeps it).

**RETIRED (R118-D):** folded into the kebab's in-place mode level — three rows,
selected = the accent Check, apply-and-return. The round-115 verdict stands: task
mode stays off mobile.

## Round-116 amendments (the owner's v0.109.0 walkthrough)

- **Delivery ticks (RETIRED — R118-D supersedes this bullet):** the tick ladder is
  deleted — four inline glyphs for states the body can carry. **Delivery rides the
  message body now:** `sending` = the dull clay fill + `textSecondary` text + a 12%
  bg veil (the RN-honest "grayscale + slight blur"); `sent`/`delivered` = the normal
  tint; `processing` (the first content frame after the ack) = the normal fill with
  the accent EDGE breathing 0.34↔0.62 at the house 550ms legs; `failed` = the
  normal fill + the 0.22 danger edge, no glyph (the error card below carries the
  alert + Retry). The clock row renders only the clock; the a11y label appends the
  rung word.
- **The kebab opens an anchored dropdown** (below the control), not a sheet: rows
  "Mode — {value}", "Model — {value}", "Thinking — {value}", "Context — {pct}".
  R118-D supersedes the routing clause: the levels render IN PLACE inside the panel
  (apply-and-return — see §Header) — no detail sheets, no dedicated Context view.
- **The model sheet lists real models only** — the "Agent default" row is retired
  (donts #36); the PC's actual selection (or the context report's effective model)
  carries the check. Tapping the checked session-selected model clears it.
- **Tool cards are compact (SUPERSEDED — R119-A re-housed the law):** one-line heads
  (verb + target), the status rides a quiet chip — never a right-side FAIL badge
  column; failures tint the row danger and keep details behind the expand. File edits
  show `+N` (success) / `−N` (danger) line-count chips parsed from the result summary;
  terminal commands keep the quiet mono block; thinking is expandable with a
  show-all affordance past the cap. The SAME one-line law now lives in the
  TurnBlock's tool ROWS (donts #37's noun changed with it). The Task list card is the
  owner's explicit favorite — frozen as-is.
- **The composer input is a pill (SUPERSEDED — R119-B):** the paperclip no longer
  lives INSIDE the bar on the right — it is its own 40dp circle BESIDE the input
  (§Composer's single-tier law); the send circle stays outside, right.
