<!-- last-reviewed: 2026-09-20 round-115 -->

# Foundations — Tokens

Source of truth in code: `mobile/src/design/tokens.ts` (516 lines) + `useTheme()` from
`mobile/src/design/theme.tsx`. **Never hardcode a color, radius, or size in a screen.**
If a value is missing from the contract, add it to `tokens.ts` and consume it.

## 1. Color pipeline

```
THEMES[6] × (light|dark)  →  resolveTheme(themeId, isDark)  →  ResolvedTheme
      →  useTheme().tokens   (the ONLY way a screen sees color)
```

- Six themes; default **Clay Studio** (`clay`): accent `#C4653F` (dark `#D98A63`),
  bg `#F3F4F0` / `#26211C`, card `#FDFDFB` / `#2F2924`, ink `#2A2018` / `#F2EBE1`.
- **Indigo and blue are banned as accents or defaults** (semantic `running` blue is the
  only sanctioned blue, for live/running state).
- Semantic fixed colors: danger `#ef4444`, success `#22c55e`, warning `#f59e0b`,
  running `#3b82f6`. The **expiry/warning stage** (countdown-zero, "rescan" states) uses
  `warning` first, `danger` only for hard failure — an expired pairing window is a
  warning, not an error.
- Data-viz hues: `CHART_HUES` (terracotta/sage/violet + rank hues, dark variants) — the
  same entity keeps the same hue across chart + legend + list (donut, leaderboard).

## 2. The clay material (form, not painted light)

- **Two-leg warm shadows**: `clayShadow1` (list cards), `clayShadow2` (heroes, tab bar),
  `clayShadowSm` (chips), `clayShadowPressed` (tight leg). Warm ink `rgba(38,34,28,…)`
  light / black dark. Cold blue-black shadows banned.
- **Matte top edge**: hairline `borderTopWidth` + `clayTopEdge` (55% white mix light,
  6% dark) — a solid 1px line on the TOP edge only.
- **Chrome jewelry — exactly 3 surfaces** (tab bar edge, primary button sheen, selected
  marker ring). Round-115 amendment: the primary button's sheen is **removed from
  onboarding CTAs** — Get Started / Allow camera / Scan enter as flat accent clay
  (radius 14, `clayShadow2`, press scale 0.98). Chrome sheen survives only on
  in-app primary actions (`ChromeButton` default), never on wizard screens.

## 3. Spacing ladder (8pt-ish)

`xs 4 · sm 8 · md 12 · lg 16 · xl 20 · xxl 24 · xxxl 32 · huge 48`

- Screen gutters: `spacing.lg` (16) standard, `spacing.xl` (20) on chromeless roots.
- Card padding: `spacing.lg` standard, `spacing.md` compact rows, `spacing.xl` heroes.
- List gaps: `spacing.md` (12) between rows, `spacing.lg` between sections.
- Sheet padding: `spacing.xl` horizontal inside sheets (roomier than cards).

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
- Keyboard: the chat dock owns `ADJUST_NOTHING`; sheets ride the Modal host.

## 6. Typography ladder (see `typography.md` for the law)

| Tier | Size/Weight | Use |
|---|---|---|
| display | 28/800 | One per wizard screen max |
| title | 20/700 | Page heroes |
| heading | 16/700 | Card titles |
| body | 15/400 | Body, option labels |
| body-strong | 15/600 | Row titles |
| caption | 12.5/500 | One-line descriptions |
| micro | 11/600 | Kickers, meta (all-caps via style, never hardcoded) |
| mono | 13/400 + JetBrains Mono | Paths, ids, commands, PIN |

## 7. Iconography

- `lucide-react-native`, stroke 2 (2.2–2.4 on active/accent).
- Icon chips: 40×40 r14 (list rows), 44×44 r15 (hero), 48–56px r16–18 (wizard options).
- **Letter avatars** (round-115): project identity = first letter, `TypeBodyStrong`
  white, centered in a `round`ed square filled with the project's theme color (the six
  `PROJECT_COLORS`), sized 36–44px. The colored dot is retired.
