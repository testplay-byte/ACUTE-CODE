<!-- last-reviewed: 2026-09-22 round-117 -->

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
- **Round-117 amendment (AMENDMENT 5 — the rhythm, round-117-elevation.md §2.1):**
  the list cadence is **12 px within a group / 32 px between sections** (was the
  uniform 16 px beat) — the scaffold's body gap is `spacing.md` and every
  `SectionHeader` carries `marginTop: spacing.xl`, so sections announce
  themselves while groups knit tight. Gutters stay 16.
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

## Round-116 amendments (the owner's v0.109.0 walkthrough)

- **The scanner (Archetype: full-screen task):** the viewfinder is PORTRAIT (≈3:4,
  width = screen − gutters, height = width × 4/3) — never a square. The live preview
  wears the **monochrome treatment**: a dark scrim + vignette overlay stack
  (`pointerEvents="none"` — the native barcode decode reads the true frames, never the
  styled view), white brackets + traveling scan line. Title truly centered; back = the
  chip chevron; a calm top-of-screen animation (breathing "scanning" indicator).
  Photo-pick PAUSES the camera, shows a processing state, and presents the result
  (success or failure) as a formatted result card — never a flashing caption.
- **Empty/unpaired states carry ONE primary button** (Archetype-1 DNA, restated): the
  unpaired home shows the broken-link hero + "Currently not connected" + a single
  "Connect to PC" that opens the scanner directly. Secondary escapes (manual entry)
  live INSIDE the scanner, not on the home.
- **The dashboard is DYNAMIC (round-116):** not one vertical scroll — stat carousels
  (horizontal paging, snap), tappable cards that expand/spotlight, and sectioned
  horizontal scrollers. Every number is field-provenanced; whole-history sections are
  labeled "all time" honestly.
