<!-- last-reviewed: 2026-09-22 round-118 -->

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
   optional: state-conditional live strip (offline/probing only)  ← one row, quiet
   SectionHeader (micro kicker, optional action; LARGE tier on registries)
   rows… (PressableCard / ClayCard rows, 12px gaps, stagger entrance)
   [New thing CTA — at the BOTTOM, centered, self-sized, no description]
[tab bar inset]
```

Rules:
- **Header-free tab roots** (no title row, no bell, no connection pill) — pushed
  screens keep the compact 56px header (back arrow | title+subtitle | right slot).
- Row = leading identity (letter avatar / icon chip) + label + ONE meta line.
  One line per meta datum; a row is 2 text lines max.
- **Round-117 amendment (AMENDMENT 5 — the rhythm, round-117-elevation.md §2.1):**
  the list cadence is **12 px within a group / 32 px between sections** (was the
  uniform 16 px beat) — the scaffold's body gap is `spacing.md` and every
  `SectionHeader` carries `marginTop: spacing.xl`, so sections announce
  themselves while groups knit tight. Gutters stay 16.
- Empty state = Archetype-1-style centered message (icon + one-line title +
  one-line caption).
- **The live strip is state-conditional (R118-B):** it renders ONLY while offline or
  probing (dot + status word + "· messages will queue") — never an always-on status
  row. The WHO + connection identity lives in the **More hero** (the More hub's
  elevated card: host label, status dot + word, identity micro line → the connect
  hub); home carries the strip, settings carries no connection row at all.
- **Registry headings ride the LARGE tier (R118-E):** pushed registry screens set
  their section heading at `SectionHeader large` (20/700) and break tiers with the
  **strong Hairline** (~65px: `marginVertical xl` + the 1dp `borderStrong` rule) — a
  25px hairline break is indistinguishable from the 12px intra-group rhythm.
- Inline expansion (accordion) belongs to lists: tap a row → children expand below it
  with the disclosure motion (R118-C — expand springs, collapse is a timing); the
  chevron is the ONLY affordance (no + buttons on rows).
- **The "New X" CTA (R118-E):** centered, self-sized `ChromeButton`
  (`minWidth: PAGE_CTA_MIN_W 200`), two-word label, no icon tile, no description, no
  chevron — the SAME grammar in the empty state, the configured list, and the well
  ("New project", "Add a provider", "New session"). The half-width outline idiom is
  retired (donts #40's centered law, now with the real CTA recipe).
- **The sessions well (R118-E):** a project's sessions render in the recessed well —
  `surfaceWell` + hairline `clayRim` + `RADIUS_INPUT`, **1dp inset `borderStrong`
  dividers between rows**, the model NAME in the meta line (the name-hash dot chip),
  honest badges (non-"open" only) — ONE shared anatomy with the dashboard's session
  rows (`components.md` §Session rows inside expansions).

## Archetype 3 — Detail / Form (manual entry, settings pages, confirm)

Anatomy:

```
[compact 56px header: back arrow | title | right slot]
   optional hero card (identity / status) — the subject of the screen
   form fields (ClayInput) or info cards, spacing.lg apart
   [primary action, bottom-sticky or at end]
```

Rules:
- Highlight discipline: **each key datum gets its own visual tier** — address in mono
  body, PIN in big grouped mono, countdown in a tinted chip. Never two facts sharing
  one row when either matters.
- **The three-zone hero (R118-E):** a detail screen's subject card separates into
  zones — identity (the name-hash color tile + `TypeTitle` 20/700 name + ONE context
  line) → hairline → the one-honest-line machine strip (mono) → hairline → the
  actions pair (primary + quiet peer, both 50 tall). Never one undifferentiated card
  carrying identity, machine meta, and same-weight outlined actions (the provider
  detail page is the reference build).
- Forms: label above input, one-line hint below ONLY when ambiguous, error text in
  danger replaces the hint. Return key submits when valid.
- Smart affordances beat prose: a "Paste" action that parses clipboard pairing text
  beats a paragraph explaining what to type.

## Archetype 4 — Chat (see `chat.md`)

WhatsApp-inspired: header identity bar + full transcript + docked composer. Detailed
in its own file.

## Cross-archetype rules

- **Back buttons are always the arrow icon** — `ArrowLeft` in the 40px quiet circle
  (`QuietIconButton`; R118-D supersedes the chevron — the owner called the bracket
  what it was). Never a text-only "Back", never the chevron bracket.
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
- **The dashboard is a VERTICAL instrument (round-118 supersedes the carousel
  mandate):** ONE scroll — the five-section stack (stat grid · daily chart · models
  · tools/keys · projects) under a self-sized period selector. **Horizontal snap
  carousels are BANNED on this screen — every horizontal FlatList there is a defect**
  (they hid mixed-scope cards behind a swipe and split one section across two
  surfaces). Every number is field-provenanced; whole-history sections are labeled
  "all time" honestly.
