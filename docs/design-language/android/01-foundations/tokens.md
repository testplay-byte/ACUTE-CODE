<!-- last-reviewed: 2026-09-22 round-118 -->

# Foundations — Tokens

Source of truth in code: `mobile/src/design/tokens.ts` (717 lines) + `useTheme()` from
`mobile/src/design/theme.tsx`. **Never hardcode a color, radius, or size in a screen.**
If a value is missing from the contract, add it to `tokens.ts` and consume it.

## 1. Color pipeline

```
THEMES[6] × (light|dark)  →  resolveTheme(themeId, isDark)  →  ResolvedTheme
      →  useTheme().tokens   (the ONLY way a screen sees color)
```

- Six themes; default **Clay Studio** (`clay`): accent `#C4653F` (dark `#D98A63`,
  deep `#B45330`), bg `#ECEEE8` / `#211B16`, card `#FDFDFB` / `#332C26`, ink
  `#2A2018` / `#F2EBE1`.
  - **Round-117 amendment (AMENDMENT 2 — the surface ladder):** the clay bg/card
    values moved to restore a visible luminance step — bg `#F3F4F0→#ECEEE8`,
    dark bg/card `#26211C/#2F2924→#211B16/#332C26` (card light unchanged). Steps:
    card-vs-bg **1.15:1 light / 1.24:1 dark** (was 1.08/1.11 — mathematically
    invisible). R114-c's "slightly colder white" temperature verdict is preserved
    exactly (the new bg keeps the cool cast, G ≥ R ≥ B — only the VALUE deepens);
    dark-mode surface values were never owner-pinned.
  - **Round-117 amendment (AMENDMENT 3 — the two-tier accent):** the accent is a
    two-tier hue of ONE family: `accent` (terracotta `#C4653F` — markers, icons,
    tint fills, chart mass) + `accentDeep` (ember `#B45330` — accent-as-text and
    CTA fills; 4.89:1 as text on card). Dark mode: `accent` = `accentDeep` = the
    salmon `#D98A63` (now declared — `dotDark` and the dark palette strip always
    said so), and `accentText` flips to warm ink `#211B16` (6.30:1; the pre-117
    dark CTA rendered white on the light terracotta at 3.98:1, below AA).
    "One accent per screen" still holds — `accentDeep` is the same hue deepened
    for contrast duty, not a second accent. The contrast floor is CI-enforced in
    `mobile/src/design/__tests__/contrast.test.ts`.
- **Indigo and blue are banned as accents or defaults** (semantic `running` blue is the
  only sanctioned blue, for live/running state).
- Semantic fixed colors: danger `#ef4444`, success `#22c55e`, warning `#f59e0b`,
  running `#3b82f6`. The **expiry/warning stage** (countdown-zero, "rescan" states) uses
  `warning` first, `danger` only for hard failure — an expired pairing window is a
  warning, not an error.
  - **Round-117 amendment (the badge container grammar):** the flat hues above stay
    for **DOTS only**; status *text* and every Badge ride the **deep/bright pairs**
    (`successDeep #15803D`/`#4ADE80`, `warningDeep #B45309`/`#FBBF24`,
    `dangerDeep #DC2626`/`#F87171`, `runningDeep #1D4ED8`/`#93C5FD` — light/dark)
    and the **tinted containers** resolved as `theme.badgeTones` (12% of the hue into
    the card light / 20% dark, deep-on-tint ink; every pair ≥4.5:1 in both modes).
    Never white-on-saturated fills.
- Data-viz hues: `CHART_HUES` (terracotta/sage/violet + rank hues, dark variants) — the
  same entity keeps the same hue across chart + legend + list (donut, leaderboard).
  Round-117: output light `#6F9E90→#5E8E7E` (the sage bars were below the 3:1
  non-text floor; now 3.65:1 vs card).

## 2. The clay material (form, not painted light)

- **Two-leg warm shadows (v2, round-117)**: `clayShadow1` (list cards), `clayShadow2`
  (heroes, tab bar), `clayShadowSm` (chips), `clayShadowPressed` (tight leg), and the
  upward `clayShadowSheet` (docks/sheets). Contact legs 10–14% alpha, ambient legs
  14–24% with tighter spreads (was 8–14% — below the perception floor). Warm ink
  `rgba(38,34,28,…)` light / black dark. Cold blue-black shadows banned.
- **The warm rim (AMENDMENT 1, round-117)**: light-mode cards carry a hairline **warm
  rim** (`clayRim` = 10% ink into the card; 10% white dark) on all four sides — the
  default card edge. The matte **top-edge highlight is now a dark-mode-only device**
  at 14% white (`clayTopEdge` — 1.57:1 on the dark card, finally visible): the old
  55% white mix was arithmetically invisible on ~99%-white light cards. Dark mode
  keeps rim + top edge both.
- **The recessed well (`surfaceWell`, round-117)**: one step DOWN from the card
  (8% warm taupe light / 5% white dark) — accordions, recent-activity rows, inputs,
  mono blocks, skeletons. Supersedes the invisible 2% `surfaceRaised`.
