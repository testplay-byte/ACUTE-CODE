<!-- last-reviewed: 2026-09-24 round-126 -->
# Tokens — the color, type, and spacing language

Serves DESIGN-SYSTEM §1 (source of truth), §2 (spacing), §3 (typography).
ROUND-100 (R100-C): revised per research §C1
(`docs/research/ui-design-language-round-100.md`) — the token system was
sound-but-unapplied with two token-level defects (a crowded type ladder
with no weight law, and no radius/border enforcement). Every revision
below is marked **ROUND-100 (R100-C)** and is enforced by
`scripts/design-audit.mjs` (`pnpm design:audit` — see USAGE §2).

**ROUND-126 (the Clay Companion redesign — the PC adopts the Android app's
design language, adapted):** clay is now the DEFAULT identity theme (a
one-time nova→clay migration), the identity faces are **Manrope + JetBrains
Mono** (the mobile app's faces — one product family; Space Grotesk is
retired from `--font-sans`), and the mobile constitution's **surface
ladder** (§10), **status grammar** (§11), and **two-tier accent** (§1d)
joined the pipeline. Every R126 change is marked **ROUND-126** and mirrors
`mobile/src/design/tokens.ts` (the mobile constitution,
`docs/design-language/android/`) — where the two documents disagree on a
shared surface, THIS file wins for the desktop, and the disagreement gets
an amendment note on both sides (never a silent edit).

## 1. The color pipeline (how a color reaches a pixel)

```
src/lib/themes.ts            THEMES (6 themes × light/dark)
      │  ThemeColors (~20 raw fields)
      ▼
deriveThemeStyles()           ThemeStyles (~35 derived keys:
      │                       bg/card/text/accent/borders/subtles/…)
      ├──►  useThemeStyles()  src/lib/use-theme-styles.ts — the JS hook
      │                       (inline styles for surfaces Tailwind can't reach)
      └──►  syncThemeCssVars()  ~30 `--ac-*` CSS vars on :root
              │
              ▼
     src/index.css  `@theme inline` maps vars → Tailwind utilities
              (bg-card, text-ink, border-line, bg-accent, …)
```

**Rules**

1. NEVER hard-code a hex/rgb in a component. If the pipeline can't express
   it, extend the pipeline (themes.ts) — do not bypass it.
