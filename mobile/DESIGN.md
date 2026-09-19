<!-- last-reviewed: 2026-09-19 round-109 -->
<!-- status: the MOBILE design-language contract — the owner's R109 direction:
     "a combination of Clay Studio, the 3D kind of vibe... some combination of
     liquid Chrome UI design style aesthetics with the borders and such. Don't
     go with too many shiny borders but give some borders some depth." This is
     the sibling of the desktop language (docs/design-language/) — same clay
     substrate, same rationed chrome, adapted to Android's material truths
     (elevation, edge-to-edge, touch targets). -->

# DESIGN.md — the ACUTE companion's design language

The one contract every mobile screen builds against. Clay is the
**substrate**; chrome is the **jewelry** — rationed. Nothing painted-glow,
nothing shiny-slashy: the R108-e lesson (the desktop verdict) carries over
unchanged.

## §1 Clay — the substrate (form, not painted light)

Clay Studio reads as **molded material**: warm sand surfaces, generous
radii, and shadows that say "this object rests on that surface." Depth
comes from the shadow pair + a matte top-edge highlight — never from a
gradient wash or a glow.

- **The two-leg clay shadow** (RN `boxShadow` — supported on the new
  architecture, RN 0.86):
  - elevation 1 (list card): `0px 1px 3px <ink-warm α.08>, 0px 8px 24px -6px <ink-warm α.10>`
  - elevation 2 (floating bar): `0px 2px 6px <ink-warm α.10>, 0px 16px 40px -8px <ink-warm α.14>`
  - Light-mode legs are **warm-tinted** (`rgba(42,32,24,…)` — ceramics cast
    warm shadows, never cold black); dark-mode legs deepen toward black.
- **The matte top-edge highlight**: a 1px lighter hairline on the card's
  TOP edge only (`borderTopWidth: 1`, `borderTopColor: card+6% white light /
  +3% dark`), suggesting a molded surface catching room light. It is a
  SOLID hairline — the honest cousin of the desktop's deleted
  `.ac-clay-light` gradient, and it is never animated, never saturated.
- **Radii**: card 20, tile 24, floating bar 28, input 14, pill 999.
- **Press grammar**: scale 0.98 + shadow collapses to the tight leg only.

## §2 Chrome — the jewelry (rationed)

Liquid chrome appears on **exactly three surfaces**, always subtle:

1. **The floating tab bar's edge** — a 1px linear-gradient hairline
   (perpendicular metal ramp: light→dark→light, ~8% alpha) wrapping the
   bar's clay slab, plus a faint sheen overlay (`expo-linear-gradient`,
   white α.04→.00, top 40%).
2. **Primary CTAs** (Pair, Approve, Send) — accent fill + a soft vertical
   sheen: white α.10 → α.00 across the top half. Read as "one quiet
   glint," not a mirror.
3. **Selected/active markers** (the focused tab icon, the active filter
   chip) — a thin chrome ring (2px gradient border wrapper) around the
   accent dot/tile.

Everything else: plain hairline borders (`border` tokens) or none. A
border may carry depth (the top-edge highlight above); it may NOT carry
shine. **No second surface in the app gets a gradient border.**

## §3 The clay palette (the default theme)

Clay Studio is the phone's default — the desktop's own §1b palette,
carried over verbatim so both ends read as one household:

| Token | Light | Dark |
|---|---|---|
| bg | `#F4EEE5` | `#26211C` |
| card | `#FDFBF7` | `#2F2924` |
| ink | `#2A2018` | `#F2EBE1` |
| accent | `#C4653F` | `#D98A63` |
| accent2 | `#8A6A55` | `#B09380` |

The other five themes (Nova, Bento, Midnight, Sunset, Mono) survive as
picker options, re-tuned to the same warm-shadow grammar. Indigo/blue stay
banned as defaults (house rule); Bento survives as an opt-in theme only.

## §4 Typography — Manrope, the house font

**Manrope** (bundled via `@expo-google-fonts/manrope`; weights 400, 500,
600, 700, 800). Geometric, softly-rounded terminals — the typographic
voice of molded clay. System mono for code (`JetBrains Mono` bundled for
settled code blocks; system fallback while streaming).

| Role | Size | Weight | Line height | Color |
|---|---|---|---|---|
| display (large title) | 28 | 800 | 34 | ink |
| title (screen header) | 20 | 700 | 26 | ink |
| heading (section) | 16 | 700 | 22 | ink |
| body | 15 | 400 | 22 | ink |
| body-strong | 15 | 600 | 22 | ink |
| caption | 12.5 | 500 | 16 | textSecondary |
| micro (badges/labels) | 11 | 600 | 14 | token-scoped |
| mono | 13 | 400 | 19 | mono-ink |

Rules: bold only where hierarchy demands (headings, key numbers); never
bold entire paragraphs; secondary text at 62% ink; tertiary at 40%;
accent color for interactive affordances and live states, never for long
body text.

## §5 Layout — adaptive, edge-to-edge, floating chrome

- **Edge-to-edge** everywhere: `react-native-safe-area-context` insets
  drive all padding; no hardcoded status-bar heights.
- **The floating tab bar**: horizontal margin 12, bottom margin
  `max(insets.bottom, 8)`, radius 28, elevation 2 clay shadow + chrome
  edge (§2.1). Content scrolls UNDER it (the screens own a bottom
  content inset of bar-height + margins).
- **Headers**: large-title (display type) with a subtitle line, collapsing
  to a compact title on scroll (later: pinned compact header). The
  connection pill (§6) lives in the header's right slot on every tab.
- **Touch targets**: ≥44px everything interactive; list rows ≥64px.
- **Spacing**: 4/8/12/16/20/24/32 grid; screen gutters 16 (phones) →
  24 (≥768dp breakpoints via `useWindowDimensions`).
- **Keyboard**: `react-native-keyboard-controller` — inputs never sit
  under the keyboard; the floating bar hides while the keyboard is up.

## §6 The connection pill — status, always visible

A small pill in every tab's header (and pushed screens' compact headers):
- `connected` — accent dot (steady) + "live"
- `probing` — accent dot pulsing + "connecting…"
- `offline` — warm-warning dot + "offline" (tapping opens the connect hub)
- `unpaired` — "link a device" chip (tapping → connect hub)

It is the owner's "it would not show me that it has disconnected" fix made
structural: the truth is on screen, on every screen, at all times.

## §7 Motion & haptics

Springs only (stiffness 180, damping 22 — the house spring). Entrance:
fade-up 8px, 30ms stagger. Press: scale 0.98. Tab switch: indicator slides
(spring). Haptics: `selection` on tab/chip taps, `success` on pair +
approve + send, `warning` on hard errors. No bounce, no parallax, no
shimmer on content.

## §8 What this language forbids (the R108-e lesson, carried to Android)

- gradient glow/fade washes on resting surfaces
- shiny hairline glints on working UI (only the three §2 surfaces get chrome)
- cold blue-black shadows (always warm ink family)
- bold-everything typography; neon accents; mirror finishes
- any border that animates its shine
