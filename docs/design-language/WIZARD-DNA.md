<!-- last-reviewed: 2026-09-18 round-107 -->
# Wizard DNA — the owner-approved aesthetic, extracted

Owner direction (round-98): "our setup page is quite good. It is proper and
it does look good… It is a good starting point. You can document the things
which are there as part of our design language."

The setup wizard (`src/components/onboarding/`) is the app's reference for
**delight**: the one surface the owner has praised. These are its patterns,
extracted so the rest of the app can borrow them BY SPECIFICATION, not by
copy-paste. Use them where a moment deserves energy — hero/empty states,
completion moments, the greeting, the setup flow. Do NOT wallpaper the
working UI with them (a chat transcript full of glows is slop in the other
direction).

## 1. The ambient stage

- **Full-bleed themed background** — the page IS the theme's `bg`, edge to
  edge.
- **Dot grid**: 28px grid, theme ink at 4% — texture without noise.
- **Three ambient glows** (R107-g refresh): two accent-colored radial
  washes + ONE liquid-chrome wash (the `--ac-chrome-hi` glint color at 18%,
  blurred 70px, top-right-mid) — the stage carries both halves of the
  round-107 direction: warm clay/accents below, one cool platinum light
  above. `blur(70–90px)`, deliberately off-center (top-left, right-mid,
  bottom-left), opacity low enough to read as light, not decoration.
- **Floating decorations**: `animate-float` / `animate-float2` — slow
  vertical drifts (6–8s, ±8px), staggered phases, never more than three
  on screen.

## 2. Display typography

- The hero moment (`ACUTE CODE.`): 56–104px, `font-black`, tight tracking;
  the `CODE.` block is **liquid chrome** (R107-g) — the `.ac-chrome-metal`
  platinum ramp + `.ac-chrome-sheen` ambient pass, ink in the theme's text
  color (TOKENS §8). The accent stays the badge's + CTA's job; the brand
  block is the one metal jewel of the composition. Supports with
  `title`-tier lines beneath.
- **Pill badges** announce flavor (`rounded-full`, subtle bg, tracked
  label); `vX BETA` chips ride as `meta`-type mono suffixes.
- Numbers rendered as a **stats trio** (three big-number + label columns)
  when a screen needs to feel substantial.

## 3. The step grammar

- **Step transitions**: `.wizard-step` 320ms, fade + y-slide (12px),
  the `ease`.
- **Step indicator**: morphing dots — 24px for current, 14px for done,
  10px for upcoming; the active dot carries the label; transitions morph
  size (200ms), never jump.
- **Short-view respect**: `short:` variant (≤760px viewport height)
  compresses the rhythm (smaller display type, tighter stacks) — the
  layout adapts to the window, never scrolls awkwardly.

## 4. The signature card

- Radius 18–24px (rounder than working UI's 16px).
- Border 1.5–2.5px — the border IS the design; on hover it strengthens.
- `softShadow` / `bentoShadow` (the hard offset) — depth with character,
  not blur-mush.
- **Deliberate imperfection**: micro-rotations (`rotate-[-1deg]`) on
  secondary elements; hover translates + counter-rotates them back to
  square. One rotated element per composition, maximum.

## 5. The terminal moment (the brand's smile)

A card styled as a terminal: macOS traffic-light dots (12px, gap 8px,
semantic red/amber/green at 80%), mono body, 22ms/char typed reveal,
cursor block. Used exactly once per flow — at the first impression.

## 6. Keycaps

`kbd` styling: `meta`-type mono, subtle bg, hairline border + bottom border
2px (the key's edge), 4px radius, 2px y-offset press on activation. Used
for shortcut hints (`⌘K`, `Enter`, `Esc`) — always functional, never
decorative.

## 7. The ActionButton (the primary CTA grammar)

- 135° accent→accent2 gradient fill, white ink, `bentoShadow`.
- R107-g: the liquid-chrome sheen rides the ENABLED primary
  (`.ac-chrome-sheen`, the 9s ambient pass, MOTION §3) — the accent
  gradient keeps the action's identity; the chrome is the jewelry.
- Hover: `scale-[1.03]` + shadow bloom (150ms). Press: `scale-[0.98]`.
- The hint keycap rides inside-right (`Enter ↵`) when the action is the
  flow's obvious next step.
- Secondary actions are quiet pills — never two gradient buttons in one
  view.

## 8. When to borrow which

| Surface | Borrow |
|---|---|
| First-run / setup / onboarding | everything — it IS the DNA |
| Empty states (no projects, no sessions) | ambient stage (1 glow), display type (smaller), one signature card |
| Completion moments (task done, all-set) | stats trio + ActionButton grammar |
| Settings headers | pill badges + `label` type — quiet, no glows |
| Working surfaces (chat, browser, files) | none — quiet focus; depth via cards/motion grammar only |