- **The accent tint (`accentTint`, round-117)**: 12% accent into the card (18% dark) —
  icon chips, the tab indicator fill, hero tiles. Hue without loudness.
- **Chrome jewelry — exactly 3 surfaces** (tab bar edge, primary button sheen, selected
  marker ring). Round-115 amendment: the primary button's sheen is **removed from
  onboarding CTAs** — Get Started / Allow camera / Scan enter as flat accent clay
  (radius 14, `clayShadow2`, press scale 0.98). Chrome sheen survives only on
  in-app primary actions (`ChromeButton` default), never on wizard screens.
  Round-117 amendment: the in-app sheen's top stop is **0.18 alpha** (`sheenTop`, was
  0.42) — a whisper glint, never a gloss band; the metal ramp's dark stop
  (`chromeEdgeDark`) is 0.16 light so the edge actually draws on the white bar.
  Round-118 amendment (R118-B): the ramp runs **VERTICALLY** — light stop along the
  top edge, dark stop along the bottom, on all four sides — so every corner reads
  symmetric (the old diagonal ramp left one visible corner and smudged the rest),
  and the dark stop is **0.22 light / 0.08 dark** (deeper where the white bar needs
  the line, softer in dark mode so it never smudges).

## 3. Spacing ladder (8pt-ish)

`xs 4 · sm 8 · md 12 · lg 16 · xl 20 · xxl 24 · xxxl 32 · huge 48`

- Screen gutters: `spacing.lg` (16) standard, `spacing.xl` (20) on chromeless roots.
- Card padding: `spacing.lg` standard, `spacing.md` compact rows, `spacing.xl` heroes.
- List gaps: `spacing.md` (12) between rows, `spacing.lg` between sections.
- **Round-117 amendment (AMENDMENT 5 — the rhythm, round-117-elevation.md §2.1):**
  list cadence is **12 px within a group / 32 px between sections** (was a
  uniform 16 px beat) — `ScreenScaffold.bodyContent`'s gap is `spacing.md` (12)
  and `SectionHeader` carries `marginTop: spacing.xl` (20); the two compose the
  32 px section break while rows knit at 12. Gutters stay 16; card padding
  stays lg/md/xl.
- Sheet padding: `spacing.lg` (16) horizontal inside sheets (round-118, was `spacing.xl`:
  the header row's title now aligns with the fields at the panel's own gutter).

## 4. Radii

`card 20 · tile 24 · bar 28 · input 14 · pill 8 · round 999`

- Project/session letter avatars: `round` on squares ≥36px (circle read), or `tile`
  when ≥44px.
- Viewfinder (QR scanner): square with `card` radius on all corners.

## 5. Touch + layout constants

- `TOUCH_TARGET 44` — every interactive element's hit area ≥ 44px (icons may render
  smaller with `hitSlop`).
- `BAR_HEIGHT 60`, `BAR_MARGIN 12` — the floating tab bar; content inset rides
  `TabBarInsetContext`.
- Keyboard: the chat dock owns `ADJUST_NOTHING`; sheets ride the Modal host (and ride
  the IME itself — R118-E: the panel translates up by `min(kbHeight, headroom)` on
  the sheet spring; `KeyboardAvoidingView` stays banned per R115-K).
- **Round-118 geometry constants:** `SHEET_HEADER_ROW 48` (the sheet's title row),
  `SEGMENT_TRACK_H 52` / `SEGMENT_INSET 4` (the segmented control's track —
  `SEGMENT_TRACK_H − 2×SEGMENT_INSET === TOUCH_TARGET`), `SHEET_CTA_MIN_W 200` /
  `PAGE_CTA_MIN_W 200` (the centered self-sized CTA floors — sheets and pages).
- **`surfaceHeader` (R118-D):** the in-flow chrome shade — bg **+6% warm ink light /
  +30% black dark** (#E0E2DC / #17130F on Clay) — for header columns pulled through
  the status-bar inset (the session top bar); the text tiers hold AA on it.

## 6. Typography ladder (see `typography.md` for the law)

| Tier | Size/Weight | Use |
|---|---|---|
| display | 28/800 | One per wizard screen max |
| stat | 28 / mono-medium | Dashboard & data numbers (round-117: the display size on the mono face — a named slot, not a new size) |
| title | 20/700 | Page heroes |
| heading | 16/700 | Card titles |
| body | 15/400 | Body, option labels |
| body-strong | 15/600 | Row titles |
| caption | 12.5/500, lineHeight 18 | One-line descriptions (round-117: lineHeight 17→18) |
| micro | 11/600, lineHeight 15 | Kickers, meta (all-caps via style, never hardcoded) |
| mono | 13/400 + JetBrains Mono | Paths, ids, commands, PIN |

## 7. Iconography

- `lucide-react-native`, stroke 2 (2.2–2.4 on active/accent).
- Icon chips: 40×40 r14 (list rows), 44×44 r15 (hero), 48–56px r16–18 (wizard options).
- **Letter avatars** (round-115): project identity = first letter, `TypeBodyStrong`
  white, centered in a `round`ed square filled with the project's theme color (the six
  `PROJECT_COLORS`), sized 36–44px. The colored dot is retired.
