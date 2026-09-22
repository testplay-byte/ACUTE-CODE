<!-- last-reviewed: 2026-09-22 round-117 -->
<!-- round-117-g — the visual-design-quality (elevation) spec. RESEARCH + SPEC only:
     this file prescribes; implementation waves execute. Binding law: the three laws
     (README.md) + 01-foundations + 02-patterns + 03-rules stay in force. Every place
     this spec supersedes one of them is flagged "AMENDMENT" and must be appended to
     the affected foundation file when the wave lands, per README's amendment rule. -->

# Round 117-g — The Elevation Spec: making Clay Studio look premium

The owner tested the app and ruled "the UI is very bad — use proper designing skills."
Round 116 fixed STRUCTURE (laws, layouts, mechanics); what reads as bad now is VISUAL
QUALITY: surfaces that don't separate, text tiers that don't meet contrast, one
typographic volume everywhere, and components that render as pale gray boxes. This
document diagnoses exactly why, then specifies the fix as engineer-executable values —
no taste decisions required, everything inside the existing clay identity (this is an
ELEVATION of the same language, not a rebrand; indigo/blue stay banned except the
semantic `running` hue).

All contrast ratios below are WCAG 2.1, computed against the exact token hex values
(mixHex math as implemented in `tokens.ts`). "Text" means body-size text: AA needs
≥ 4.5:1; icons/large glyphs ≥ 3:1.

---

## §1 — The diagnosis: eight specific reasons the UI reads as bad

### 1.1 The surfaces don't separate — the elevation system is mathematically invisible

The single biggest "prototype" smell. A polished app's first impression is a visible
surface ladder: page → card → raised. Here the ladder exists in tokens but not in
light:

