<!-- round: 115 -->

# Patterns — Screen Archetypes

Every mobile screen is exactly ONE of four shapes. If a design doesn't fit a shape,
redesign until it does.

## Archetype 1 — Minimal-Center (wizard + connect + pairing moments)

**For:** first-run steps, permission asks, the unpaired connect screen, full-screen
pairing animation.

Anatomy (top → bottom):

```
[safe-area top]
        ~flex 0.9 spacer
   icon tile (72–76px, clay, entrance scale)        ← slightly ABOVE center
   TypeDisplay title (one)
   one-line tagline (TypeBody, tertiary)            ← optional, one line max
        ~flex 1 spacer
   [1–2 large options OR nothing]
   primary CTA (flat accent clay, 50px)             ← below middle
   quiet escape ("Do it later" / "Skip")            ← may be hidden by state
[safe-area bottom]
```

Rules:
- **No step numbers, no 1-2-3 dots, no progress paragraphs.**
- Center the icon+title cluster slightly above the vertical middle; the CTA sits
  below the middle line. No `justifyContent: "space-between"` clutter.
- Maximum TWO interactive affordances besides the CTA.
- Nothing else. No trust cards, no kickers, no footnotes, no "your desktop does all
  the work" essays.
- Every state change is animated (see `motion.md` §4).

## Archetype 2 — List (tabs: projects, approvals, dashboard sections, activity)

Anatomy:

```
[header-free root: content starts at status-bar inset + spacing.xxl]
   optional: live section strip (connection status / window chips)   ← one row, quiet
   SectionHeader (micro kicker, optional action)
   rows… (PressableCard / ClayCard rows, 12px gaps, stagger entrance)
   [New thing action — at the BOTTOM, half width, no description]
[tab bar inset]
```

Rules:
- **Header-free tab roots** (no title row, no bell, no connection pill) — pushed
  screens keep the compact 56px header (chevron | title+subtitle | right slot).
- Row = leading identity (letter avatar / icon chip) + label + ONE meta line.
  One line per meta datum; a row is 2 text lines max.
- Empty state = Archetype-1-style centered message (icon + one-line title +
  one-line caption).
- Inline expansion (accordion) belongs to lists: tap a row → children expand below it
  with the house spring; the chevron is the ONLY affordance (no + buttons on rows).
- The "New X" action renders at the list's bottom, `alignSelf: "flex-start"`-ish
  (half width), icon + two-word label, no description, no chevron.

## Archetype 3 — Detail / Form (manual entry, settings pages, confirm)

Anatomy:

```
[compact 56px header: chevron-back | title | right slot]
   optional hero card (identity / status) — the subject of the screen
   form fields (ClayInput) or info cards, spacing.lg apart
   [primary action, bottom-sticky or at end]
```

Rules:
- Highlight discipline: **each key datum gets its own visual tier** — address in mono
  body, PIN in big grouped mono, countdown in a tinted chip. Never two facts sharing
  one row when either matters.
- Forms: label above input, one-line hint below ONLY when ambiguous, error text in
  danger replaces the hint. Return key submits when valid.
- Smart affordances beat prose: a "Paste" action that parses clipboard pairing text
  beats a paragraph explaining what to type.

## Archetype 4 — Chat (see `chat.md`)

WhatsApp-inspired: header identity bar + full transcript + docked composer. Detailed
in its own file.

## Cross-archetype rules

- **Back buttons are always the chevron icon** (`ChevronLeft`, 44px target). Never a
  text-only "Back".
- Headers on pushed screens: title = the subject's NAME (project name, "Manual entry"),
  subtitle = one contextual line max.
- Loading = skeletons shaped like the content (never centered spinners on list
  screens); errors = one card, retry action, honest copy.
- Offline/probing states are one quiet strip, not banners.
