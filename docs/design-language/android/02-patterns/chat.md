<!-- last-reviewed: 2026-09-20 round-115 -->

# Patterns — Chat (the WhatsApp-inspired conversation)

Files: `mobile/app/session/[id].tsx`, `src/components/composer.tsx`,
`src/components/transcript.tsx`. Round-115 rebuilt the anatomy around a familiar
grammar: **an identity header, a clean transcript, and a minimal dock.**

## Header — the identity bar

```
[ back chevron ]  [ project letter avatar ]  Project name        [ kebab ⋮ ]
                                               session name
```

- Avatar: the project's letter avatar (color + first letter) — the conversation's "DP".
- Title = project name (`TypeBodyStrong`), subtitle = session name (`TypeCaption`,
  tertiary, one line). The session's own title demoted to the subtitle — the project
  is the identity, the session is the context.
- Status moves OUT of the header text (no more "a turn is live · code · model" line).
  The right side is the **kebab menu**; live state shows as a small breathing dot on
  the avatar or a thin accent line under the header while a turn runs.
- **Kebak menu opens a sheet** listing the session controls, one row each:
  Operating mode · Model · Thinking level · Context usage (+ Stop turn while live).
  Each row shows its CURRENT value on the right (e.g. "Ask", "L2N Flash", "Medium",
  "42%") and opens its own sub-sheet. The composer carries NONE of these controls.

## Composer — the minimal dock

```
[ + attach ]  [ message input (grows to 5 lines) ]  [ send ● / stop ■ ]
```

- **Exactly three controls.** The control pill row is deleted; sheets open from the
  kebab menu instead.
- Attach opens the existing "Add context" sheet (Attach a file / Choose from project) —
  unchanged behavior, polished rows.
- Send: circular accent button; while a turn is live: queue + stop as today.
- The dock owns the keyboard (see `session-screen.md` architecture in the wave spec:
  ADJUST_NOTHING + single animated paddingBottom expression).

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

## Mode sheet (operating mode only)

Full Access / Ask / Plan — three big rows, selected = accent border + check.
**Task mode section deleted from mobile** (round-115 verdict: it confused the mode
model; the desktop keeps it).

## Round-116 amendments (the owner's v0.109.0 walkthrough)

- **Delivery ticks:** user bubbles carry the send ladder — `sending` (clock glyph) →
  `sent` (single check) → `delivered` (double check, accent) when the PC's
  `turn.started` acks the turn; `failed` (warning glyph + tint) when the send died.
  Rendered in the bubble's inline clock row. Driven additively by the live machine —
  no wire change.
- **The kebab opens an anchored dropdown** (below the control), not a sheet: rows
  "Mode — {value}", "Model — {value}", "Thinking — {value}", "Context — {pct}"; each
  routes to its detail surface; Context gets a clean full-height dedicated view.
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