- `bgLight #F3F4F0` vs `cardLight #FDFDFB` (`tokens.ts:67,69`) = **1.08 : 1** — the
  card is one luminance breath away from the page. R114-c's cooling of the whites
  (#F4EEE5→#F3F4F0) kept the owner's "colder white" verdict but erased the value step
  the clay identity depended on: the warm-sand-vs-card contrast that made "clay" read
  as clay is gone; what remains is white cards on a whiter page.
- Every shadow is 8–14 % alpha of the same warm ink (`tokens.ts:353-356`):
  `clayShadow1 = 0px 1px 3px rgba(38,34,28,0.08), 0px 8px 24px -6px rgba(38,34,28,0.10)`.
  An 8 % contact leg plus a −6px-spread ambient leg on near-white surfaces is below
  the perception floor on most panels — the "two-leg clay shadow" reads as nothing.
- The matte top edge — the system's signature "molded" cue — is painted white-on-white:
  `clayTopEdge = mixHex(card, "#FFFFFF", 0.55)` (`tokens.ts:357-359`) ≈ `#FEFEFE` on a
  `#FDFDFB` card. A 55 % white mix over a 99 %-white card is invisible by arithmetic.
- Dark mode is flatter still: card `#2F2924` vs bg `#26211C` = **1.11 : 1**, the top
  edge is 6 % white, and the shadows are black — on a black-brown page.

**Benchmark missed:** Material 3 defines five surface-container levels with real
luminance steps plus tonal elevation; One UI group cards sit on a clearly deeper page.
In both, a screenshot at 20 % zoom still shows the card silhouettes. Squint at this
app's Home and you see one undifferentiated sheet with text on it.

### 1.2 The app's most-used text tier fails contrast globally

`textTertiary = rgba(0,0,0,0.40)` on card (`tokens.ts:347`) = **2.83 : 1** — below even
the 3 : 1 large-text bar. Dark mode `rgba(255,255,255,0.40)` = 3.6 : 1. This one tier
carries an enormous share of the interface: every `TypeMicro` meta line on the
dashboard (stat captions, model-card meta, key rows, session meta), the home recent-
activity body lines and timestamps, taglines, empty-state captions, unselected tab
labels, and every chevron. The result: the app's actual information density renders in
a sub-legible gray, so screens read as faint — the direct cause of "looks bad" before
anyone can articulate why.

**Benchmark missed:** M3 `onSurfaceVariant` ≈ 4.6 : 1; One UI secondary text ≥ 4.5 : 1.
No shipped Google/Samsung surface ships 2.8 : 1 body-adjacent text.

### 1.3 The accent fails as text and as a fill — including every primary CTA

- Accent **as text** on card: `#C4653F` = **3.9 : 1** — SectionHeader action links
  ("see all"), delivery ticks, countdown numerals, the "New session" row label.
- The light CTA: white on `#C4653F` = **3.98 : 1** (ChromeButton label is 15/700 — not
  "large text," so AA fails). Every "Get started"/"Connect to PC" fails AA.
- The dark CTA is the worst number in the app: `accentDark #D98A63` resolves
  `accentText` to **white** (getContrastText luminance 0.616 > 0.55, `tokens.ts:249-253`)
  → white on `#D98A63` = **2.70 : 1**. Dark ink on that same salmon = 5.9 : 1 — the
  threshold picks the wrong side.
- Badges: white on `success #22c55e` = **2.28 : 1**; white on `warning #f59e0b` =
  **2.15 : 1** (`primitives.tsx:799-837`). The "Live"/"done"/"queued" vocabulary — the
  status system — is the least legible text on screen.

**Benchmark missed:** M3 primary/secondary containers are contrast-paired by spec
(≥ 4.5 : 1 on on-primary); Telegram's tinted status chips use deep-on-tint, never
white-on-saturated.

### 1.4 Typographic monotony — one size class carries ~90 % of the content

- Row titles on every screen are `TypeBodyStrong` 15/600 (welcome rows, home rows,
  connect options, more, projects, session rows). `SectionHeader` is 16/700 — a 1 px /
  one-weight step from the row titles beneath it: sections don't announce themselves.
- In-app screens never see the 28/800 display tier (it's wizard-only), so there is no
  top of a hierarchy anywhere after onboarding.
- The dashboard's headline numbers — the screen's whole point — render at `TypeTitle`
  20 px monoMedium (`usage-cards.tsx:180` + `statValue` at `:694`) on 116 px-tall
  cards (`:165`). Data numbers at body scale read as a spreadsheet mockup, not a
  product.
- Tab labels are `TYPE_MICRO − 0.5` = **10.5 px** (`tab-bar.tsx:420,433`) — below the
  ladder's own 11 px floor.
- `TypeCaption` lineHeight 17/12.5 = 1.36 — tight for Manrope's tall ascenders.

**Benchmark missed:** M3 Expressive spans 16→57 px with per-role weights; One UI list
titles 20–22/700 against 14–15 body; Telegram chat titles 16/700 vs 13 meta. The
professional read is *range*; this app renders at one volume.

### 1.5 No color in resting surfaces — the "clay" reads as greige

Every neutral fill is a 2–8 % alpha overlay (`tokens.ts:341-343,350`): `subtle` 4 %,
`subtleHover` 8 %, `pillBg` 6 %, `inputBg` 2 %. The icon chips — welcome's feature rows
(`welcome.tsx:153`), home's bell chip (`home.tsx:255`), more's settings/about icons
(`more.tsx:152,189`), connect's option rows — are filled with `subtleHover`, which is
**1.19 : 1** against the card: ghost rectangles behind accent glyphs. Combined with
1.1's flat ladder, the resting interface is beige-gray boxes with faint icons — the
"gray boxes" complaint. Saturated color appears only in the one CTA and the
LetterAvatar tiles, so the terracotta identity survives solely in 20 px glyphs.

**Benchmark missed:** M3 secondary/tertiary containers are ~L90 tinted containers —
clearly hue-bearing without being loud; One UI gives every settings group a solid
colored round icon container. Polished neutral ≠ colorless.

### 1.6 The elevation vocabulary has tiers in name only

`ClayCard` offers `small`/default/`elevated` (`primitives.tsx:94-117`) and tokens offer
`clayShadowSm/1/2/Pressed` — but all four are the same ink at 8–14 % alpha, so card vs
hero vs sheet vs tab bar render at the same perceived altitude. `surfaceRaised`
(`tokens.ts:360`) is a 2 % mix — invisible — and has essentially no consumers. There is
no tonal step between bg and card to back the shadows up (see 1.1), so depth has two
broken legs.

**Benchmark missed:** M3 elevation = discrete shadow ramps *and* surface-tint deltas;
WhatsApp separates bubble field / composer dock / header by clear steps.

### 1.7 Chrome jewelry and icon states read as unfinished

- `ChromeEdge`'s metal ramp in light mode is `rgba(255,255,255,0.85) → rgba(42,32,24,0.10)`
  (`tokens.ts:366-367`) — a white hairline on the white tab bar. The sanctioned chrome
  surface is spent where it cannot be seen.
- `ChromeButton`'s sheen — `rgba(255,255,255,0.42)` across the top 55 %
  (`primitives.tsx:351-372`) — is the most visible gradient in the app and reads as
  2012 gloss, the opposite of the intended "one quiet glint."
- Lucide icons are all-outline, all strokeWidth 2–2.4, mostly tertiary gray. The tab
  bar's active state is strokeWidth 2.4 vs 2.0 (`tab-bar.tsx:337`) — imperceptible at
  22 px. Selected vs unselected is a color swap only.

**Benchmark missed:** M3 and One UI nav bars switch outline→**filled** glyph weight on
selection; that single state-weight change is one of the strongest "product vs
prototype" signals in mobile UI.

### 1.8 Uniform vertical rhythm — 16 px between everything, forever

`ScreenScaffold.bodyContent` sets `gap: spacing.lg` (`screen-scaffold.tsx:299`) for
every tab root and most pushed screens: card-to-card, header-to-card, section-to-
section — all identical 16 px beats, full-width cards only. Nothing groups (no
container+divider rows), nothing breaks the grid (the dashboard carousels are the one
exception), so every list screen is the same visual phrase repeated. Monotony of
*rhythm* compounds 1.4's monotony of *size*.

**Benchmark missed:** M3 list groups (one container, inset dividers, 8–12 px intra /
24–32 px inter); One UI's title→group→gap cadence. Professional screens have two
rhythms; this app has one.

---

## §2 — The elevation plan

Everything below stays inside clay: warm neutrals, terracotta accents, two-leg warm
shadows, matte edges where they can read, Manrope + JetBrains. No blue/indigo accents
(the semantic `running` hue remains the only sanctioned blue, now as a tinted badge),
no glow, no gradient washes on resting surfaces, no ripples. Values are final — an
engineer applies them without choosing.

### 2.0 The five AMENDMENTS (each supersedes one pinned rule; append to the named doc when the wave lands)

1. **AMENDMENT to `01-foundations/tokens.md` §2 (the clay material):** light-mode cards
   carry a hairline **warm rim** (new token `clayRim`) all around; the matte top-edge
   highlight becomes a **dark-mode-only** device at 14 % white (it is arithmetically
   invisible on 99 %-white cards — see §1.1). Dark mode keeps rim + top edge both.
2. **AMENDMENT to `01-foundations/tokens.md` §1 (the clay palette values):** the clay
   theme's light bg and dark bg/card values change to restore a visible luminance
   ladder. R114-c's *temperature* verdict ("a slightly colder tone of white") is
   preserved — the new bg keeps the same cool cast, only the VALUE deepens. Dark-mode
   surface values were never owner-pinned.
3. **AMENDMENT to `01-foundations/tokens.md` §1 (one accent):** the accent becomes a
   **two-tier hue of one family**: `accent` (terracotta, markers/icons/tinted fills) +
   `accentDeep` (ember, accent-as-text and CTA fills). "One accent per screen" still
   holds — `accentDeep` is the same hue deepened for contrast duty, not a second accent.
4. **AMENDMENT to `01-foundations/typography.md` (the ladder):** stat/data numbers may
   render at **28 mono-semibold** (the display size, mono face); the tab-label floor is
   11.5 px; `TypeCaption` lineHeight 17→18. The weight law and copy-length law are
   untouched.
5. **AMENDMENT to `01-foundations/tokens.md` §3 + `02-patterns/screen-archetypes.md` §2
   (rhythm):** list cadence becomes **12 px within a group / 32 px between sections**
   (was uniform 16 px). Gutters stay 16; card padding stays lg/md/xl.

### 2.1 Token changes — `mobile/src/design/tokens.ts` (all clay-scoped; the other five themes inherit the theme-independent legs: ink ladder, shadows, rims, wells)

**The surface ladder (clay theme values):**

| Token | Light (new) | Light (old) | Dark (new) | Dark (old) |
|---|---|---|---|---|
| `bgLight`/`bgDark` | **`#ECEEE8`** | `#F3F4F0` | **`#211B16`** | `#26211C` |
| `cardLight`/`cardDark` | `#FDFDFB` (unchanged) | — | **`#332C26`** | `#2F2924` |

Resulting steps: card vs bg light **1.15 : 1** (was 1.08), dark **1.24 : 1** (was
1.11) — visible at a squint, invisible at a glance; the cool cast (G ≥ R ≥ B) is
preserved exactly. Update `paletteLight`/`paletteDark` strips to match
(`["#C4653F","#B45330","#ECEEE8","#FDFDFB","#2A2018"]` /
`["#D98A63","#B09380","#211B16","#332C26","#F2EBE1"]`).

**The ink ladder (theme-independent, mode-aware — in `resolveTheme`):**

| Token | Light (new) | Ratio on card | Dark (new) | Ratio on cardD |
|---|---|---|---|---|
| `textSecondary` | `rgba(0,0,0,0.62)` (unchanged) | 6.18 | `rgba(255,255,255,0.62)` (unchanged) | 6.49 |
| `textTertiary` | **`rgba(0,0,0,0.57)`** | **5.23** (was 2.83) | **`rgba(255,255,255,0.52)`** | **4.91** (was 3.60) |

(5.23 : 1 on card, 4.56 : 1 on the new bg — tertiary text passes AA on both surfaces.
Secondary stays untouched so the two tiers remain a visible step apart.)

**The accent tiers + on-accent text:**

| Token | Light | Dark |
|---|---|---|
| `accent` (markers, icons, tint fills, chart mass) | `#C4653F` (unchanged; 3.9 : 1 on card — passes 3 : 1 non-text) | `#D98A63` (unchanged; 5.08 : 1 on new cardD) |
| `accentDeep` (NEW — accent-as-text + CTA fills) | **`#B45330`** (4.89 : 1 as text on card; white-on-it 4.98 : 1) | **`#D98A63`** (same value as dark accent) |
| `accentText` (label on accent fills) | `#FFFFFF` (4.98 : 1 on `accentDeep`) | **`#211B16`** (6.3 : 1 on `#D98A63` — was white at 2.70 : 1) |

`accentText` becomes an explicit resolved value (delete the `getContrastText` call for
it — the 0.55 threshold picks white for the salmon; hard-pin both branches as above).
This flips every dark-mode CTA, tab badge, and accent Badge from 2.7 : 1 to 6.3 : 1.

**The clay material (two-leg shadows, now mode-aware strings — same `rgba(38,34,28,·)`
warm-ink family light / pure black dark):**

| Token | Light | Dark |
|---|---|---|
| `clayShadow1` | `0px 1px 2px rgba(38,34,28,0.12), 0px 6px 16px -6px rgba(38,34,28,0.18)` | `0px 1px 2px rgba(0,0,0,0.40), 0px 8px 20px -6px rgba(0,0,0,0.50)` |
| `clayShadow2` | `0px 2px 4px rgba(38,34,28,0.14), 0px 12px 32px -8px rgba(38,34,28,0.24)` | `0px 2px 4px rgba(0,0,0,0.45), 0px 14px 36px -8px rgba(0,0,0,0.60)` |
| `clayShadowSm` | `0px 1px 2px rgba(38,34,28,0.10), 0px 3px 10px -4px rgba(38,34,28,0.14)` | `0px 1px 2px rgba(0,0,0,0.35), 0px 4px 12px -4px rgba(0,0,0,0.45)` |
| `clayShadowPressed` | `0px 1px 2px rgba(38,34,28,0.12)` | `0px 1px 2px rgba(0,0,0,0.40)` |
| `clayShadowSheet` (NEW — upward, replaces sheet.tsx's hardcoded string) | `0px -2px 6px rgba(38,34,28,0.12), 0px -12px 32px -8px rgba(38,34,28,0.22)` | `0px -2px 6px rgba(0,0,0,0.50), 0px -14px 36px -8px rgba(0,0,0,0.65)` |

Contact legs go to 10–14 %, ambient legs to 14–24 % with tighter spreads — the shadow
now draws a silhouette. (Still no painted glow, no cold blue-black — the R108-e law
holds; only alpha and blur change.)

**Edges, rims, wells, tints (new resolved tokens):**

| Token | Light | Dark | Use |
|---|---|---|---|
| `clayRim` (NEW) | `mixHex(card,"#2A2018",0.10)` = `#E8E7E4` | `rgba(255,255,255,0.10)` = `#47413C`-class | the default card hairline (AMENDMENT 1) |
| `clayTopEdge` | retired on cards (light) | **`mixHex(card,"#FFFFFF",0.14)`** = `#504A44` (1.57 : 1 — finally visible) | dark-mode molded edge |
| `surfaceWell` (NEW, replaces `surfaceRaised`) | `mixHex(card,"#8A6A55",0.08)` = `#F4F1EE` (warm) | `mixHex(card,"#FFFFFF",0.05)` = `#3D3731` | recessed wells: accordions, recent-activity rows, inputs, mono blocks |
| `accentTint` (NEW) | `mixHex(card,"#C4653F",0.12)` = `#F6EBE4` | `mixHex(card,"#D98A63",0.18)` = `#513D31` | icon chips, tab-indicator fill, hero tiles |
| `monoBg` | `mixHex(card,"#2A2018",0.06)` = `#F0F0ED` (was 4 %) | unchanged | code surfaces |

**Chrome jewelry (tuned so the sanctioned surfaces survive):**

| Token | Light (new) | Dark (new) |
|---|---|---|
| `chromeEdgeDark` | `rgba(42,32,24,0.16)` (was 0.10 — the ramp's dark stop now draws) | `rgba(255,255,255,0.06)` |
| `sheenTop` | **`rgba(255,255,255,0.18)`** (was 0.42 — a whisper glint, not a gloss band) | `rgba(255,255,255,0.12)` |

**Semantic deep pairs (NEW — `successDeep`/`warningDeep`/`dangerDeep` on ResolvedTheme)
for status *text* and tinted badges:**

| Hue | Light deep (as text on card) | Dark bright (as text on cardD) |
|---|---|---|
| success | `#15803D` (4.92) | `#4ADE80` (7.88) |
| warning | `#B45309` (4.93) | `#FBBF24` (8.23) |
| danger | `#DC2626` (4.74) | `#F87171` (4.97) |
| running (the sanctioned blue) | `#1D4ED8` (6.58) | `#93C5FD` (—) |

The flat `danger/success/warning/running` fills stay for DOTS only; text and badges
move to the deep/bright pairs.

**Chart hues (`CHART_HUES`):** `output` light `#6F9E90` → **`#5E8E7E`** (2.96 → 3.65 : 1
vs card — the sage bars were below the non-text floor); `output.dark` `#8FBFAD` stays
(6.69 : 1 on new cardD). `input`/`peak` unchanged.

**Type + geometry tokens:**

- NEW `TYPE_STAT = 28` (mono-medium face, `letterSpacing: -0.5`) — dashboard/usage
  numbers. Same value as `TYPE_DISPLAY`; a named slot, not a new size (AMENDMENT 4).
- `TYPE_DISPLAY` letterSpacing −0.5 → **−0.8** (Manrope 800 at 28 likes it tighter;
  welcome's +1.5 letterspaced wordmark stays — it's the brand).
- `TypeCaption` lineHeight 17 → **18**; `TypeMicro` gains `lineHeight: 15`,
  letterSpacing 0.5 → 0.6.
- Tab label size: `TYPE_MICRO − 0.5` (10.5) → **`11.5`** in both the label and the
  measurement row (`tab-bar.tsx:420,433` — they must stay identical or the morph
  mis-measures).
- Spacing: `ScreenScaffold.bodyContent` `gap: spacing.lg` → **`spacing.md` (12)**;
  `SectionHeader` gains `marginTop: spacing.xl (20)` → section breaks read 32 px while
  groups knit at 12 (AMENDMENT 5). No other spacing token changes.

### 2.2 Component upgrades — `mobile/src/design/primitives.tsx` + feature components

**ClayCard / PressableCard (the resting surface):** default surface = fill `card` +
hairline `clayRim` border (all four sides, `StyleSheet.hairlineWidth`) + `clayShadow1`
v2. Light drops `clayTopEdge`; dark keeps top edge 14 % + the same rim. `elevated` =
`clayShadow2` v2; `small` = `clayShadowSm` v2 + `clayRim`. Pressed state unchanged
(tint + 0.98 + collapse to `clayShadowPressed`). The `bordered` prop stays for
input-ish cards (its `tokens.border` is now the *strong* rim — fine).

**ChromeButton (the primary CTA):** fill = `accentDeep` (light `#B45330` / dark
`#D98A63`); label color = `accentText` (white light / `#211B16` dark); label recipe
15/700, letterSpacing 0.3. `flat` (wizard CTAs) keeps the no-sheen rule and
`clayShadow2`. In-app sheen (non-flat) keeps its geometry but rides the new 0.18-alpha
`sheenTop` — a glint, not a gloss band. Pressed = tint + 0.98 + shadow collapse
(unchanged).

**QuietButton:** unchanged (outline + flat is correct for escapes); fg stays
`textSecondary`.

**NEW `ClayIconChip` primitive** (kills the ghost chips — §1.5): sizes 40 (r 14),
44 (r 15), 48 (r 16); fill `accentTint`, hairline `clayRim`, `clayShadowSm`, child icon
`accentDeep` strokeWidth 2.2. Migrate: welcome `rowIcon`, home `bellChip` (36 → 40),
more `aboutIcon`/`settingsIcon`, connect `optionIcon`, composer `modeIconChip`. The
chips stay quiet (a 12 % tint), but they finally exist — this is the single change that
puts hue into every list row without touching the one-accent law.

**Chip (filters):** unselected = `surfaceWell` fill + `clayRim` border + text
`textSecondary` (12.5/600, unchanged); selected = `accentDeep` fill + `accentText`
(4.98 : 1). The 2 px selected border rule (donts #34) applies to segmented controls —
keep chips hairline.

**Badge (the status vocabulary):** switch every tone to **tinted containers**
(deep-on-tint, M3-style; the flat hue fills remain only for dots):

| Tone | bg light | fg light | bg dark | fg dark | fg ratio |
|---|---|---|---|---|---|
| success | `mixHex(card,#22c55e,0.12)` `#E3F6E8` | `#166534` | `mixHex(cardD,#22c55e,0.20)` `#304B31` | `#4ADE80` | 6.32 / 5.54 |
| warning | `mixHex(card,#f59e0b,0.12)` `#FCF2DE` | `#92400E` | `mixHex(cardD,#f59e0b,0.20)` `#5A4321` | `#FBBF24` | 6.38 / 5.57 |
| danger | `mixHex(card,#ef4444,0.12)` `#FBE7E5` | `#B91C1C` | `mixHex(cardD,#ef4444,0.20)` `#59312C` | `#FCA5A5` | 5.44 / 5.82 |
| running | `mixHex(card,#3b82f6,0.12)` `#E6EEFA` | `#1D4ED8` | `mixHex(cardD,#3b82f6,0.20)` `#353D50` | `#93C5FD` | 5.74 / 6.02 |
| accent | solid `accentDeep` | `#FFFFFF` | solid `accentDark` | `#211B16` | 4.98 / 6.30 |
| neutral | `surfaceWell` | `textSecondary` | `surfaceWell` | `textSecondary` | — |

Badge text 11/700, letterSpacing 0.4 (was 11/600 +0.3). Implement as a resolved
`badgeTones` map on the theme so screens never hand-mix.

**SectionHeader:** heading recipe unchanged (16/700); the action link color
`accent` → `accentDeep` (4.89 : 1); gains `marginTop: spacing.xl` (the rhythm
amendment). Optional future: none — keep it honest.

**TypeCaption / TypeMicro / TypeDisplay:** lineHeight + tracking per §2.1. No size
changes.

**LetterAvatar:** unchanged — it already works (colored tile + letter + clay material).
Only its shadow string updates via `clayShadowSm` v2 automatically.

**ChromeEdge (tab bar):** stops per §2.1 — the dark stop at 0.16 makes the metal ramp
drawable on the white bar. Radius 28 stays.

**Skeleton:** fill `subtleHover` → `surfaceWell` (a step warmer than the card it
forecasts); radius unchanged.

**Sheet:** scrim light `rgba(26,18,10,0.35)` → **0.45**, dark 0.55 → **0.62**; panel
top radius `RADIUS_CARD` → **`RADIUS_TILE` (24)**; the panel's hardcoded
`"0px -2px 18px rgba(42,32,24,0.18)"` (`sheet.tsx:248`) → `clayShadowSheet`; grip
28×4 → **32×4**. Spring/skirt mechanics untouched (R116-b is correct).

**Composer (chat dock):** input background `inputBg` → `surfaceWell` (with the existing
inputBorder hairline); the two hardcoded shadows (`composer.tsx:1673,1695`) →
`clayShadow2` / `clayShadowSm` tokens; send circle: `canSend ? accentDeep : subtleHover`
(light) / `canSend ? accentDark : subtleHover` (dark), icon color `accentText`. Dock
row keeps its top hairline `clayRim`.

**Transcript (chat):** user bubble fill `mixHex(card,accent,0.10)` → **0.16**
(`#F4E5DD`), edge 0.22 → **0.34** (`#EAC9BB`); dark fill 0.22 mix (`#584133`), edge
0.40 (`#75523E`). Ink text on the fill = 12.97 : 1. Assistant bubbles: card + rim +
`clayShadowSm` (automatic via the material change). Delivery ticks + the approval
glyphs' accent → `accentDeep`. Status chips (warning/danger mono lines) move to the
deep pairs per §2.1. Bubble radii unchanged (chat.md owns them).

### 2.3 Screen-class upgrades

**Hero moments (welcome, connect-unpaired, scan result):**

- Welcome: logo tile fill `card` → **`accentTint`** + `clayRim` + `clayShadow2`; the
  Smartphone glyph 30 → **32**, color `accentDeep` (4.35 : 1 on the tint). The idle
  float and entrance scale stay (motion.md §4.1 — already right). Feature-row icons
  migrate to `ClayIconChip`. The three-row card stack reads terracotta-tinted chips +
  warm card + real shadow — the brand moment the flat white tile never delivered.
- Connect hub (unpaired): the hero pair — phone chip gets `accentTint` + glyph
  `accentDeep` (the phone is "you"); desktop chip stays card-colored. Dashed link line
  color `textTertiary` (now legible at 5.23 : 1).
- Scan: **do not touch the viewfinder** (the monochrome treatment is the most
  professional surface in the app). Only the result card's tint 8 % → 12 % and the
  in-scanner option chips migrate to `ClayIconChip`.

**List screens (home, projects, approvals, more, activity):**

- Rhythm: §2.1's 12/32 cadence (scaffold gap + SectionHeader marginTop).
- Home's connection row: status word gets the deep state hue (Live = `#15803D`, probing
  = `#B45309`, offline = `#DC2626`; dark: `#4ADE80`/`#FBBF24`/`#F87171`) instead of
  ink; host label `textSecondary`; StatusDot 8 → **10 px**; chevron `textTertiary`
  (now visible). The row is the screen's status hero — it should read at a glance.
- Home's recent-activity rows: kind glyphs take the deep pairs (error `#DC2626`,
  approval `accentDeep`, quiet `textTertiary`); the preview card's inner rows sit on
  `surfaceWell` blocks (the card stays the container).
- The "New session" dashed row: dashed border color `accentDeep` at 40 % mix + label
  `accentDeep`; press fill `accentTint`.

**Dashboard (the data screen):**

- `StatCarouselCard`: minHeight 116 → **128**; the value renders at **`TYPE_STAT`
  28 mono-medium, −0.5 tracking** (the screen's numbers finally have a scale); the
  icon chip 26 → **30 px, r 10**, fill `accentTint` (hue rides the chip as today);
  label 11/700 +0.8 tracking uppercase (unchanged recipe, one weight up); caption
  `textTertiary` → `textSecondary`.
- The bar chart: gridlines dashed `borderSubtle` → dashed
  `rgba(38,34,28,0.14)`-class (one step stronger); bars gain `rx={2}` rounding; output
  hue → `#5E8E7E` (§2.1); tap-spotlight + grow animation untouched.
- The donut: `DONUT_STROKE` 6 → **8**; `DONUT_DIM_OPACITY` 0.55 → **0.35** (selected
  segment pops harder); track = `mixHex(card,"#2A2018",0.06)`.
- `ModelCarouselCard`: model dot 10 → **12 px** (identity readability at a squint);
  meta lines ride the fixed tertiary tier automatically.
- `ToolLeaderboardRow` sparkbar: track `borderSubtle` → `surfaceWell`, fill stays
  `accent` (3.9 : 1 vs card — bars are non-text, pass).

**Chat (session screen):** bubbles + composer per §2.2; the header identity bar keeps
LetterAvatar + kebab; header title 20/700 unchanged. The transcript's many mono
micro-lines inherit the tertiary fix (10–11 px text at 5.23 : 1 instead of 2.83 : 1) —
this alone transforms the chat's legibility.

**Tab bar (presence):** indicator fill `subtleHover` → **`accentTint`** (the selected
chip sits on a warm terracotta-tinted pill — One UI's signature move, in clay); the 2 px
`accentDeep` border stays. Active icon: size 22 → **23**, strokeWidth 2.4 → **2.5**,
color `accentDeep`; inactive icons: color `textTertiary` → **`textSecondary`** (they
were 40 %-black ghosts; 62 % reads as real chrome). Labels 11.5 (§2.1). Badge fill
`accentDeep` + `accentText`. Bar height/radius/ChromeEdge/measurement system untouched.

### 2.4 Motion (deliberately almost nothing)

The motion vocabulary is already professional and law-abiding — springs 180/22, sheet
210/30, tab 200/26, press 0.98, 30 ms stagger, 8 px entrance rise. **No timing changes.**
Two visual-only nudges: the pressed tint alpha 0.08 → **0.10** (press becomes
perceivable; still the "quiet instrument"), and nothing else. Reduced-motion paths are
already correct everywhere — the spec adds no continuous animations.

---

## §3 — Priority order + what NOT to touch

### The order (what moves the needle most, first)

1. **Wave 1 — tokens.ts + primitives.tsx (P0, one PR):** the surface ladder, ink
   ladder, accent tiers + `accentText` flip, shadow v2 strings, `clayRim`/`surfaceWell`/
   `accentTint`/deep pairs, badge tinted containers, `TYPE_STAT`, caption/micro
   line-heights, ClayCard/PressableCard/ChromeButton/Chip/SectionHeader/skeleton.
   This wave alone fixes §1.1–§1.3 and §1.6 on EVERY screen with zero screen edits.
2. **Wave 2 — chips + tab bar (P0):** `ClayIconChip` + the six migrations; tab-bar
   indicator tint, icon weights, 11.5 labels (label + measurement row together).
   Fixes the two most-seen surfaces (every list row, every root's bottom).
3. **Wave 3 — rhythm + dashboard (P1):** the 12/32 cadence in ScreenScaffold +
   SectionHeader; StatCarouselCard/TYPE_STAT, chart gridlines + rx + output hue,
   donut stroke/dim, model dots.
4. **Wave 4 — home status row + chat (P1):** deep status words + dot 10; bubble tints,
   composer well/send, sheet scrim/radius/shadow token, transcript deep hues.
5. **Wave 5 — hero moments + jewelry (P2):** welcome tile, connect pair chips, scan
   result tint, ChromeEdge stops, sheen alpha (rides Wave 1's token if trivial).

### What NOT to touch (already works — spend zero effort here)

- **The springs and every R116 mechanic:** sheet spring + skirt + clamp, the tab label
  morph + measurement row, the accordion measurement pattern, chart grow/donut sweep.
- **The structure laws:** archetypes, the single-line law, copy discipline and banned
  words, one-primary-per-screen, header-free roots, back-chip grammar, "New X" at list
  bottoms, no ripple, touch targets.
- **The scanner's monochrome viewfinder + portrait frame** — the most polished surface
  in the app.
- **LetterAvatar grammar, PROJECT_COLORS, the 12-hue model name-hash palette**
  (data encoding with PC parity — not decoration).
- **The wizard compositions** (welcome/connect centering, raised CTA grammar) — R116
  settled them; only their materials change via Wave 1.
- **Manrope/JetBrains as the faces; the type ladder's sizes** (only the AMENDMENT-4
  additions); **the five non-clay themes' identity** (they inherit the neutral legs for
  free — verify, don't redesign).

---

## §4 — The verification checklist

1. **Squint test (20 % zoom screenshot):** bg / card / well / accentTint must read as
   four distinguishable values on Home light AND dark; the tab bar must read as a
   distinct floating slab; the dashboard's biggest number must be the first thing the
   eye finds. If Home still reads as one sheet, the surface ladder failed.
2. **Contrast audit (recompute, do not eyeball):** every text token ≥ 4.5 : 1 on every
   surface it renders on (tertiary 5.23 card / 4.56 bg; secondary 6.18; accentDeep-as-
   text 4.89 light / 5.08 dark; CTA labels 4.98 light / 6.30 dark; every badge pair per
   the §2.2 table ≥ 4.5). Icons/glyphs/bars ≥ 3 : 1 (`accent` 3.9, `#5E8E7E` 3.65).
   One `node -e` mixHex+ratio script against the merged tokens — commit it next to the
   tokens as `__tests__/contrast.test.ts` so regressions fail CI.
3. **Dark-mode parity:** every new token resolves both branches; screenshot pairs
   (Home, Dashboard, Chat, Welcome, a Sheet, the tab bar) in both modes; the dark CTA
   shows INK on salmon, never white; the dark card top edge is visible (14 % mix).
4. **Reduced motion:** toggle the system setting — entrances snap, no new loops exist
   (the spec adds none); press states remain (state, not animation).
5. **Rhythm audit:** tab-root screenshots show 12 px intra-group and 32 px section
   breaks; no orphaned 16 px gaps between a SectionHeader and its first row.
6. **Tab-bar morph regression:** after the 11.5 label change, switch tabs rapidly —
   the pill must still wrap the chip exactly (the measurement row's font recipe must
   match the label's, byte-for-byte).
7. **The 8-pt discipline:** every new value sits on the 4 px grid (11.5 px type and
   1 px hairlines excepted, as the ladder already allows).
8. **Theme sweep:** flip through all six themes on Home + Dashboard — no theme regressed
   (they inherit neutrals/shadows; the clay-only values must not leak into the others'
   surface hexes).

---

*Prepared by the round-117-g styling agent (frontend-styling-expert). Diagnosis
evidence: `tokens.ts`, `primitives.tsx`, `tab-bar.tsx`, `sheet.tsx`, `composer.tsx`,
`transcript.tsx`, `usage-cards.tsx`, `screen-scaffold.tsx`, `home.tsx`, `welcome.tsx`,
`more.tsx`, `connect/index.tsx`, `model-colors.ts`, `chart-donut.ts` + the
design-language docs. Benchmarks: Material 3 (Expressive) surface-container + elevation
system, state layers, filled/outline icon states; Samsung One UI group cards, colored
icon containers, title scale; Telegram/WhatsApp bubble + chip contrast discipline.*
