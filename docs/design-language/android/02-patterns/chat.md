<!-- last-reviewed: 2026-09-22 round-118 -->

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
  the model list scrolls at maxHeight 360 with provider sections; Context is a
  read-only readout that stays at its level). Picks **apply and return to main** —
  the feedback loop closes where the owner will look. The composer carries NONE of
  these controls; there are no sub-sheets.
- **The two-step stop (R118-D):** the Stop row never fires one-shot — the first tap
  arms it ("Stop this turn" → "Do you want to stop?" flipped in place); the second
  tap stops; the armed state resets on menu close and when the turn dies.

## Composer — the minimal dock

```
[ + attach ]  [ message input (grows to 6 lines) ]  [ send ● / stop ◼ ]
```

- **Exactly three controls.** The control pill row is deleted; the mode/model/
  thinking/context picks live in the kebab's in-place sub-levels (R118-D).
- Attach opens the existing "Add context" sheet (Attach a file / Choose from project) —
  unchanged behavior, polished rows.
- Send: circular accent button. While a turn is live: an **icon-only stop** (R118-D)
  — a 50px circle with a 1dp danger border and the Square glyph, no text label —
  which opens the **centered confirm dialog** before stopping (`components.md`
  §Dialogs); and a **conditional queue** button that renders ONLY when there is
  something to send (draft or attachments) — an always-mounted disabled arm is a
  control without content.
- **Input growth is native (R118-D):** minHeight 44 → maxHeight 176 (6 lines;
  `6×21 + 10 + 40`), no controlled height, no `flex:1` desync — the field scrolls
  past the cap. The focus ring is **1.5dp** (a hairline whisper is not a ring).
- **The two-tier attach geometry (R118-D):** resting, the paperclip sits beside the
  line (paddingRight 52, pinned bottom-right); once tall, text takes the full width
  above a reserved **40px attach band** under it — text never wraps around the icon.
- The dock owns the keyboard (see `session-screen.md` architecture in the wave spec:
  ADJUST_NOTHING + single animated paddingBottom expression; `keyboardDidHide`
  blurs the input so handles and selection clear — R118-D).

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

**Assistant message (left):**

```
[model chip · time]           ← one micro meta line ABOVE, only when content starts
  markdown content
  [caret while streaming]
  [attachment/image renders if any]
```

- Full-width document style (no bubble) — it's a document, not a chat bubble.
- Thinking renders as the collapsible dim card ABOVE content, capped lines, live-open.
- Meta line: model + time, 10px mono tertiary — one line, above the first content
  chunk of the turn, not below.

**Tool cards** — compact, one line per state:

| Tool | Idle/running | Done |
|---|---|---|
| write/edit file | "Writing {file}… {n} chars" + live tail preview | "Wrote {file} · {n} lines" + expand for diff-ish summary |
| terminal | "Running {cmd}" + streaming tail | "{cmd} · exit 0" + expand |
| read skill | **"Read skill · {name} · ✓"** — one quiet chip, never a full view | same |
| screenshot | image tile loading | inline image (rounded, tappable → viewer) |
| other | humanized verb + target + status | expand for details |

- Tool activity prefs (detailed/compact/hidden) still apply.
- Images render **properly**: rounded r12, width ~72% of the column, aspect-kept,
  tap → the existing full-screen viewer. Never a squinted 240×120 tile for user-sent
  images (that size is for ephemeral screenshots only when loading).

**Processing (waiting for first delta):** the three-dot thinking card + the resolved
model micro line — enters immediately on turn.started, retires on first real delta.
Upload progress: per-attachment chip gets a small progress bar / spinner while
uploading (no more silent full-block spinner).

## Data honesty rules (unchanged from the sync foundation)

- The transcript is ONE `TranscriptItem` union fed by the persisted fold + live
  reducer + remote mirror — new renderers must not fork the data model.
- The model ladder displays honestly (override → session truth → effective → agent
  default). "Auto" never appears as a model state.

## Model sheet (grouped)

Providers as section rows (their letter/icon + name + count); tapping a provider
expands its models inline (accordion, house spring); tapping a model selects it and
closes. "Agent default" row on top clears overrides. No flat mega-list.

**RETIRED (R118-D):** the sheet itself is deleted — the model picker is the kebab's
in-place Model level (provider sections as TypeMicro headers "{label} · {n} models"
+ one-line rows with the accent Check, scrolling at maxHeight 360). The grouping law
survives: no flat mega-list, real models only.

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
- **Tool cards are compact:** one-line heads (verb + target), the status rides a quiet
  chip — never a right-side FAIL badge column; failures tint the row danger and keep
  details behind the expand. File edits show `+N` (success) / `−N` (danger) line-count
  chips parsed from the result summary; terminal commands keep the quiet mono block;
  thinking is expandable with a show-all affordance past the cap. The Task list card
  is the owner's explicit favorite — frozen as-is.
- **The composer input is a pill** (fully rounded when single-line) with the paperclip
  INSIDE the bar on the right; the send circle stays outside, right.