2. Documented exceptions live in exactly four places:
   `src/lib/semantics.ts` (`SEMANTIC_COLORS`: success `#22c55e`, danger
   `#ef4444`, warning `#f59e0b`), the syntax palette
   (`src/components/project-chat/highlight.ts`), the usage-segment
   palette (`src/lib/menu-overlay.ts`), and the MODEL palette
   (`src/components/usage/usage-helpers.ts` — exception #4, round-98 I2:
   12 fixed light/dark hue pairs + the deterministic `modelColor(name,
   isDark)` hash, so the same model name paints the same color on every
   surface; hue identity is the data encoding, so it cannot flow from the
   theme pipeline). Anything else hard-coded is a bug (round-98 C2 hunts
   them; R100-C's audit rule R1 counts them).
3. Alpha tints ALWAYS via `withAlpha(color, 0.08–0.13)` from
   `src/components/dashboard/helpers.ts` — never string-suffix hex hacks
   (`#ef44441a` is a violation; round-97 already executed these).
4. **Prefer the CSS-var leg for anything with hover states.** A color that
   must respond to `:hover`, `group-hover`, or transitions belongs on a
   `--ac-*` var / Tailwind utility class — the JS-inline leg cannot express
   pseudo-states (the root cause of the ~90 hand-rolled hover handlers; new
   UI must not add to that count, and touched UI should retire them —
   enforced by audit rule R5).

### 1a. The neutral ramp — ROUND-100 (R100-C, research §C1.3)

"Pick a neutral" is a LOOKUP into the existing per-mode steps, never a hex
hunt. bg/card/text come from the active theme's table; the rest are the
mode-level overlays `deriveThemeStyles()` paints over them (identical in
every theme — only the mode flips them):

| Step | Light mode | Dark mode | Use |
|---|---|---|---|
| `bg` | `theme.bgLight` (per-theme) | `theme.bgDark` | app background |
| `frame` | `color-mix(bg 93%, text)` | same recipe | the ambient strip behind cards (`--ac-frame-bg`) |
| `card` | `theme.cardLight` (per-theme) | `theme.cardDark` | cards, panels, chrome surfaces |
| `subtle` | `rgba(0,0,0,0.04)` | `rgba(255,255,255,0.04)` | quiet fills, chips, identity-chip bg |
| `border` | `rgba(0,0,0,0.10)` | `rgba(255,255,255,0.10)` | 1px hairlines (dividers, inside-panel) |
| `border-strong` | `rgba(0,0,0,0.18)` | `rgba(255,255,255,0.18)` | hover border swap, top-level card lines |
| `text-tertiary` | `rgba(0,0,0,0.40)` | `rgba(255,255,255,0.40)` | meta, kickers, timestamps |
| `text-secondary` | `rgba(0,0,0,0.60)` | `rgba(255,255,255,0.60)` | descriptions, secondary labels |
| `text` | `theme.textLight` (per-theme) | `theme.textDark` | primary ink |

Accent discipline (ROUND-100, research §C1.3): the accent marks
**selection + the one primary action**; nothing else in working UI is
accent-colored at rest.

### 1b. The theme catalog — ROUND-126 (R126): **Clay Studio is the default**

Six themes: **Clay Studio (the default — ROUND-126, R126)**, Nova Cream,
Bento Blue, Midnight Lab, Sunset Pop, Mono Stone. Clay Studio is the clay
SUBSTRATE and the app's identity language: the mobile clay entry VERBATIM
(bg `#ECEEE8` / card `#FDFDFB` light — the round-117 surface-ladder
amendment, card-vs-bg 1.15:1; bg `#211B16` / card `#332C26` dark, 1.24:1),
warm ink (`#2A2018` / `#F2EBE1`), the two-tier terracotta accent (§1d),
and the taupe `accent2 #8A6A55`. A one-time migration walks existing
profiles off the never-re-designed nova default (theme-store.ts — both the
local persist leg and the server hydration leg); indigo/blue accents
remain banned as defaults house-wide. The other five themes ride the same
formulas (every §10/§11 token is computed, never clay-only) — a theme is
a palette choice, not a different material.

### 1c. The `--ac-*` var families (summary)

| Family | Vars | Used for |
|---|---|---|
| Surfaces | `--ac-bg`, `--ac-card`, `--ac-sidebar-bg` | app background, cards, chrome |
| Surface ladder (R126) | `--ac-surface-well`, `--ac-surface-header`, `--ac-accent-tint`, `--ac-clay-rim`, `--ac-clay-top-edge`, `--ac-mono-bg/border/text` | §10 — the Clay Companion elevation grammar |
| Text | `--ac-text`, `--ac-text-secondary`, `--ac-text-tertiary` | ink hierarchy (the ramp above) |
| Accent | `--ac-accent`, `--ac-accent-deep`, `--ac-accent-text`, `--ac-accent-faded`, `--ac-accent-soft`, `--ac-accent-tint` | brand moments, user bubbles, primary buttons (§1d) |
| Lines | `--ac-border`, `--ac-border-strong`, `--ac-border-subtle` | hairlines |
| Subtle | `--ac-subtle`, `--ac-subtle-hover` | quiet fills, hover washes |
| Inputs | `--ac-input-bg`, `--ac-input-border`, `--ac-input-focus-border` | fields, steppers |
| Shadows | `--ac-soft-shadow`, `--ac-bento-shadow` | depth (see MOTION.md for entry motion) |
| Clay depth (R108-e, R126) | `--ac-clay-shadow`, `--ac-clay-shadow-sm`, `--ac-clay-shadow-pressed`, `--ac-clay-shadow-sheet` | the clay material's layered soft shadows — §9 |
| Status (R126) | `--ac-success-deep`, `--ac-warning-deep`, `--ac-danger-deep`, `--ac-running-deep`, `--ac-badge-{tone}-{bg,fg}` | §11 — the status grammar (text + badge containers) |
| Chrome (R107-g) | `--ac-chrome-hi/mid/lo`, `--ac-chrome-sheen` | the liquid-chrome ramp — §8 below |

### 1d. The two-tier accent — ROUND-126 (R126, mobile AMENDMENT 3)

The accent is ONE family, two depths — never a second accent:

- **`accent`** (clay: terracotta `#C4653F` light / salmon `#D98A63` dark):
  markers, icons, tint fills, chart mass, dots.
- **`accentDeep`** (clay: ember `#B45330` light; collapses to the dark
  accent in dark mode): accent-as-TEXT and CTA fills — the tier that must
  hold ~4.5:1 as ink.
- **`accentText`**: clay's explicit pair — white on the ember light
  (4.98:1), warm ink `#211B16` on the salmon dark (6.30:1).

"One accent per screen" still holds: `accentDeep` is the same hue deepened
for contrast duty. Themes without an `accentDeep` field resolve it to
their own accent (identity). `text-accent-deep` / `bg-accent-deep` are the
Tailwind spellings; `styles.accentDeep` the JS leg.

## 2. The type scale (the canonical ladder) — ROUND-100 (R100-C, research §C1.1)

**ROUND-100 (R100-C) revision**: the old 8-step ladder sanctioned 8
sub-14px sizes with no weight law — the measured "AI-generated" tell (34
distinct `text-[Npx]` sizes in the tree, 101 sub-10px occurrences outside
onboarding). The ladder is now cliff-shaped and weight-governed:

| Token | Size / weight / line-height | Use |
|---|---|---|
| `display` | 56–104px / **600** / 0.95–1.05 | wizard + empty-state greetings only |
| `title` | 24px / **600** / 1.2 | page titles (Settings, Usage, Dashboard) |
| `section` | 13px / 600 / 1.4 | card + section headers |
| `body` | 13px / **400** / 1.55–1.65 | chat prose, settings descriptions |
| `body-strong` | 13px / 500 | active nav label, emphasized row |
| `ui` | 12px / 400 / 1.4 | secondary chrome, tab labels, toolbar labels |
| `label` | 11px / **500** uppercase / `tracking-[0.08em]` | THE ONE kicker idiom (`ui/Kicker`) |
| `meta-mono` | 10px / 400 mono / tabular | timestamps, chips, stat lines, model ids |
| `value` | 22px / 600 / 1.0 tabular | StatCard values |

**Enforced rules (ROUND-100 R100-C — audit rules R2/R3/R4 guard these):**

- **Hard floor 10px.** Kill 8 / 8.5 / 9 / 9.5px type (the 101 occurrences
  outside onboarding snap to 10 or 11).
- **No half-pixel steps.** 10.5→11, 11.5→12, 12.5→12 or 13, 13.5→13.
- **≤7 sizes visible on any one screen** — the ladder is a cliff
  (13→24→56), not a staircase; a screen quoting more than 7 steps is drift.
- **Markdown headings snap to 13px/600 (h3) and 12px/600 (h4–h6)** — kill
  the 15/13.5/12.5px heading sizes (`ChatMarkdown.tsx:839-841`).
- **THE WEIGHT LAW: 400 is the default everywhere in chrome; 500 =
  active/selected; 600 = section headers, titles, buttons; 700/900 =
  wizard display + StatCard value ONLY.** `font-bold`/`font-black`/
  `font-extrabold` outside `src/components/onboarding/` + the StatCard
  value is a bug (audit rule R4 counts them; ~26+ files today).

Fonts: **ROUND-126 (R126): Manrope is the identity face + JetBrains Mono
the machine face** — the mobile app's pair (one product family), bundled
locally in `src/assets/fonts/` (static TTFs, OFL). Space Grotesk (the
pre-R126 face) stays `@font-face`'d for the wizard's confetti reference
only and is retired from `--font-sans`. Manrope's weight axis maps exactly
onto the weight law above (400/500/600/700 + 800 for the wizard's display
tier — the one place 800 is legal). One reading size per surface;
hierarchy comes from weight/color (`text` → `text-secondary` →
`text-tertiary`), never from inventing a 9.75px. The chat's text-size
ladder (S/M/L, ±12%, `--ac-chat-scale`) scales the three reading surfaces
(.chat-prose/.chat-thinking/.chat-narration) — never the chrome.

## 3. Spacing + density — ROUND-100 (R100-C, research §C1.2)

**ROUND-100 (R100-C) revision**: 4px base grid, 8px rhythm — the scale is
**4 / 8 / 12 / 16 / 24 / 32 / 48 / 64**. The old "pad-2/pad-3 (2px/3px)"
chat-route exception is reduced to: seam gaps 4px (`SEAM_GAP` 3→4). Paddings
step on the rhythm; never 13/18/22. The transcript's graduated padding
(24→48→64px) stays the sanctioned exception for reading comfort.

### The row-height table (ROUND-100 R100-C — IDE density)

| Surface | Height |
|---|---|
| Sidebar nav row (top-level) | **32px** (was 40/44) |
| Sidebar project row | 30px |
| Sidebar session row | 26px |
| Settings nav row | 30px |
| Settings control row (label + control) | **36px** (`ui/SettingsRow`) |
| Chat tool row | 28px |
| WorkingSection header | 28px |
| Composer toolbar | 36px |
| Right-sidebar toolbar | 36px |
| Chat turn gap (between turns) | 24px |
| In-turn segment gap | 8px |

Chrome widths (ROUND-100 R100-C): sidebar **240px** (was 270 — VS Code's
300 is for trees; ours is nav), rail **48px** (the activity-bar standard,
was 64). Icon sizes: **16px** nav/chrome, **14px** toolbar, **12px**
rows/chips, **11px** only inside 20px chips. Every icon button keeps a
**≥28×28px** hit target. The chat route stays borderless (surfaces + gaps);
every other route keeps the bento card + 1.5px line borders. Drag handles
stay 5px.

## 4. The radius scale — ROUND-100 (R100-C, research §C1.4)

**ROUND-100 (R100-C) revision**: 5 steps, expressed through Tailwind's
default scale (same pixels, no arbitrary values — audit rule R2 counts
`rounded-[Npx]` spellings):

| Step | Radius | Tailwind | Use |
|---|---|---|---|
| 1 | **4px** | `rounded-sm` | inline code, checkboxes |
| 2 | **8px** | `rounded-lg` | buttons, chips, inputs, toolbar pills |
| 3 | **12px** | `rounded-xl` | code blocks, popovers, dialogs, composer, user message |
| 4 | **16px** | `rounded-2xl` | cards, panels, the chat window card (was 24) |
| 5 | **999px** | `rounded-full` | pills |

The wizard keeps its **18–24px signature radii as the documented
exception** (WIZARD-DNA §4). Kill every other arbitrary radius
(`rounded-[7px]`, `[9px]`, `[10px]`, `[14px]`, `[18px]`, `[20px]` — the
40× in ModelsProvidersTab etc. all snap to the scale).

## 5. Borders + elevation — ROUND-100 (R100-C) — **ROUND-126 (R126): the clay rim supersedes the bento border on cards**

- **1px hairlines** for dividers, inside-panel lines, table rows.
- **ROUND-126 (R126, mobile AMENDMENT 1): the default card edge is the
  warm `clayRim` hairline on all four sides** (`border-clay-rim` /
  `.ac-clay-rim`; light: 10% ink into card — `#E8E7E4` on clay; dark:
  10% white) + the dark-mode-only matte top edge
  (`.ac-clay-edge-dark`, 14% white — light mode never paints it). The
  **1.5px bento border on top-level cards is RETIRED** with the redesign
  (the border-forward bento look was the nova-era dialect; the clay
  material's edge is the rim + the §9 shadow form). Existing 1.5px borders
  ride until each screen's redesign pass converts them — the audit counts
  only go down.
- **2–2.5px** borders are wizard-only.
- Elevation: **ROUND-126**: the clay shadow family (§9) is THE elevation
  grammar for carded surfaces (`--ac-clay-shadow` cards/heroes,
  `-sm` compact tiles, `-pressed` the press collapse, `-sheet` upward
  docks/toasts); `softShadow` survives for floating overlays that need
  neutrality (menus, the ⌘K palette) — both are pipeline tokens. The
  `bentoShadow` hard offset is **wizard + primary CTA only** (WIZARD-DNA
  §7) and is progressively retired from working screens (Dashboard /
  Usage heroes first).

## 6. Interaction states — ROUND-100 (R100-C, research §C1.5)

- **Hover (ROUND-100 R100-C):** every interactive row = the `hover:bg-hover`
  bg wash (the CSS-var leg), **80–120ms, no translate/scale**. Hover is a
  CSS class — NEVER a JS `onMouseEnter`/`onMouseLeave` handler (TitleBar
  shows the pattern; audit rule R5 counts the violations). Retire all
  `onMouseEnter` handlers outside onboarding.
- **Focus (ROUND-100 R100-C):** ONE global rule — an accent ring, 2px,
  2px offset:
  `:where(button, a, input, textarea, select, [tabindex]):focus-visible { outline: 2px solid var(--ac-accent); outline-offset: 2px; }`
  — then the `outline-none` uses each get audited to confirm a visible
  replacement. Normative for every wave; lands in `src/index.css` with the
  first applying wave (D — chat) so all later screens inherit it.
- **Press:** keep the universal `active:scale-[0.98]` contract; DELETE
  `hover:scale-105` from working chrome (composer Send/Stop/Queue) —
  resting UI never fidgets.
- **Selection:** accent text + `bg-accent-soft` + a 2px accent bar on the
  leading edge (the provider-list grammar, COMPONENTS §5 — apply it to
  Sidebar nav + settings nav).

## 7. Semantic colors (the only fixed hues)

| Name | Hex | Means |
|---|---|---|
| success | `#22c55e` | completed, healthy, verified |
| warning | `#f59e0b` | wait/attention: retry waits, queued, thinking-loop stops |
| danger | `#ef4444` | failure, destructive, error — `role="alert"` surfaces |
| running | `#3b82f6` | in-flight tool rows (informative "happening now" — R98-C2's `RUNNING_BLUE` in semantics.ts, the fourth exception) |

Warning and danger are NEVER interchangeable (round-97 D: a thinking-loop
stop is amber `role="status"`, never red "Generation failed"). Danger tints
via `withAlpha(danger, 0.08–0.1)` for washes; success tints 0.08 for
confirmation glows.

## 8. The liquid-chrome ramp — ROUND-107 (R107-g), quieted ROUND-108 (R108-e)

Owner direction (round-107): "go with the Clay Studio aesthetic and also a
mixture of liquid chrome… the overall UI looks much better, much more
proper, and much more well-handled." The mixture's division of labor:
**clay is the substrate** (backgrounds, cards, chrome surfaces — delivered
by the Clay Studio theme, §1b, + the shadow material §9), **liquid chrome
is the jewelry** (the one primary action's sheen, the hero metal block —
delivered by this var family + the `.ac-chrome-*` pattern classes in
`src/index.css`, composition rules in COMPONENTS §8). R108-e (owner:
"you implemented clay but it was not implemented properly… at the very top
you implemented some glow fade"): every chrome effect that read as a GLOW
is gone (the `.ac-chrome-edge` hairline + `.ac-clay-light` top-light were
deleted); what survives is the metal ramp + a much quieter sheen.

| Var | Light mode | Dark mode | Role |
|---|---|---|---|
| `--ac-chrome-hi` | `#FFFFFF` | `rgba(255,255,255,0.55)` | the metal ramp's bright stop |
| `--ac-chrome-mid` | `#EDE8E0` | `rgba(255,255,255,0.08)` | the platinum body of the metal ramp |
| `--ac-chrome-lo` | `#D8D1C6` | `rgba(255,255,255,0.03)` | the metal's shaded edge |
| `--ac-chrome-sheen` | `rgba(255,255,255,0.30)` | `rgba(255,255,255,0.10)` | the moving highlight band — HALVED in R108-e from 0.55/0.16 (jewelry at a whisper) |

Rules:

1. **Theme-independent, mode-aware.** The ramp is set by
   `syncThemeCssVars()` from `isDark` alone — liquid chrome reads as the
   same platinum on every palette (jewelry, not cloth). It is NOT a
   ThemeColors field and must never become one.
2. **Warm platinum on purpose.** The light-mode stops are a hair warm
   (`#EDE8E0`, not `#E8E8E8`) so chrome harmonizes with the clay substrate
   instead of reading cold against it.
3. **Values live in the pipeline only** — `themes.ts` (the bridge) +
   the `:root` pre-paint fallbacks in `src/index.css` (the same sanctioned
   pattern as the nova literals). A component writing a metal hex itself
   is an audit R1 violation like any other.
4. **Ink on full-metal surfaces is `--ac-text`** (dark-on-platinum in
   light mode, light-on-dark-metal in dark mode — contrast holds by
   construction). Never `--ac-accent-text`.
5. The sheen MOTION contract (ambient 9s pass, transform-only,
   reduced-motion collapse) is documented in MOTION §3 — the animation
   grammar owns the movement, this file owns the color. R108-e: the sheen
   is signature-surface-only and QUIET — the band is half as wide and
   half as bright as the R107-g original; if it draws attention to
   itself, cut it further, never louder.

## 9. The clay shadow material — ROUND-108 (R108-e) — **ROUND-126 (R126): retuned to the mobile v2 strings**

Owner verdict on R107-g's execution (v1.0.3): "You implemented clay but it
was not implemented properly. At the very top you implemented some glow
fade and other stuff like that." The lesson, as language: **clay is a
FORM, not a paint.** Depth comes from layered soft shadows over matte
theme fills with the existing hairline borders — NEVER from gradient
top-lights, washes, or light fades drawn over a card (the deleted
`.ac-clay-light`/`.ac-chrome-edge` were exactly that mistake).

| Var | Light mode | Dark mode | Role |
|---|---|---|---|
**ROUND-126 (R126): the strings are the mobile v2 two-leg grammar
VERBATIM** (mobile tokens.ts:494-512) — alphas that actually draw (contact
10–14%, ambient 14–24%; the pre-R126 8–14% ambient legs were below the
perception floor), warm ink moved to the mobile value `rgba(38,34,28,…)`
(R114-c's half-step cooler warm ink — never reads ORANGE against the
#ECEEE8-class whites, never the forbidden cold blue-black). Two NEW steps
joined: `-pressed` (the press collapse — the contact leg alone) and
`-sheet` (the UPWARD shadow for docks/toasts — anything that rises casts
its shadow up).

| Var | Light mode | Dark mode | Role |
|---|---|---|---|
| `--ac-clay-shadow` | `0px 2px 4px rgba(38,34,28,0.14), 0px 12px 32px -8px rgba(38,34,28,0.24)` | `0px 2px 4px rgba(0,0,0,0.45), 0px 14px 36px -8px rgba(0,0,0,0.60)` | the clay card: tight contact + large soft ambient |
| `--ac-clay-shadow-sm` | `0px 1px 2px rgba(38,34,28,0.10), 0px 3px 10px -4px rgba(38,34,28,0.14)` | `0px 1px 2px rgba(0,0,0,0.35), 0px 4px 12px -4px rgba(0,0,0,0.45)` | the small-surface step (compact tiles, chips) |
| `--ac-clay-shadow-pressed` | `0px 1px 2px rgba(38,34,28,0.12)` | `0px 1px 2px rgba(0,0,0,0.40)` | the press collapse target |
| `--ac-clay-shadow-sheet` | `0px -2px 6px rgba(38,34,28,0.12), 0px -12px 32px -8px rgba(38,34,28,0.22)` | `0px -2px 6px rgba(0,0,0,0.50), 0px -14px 36px -8px rgba(0,0,0,0.65)` | upward: docks, toasts, rising surfaces |

Rules:

1. **Mode-aware, theme-independent** — same pipeline slot as
   `softShadow`/`bentoShadow` (set by `deriveThemeStyles()`, bridged by
   `syncThemeCssVars()`, pre-paint `:root` fallbacks in `src/index.css`).
   On the Clay Studio theme the warmth reads as hand-thrown ceramics; on
   every other theme as a tactile card — the recipe never changes per
   theme.
2. **Two legs, always**: a TIGHT directional contact shadow (small blur,
   1–2px offset — the card resting on the surface) under a LARGER very
   soft ambient one (big blur, negative spread so it feathers). A
   one-legged shadow is not the clay material.
3. **Warm tint in light mode** — `rgba(42,32,24,…)` (the clay ink
   `#2A2018` family): ceramics cast warm shadows, never cold black. Dark
   mode deepens toward black for real lift on the dark substrate.
4. **Consumed via the `.ac-clay` / `.ac-clay-sm` pattern classes**
   (`src/index.css`, COMPONENTS §8) — the classes paint `box-shadow` only,
   so they compose with any inline `backgroundColor` exactly like the old
   inline `softShadow` leg did. A component inlining these values is a
   one-off (the §1 rule 1 discipline).
5. **The desktop sanctions layered soft shadows** (this section +
   `softShadow`/`bentoShadow` in COMPONENTS §3): the "flat, no shadows"
   law is the MOBILE surface's own rule (MOBILE-ARCHITECTURE), never the
   desktop's. The chat route keeps its borderless/no-shadow language
   (COMPONENTS §3 species 2) — clay depth belongs to CARDED surfaces.

## 10. The surface ladder — ROUND-126 (R126, mobile round-117-elevation)

The Clay Companion elevation grammar: a card is not "white on gray" — it is
ONE step UP from the background (the §9 shadow form + the §5 rim), and the
surfaces INSIDE a card step DOWN into recesses. Every token is computed in
`deriveThemeStyles()` (mode-aware, theme-derived — all six themes get them
free) and rides the `--ac-*` bridge + the Tailwind `@theme` leg.

| Token | Light (on clay) | Dark (on clay) | Tailwind / class | Role |
|---|---|---|---|---|
| `surfaceWell` | `#F4F1EE` (8% taupe `#8A6A55` into card) | `#3D3731` (5% white) | `bg-well` / `.ac-well` | THE recess: accordions, activity wells, input fills, skeletons, recent-activity rows. Supersedes the invisible 2% `subtle`-as-recess. |
| `surfaceHeader` | `#E0E2DC` (bg +6% warm ink) | `#17130F` (bg +30% black) | `bg-header-surface` | in-flow chrome shade — header columns, the chat top strip, column headers pulled through insets. |
| `accentTint` | `#F6EBE4` (12% accent into card) | `#513D31` (18%) | `bg-accent-tint` | hue without loudness — icon chips, the selected-marker fill, hero tiles. |
| `clayRim` | `#E8E7E4` (10% ink into card) | `rgba(255,255,255,0.10)` | `border-clay-rim` / `.ac-clay-rim` | the default card edge, all four sides (§5). |
| `clayTopEdge` | *(light value unused)* | `#504A44` (14% white) | `.ac-clay-edge-dark` | the matte top-edge highlight — a DARK-MODE-ONLY device (mobile AMENDMENT 1; the class suppresses it in light mode). |
| `monoBg/Border/Text` | `#F0F0ED` / `rgba(42,32,24,0.10)` / `#3A2E22` | `rgba(0,0,0,0.22)` / `rgba(255,255,255,0.08)` / `rgba(242,235,225,0.92)` | `bg-mono-block` + `text-mono-ink` / `.ac-mono-block` | the recessed mono surface — terminal output, command blocks, code output tails. |

**The ladder laws (mobile round-117, binding):**

1. **Card-vs-bg must be a VISIBLE luminance step** — 1.15:1 light / 1.24:1
   dark (the round-117 amendment restored these from the mathematically
   invisible 1.08/1.11). If a card reads as its background, the ladder is
   broken.
2. **One step per rung.** bg → card (up, shadow+rim) → well (down, rim
   hairline) → mono block (down, own ink). Never two steps in one jump,
   never a "raised" tint on a card (the 2% `surfaceRaised` was killed on
   mobile for a reason).
3. **The well is the workhorse recess.** Anything that reads as "content
   sunk into the card" (activity wells, input fills, terminal bodies,
   skeleton blocks) uses `surfaceWell` + the rim hairline — not `bg-subtle`,
   not alpha hacks.
4. **Skeletons ride the well** (`bg-well` at 0.45↔0.85 opacity pulse —
   MOTION §4), never plain `bg-subtle`.

## 11. The status grammar — ROUND-126 (R126, mobile R117-g1 §2.2)

**Flat hues are for DOTS ONLY.** Status TEXT and every Badge/chip ride the
**deep/bright pairs** on **tinted containers** — never white-on-saturated
fills, never flat-hue text on card:

| Tone | Container (light) | Ink (light) | Ink (dark) | Tailwind |
|---|---|---|---|---|
| success | `#E3F6E8` | `#166534` | `#4ADE80` | `bg-badge-success` + `text-badge-success-fg` |
| warning | `#FCF2DE` | `#92400E` | `#FBBF24` | `bg-badge-warning` + `text-badge-warning-fg` |
| danger | `#FBE7E5` | `#B91C1C` | `#FCA5A5` | `bg-badge-danger` + `text-badge-danger-fg` |
| running | `#E6EEFA` | `#1D4ED8` | `#93C5FD` | `bg-badge-running` + `text-badge-running-fg` |
| accent | `accentDeep` fill | `accentText` | `accentText` | `bg-badge-accent` + `text-badge-accent-fg` |
| neutral | `surfaceWell` | `textSecondary` | `textSecondary` | `bg-badge-neutral` + `text-badge-neutral-fg` |

- Containers = 12% of the flat hue into the card (light) / 20% (dark);
  every pair holds ≥4.5:1 in both modes (the mobile contrast floor).
- **Status TEXT** (without a container) uses `text-success-deep` /
  `text-warning-deep` / `text-danger-deep` / `text-running-deep` — the same
  deep/bright pairs (`#15803D`/`#4ADE80`, `#B45309`/`#FBBF24`,
  `#DC2626`/`#F87171`, `#1D4ED8`/`#93C5FD`).
- The JS leg: `styles.badgeTones[tone]` (`{bg, fg}`) and
  `styles.successDeep` etc. from `useThemeStyles()`.
- The expiry/attention ladder: warning first, danger only for hard failure
  (an expired pairing window is a warning, not an error — mobile law).
