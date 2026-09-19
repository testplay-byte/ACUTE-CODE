<!-- last-reviewed: 2026-09-19 round-108 -->
# Window controls — the app-frame spec

Owner direction (round-98): "One thing which I do like about our design
language is the border around the whole user interface and the top section
of it, which shows the minimize, restore, and close buttons. One thing
could be improved: giving them a background, with each one of them getting
a distinct background, because currently they are just logos and they do
not have a background. When I hover over them the colors will shift a
little bit and maybe some animations will play too."

## 1. The frame (kept as-is — owner-approved)

- The app's outer border: the window chrome carries the 1.5px border +
  radius (`rounded-[14px]` on the shell) — the bento frame the owner
  likes. **Do not remove it.**
- The title bar: `h-10`, frosted (`color-mix(var(--ac-bg) 72%, transparent)`
  + backdrop blur), `data-tauri-drag-region`, the identity button
  (logo + name, doubles as the sidebar toggle) on the left.
- **R108-e (the clay rework)**: the bar's depth is the CLAY material — the
  `ac-clay` layered soft-shadow class (TOKENS §9), so the app's literal
  top reads as a tactile slab RESTING on the frame. (R107-g had added a
  liquid-chrome reflective hairline along the top edge; removed per the
  owner's round-108 verdict — a gradient glint at the very top of the
  window is exactly the "glow fade… and other stuff like that" he
  rejected. Do not re-add it.) The frosted surface, the border, and the
  §2 button grammar are otherwise unchanged — the shadow is form, not a
  redesign.

## 2. The three buttons (round-98 C1 spec)

Implemented in `src/components/shell/TitleBar.tsx`.

**Resting state** (the owner's ask: each one a DISTINCT background):

| Button | Resting surface | Icon |
|---|---|---|
| Minimize | `subtle` wash, ink-secondary | `Minus` |
| Restore/Maximize | `subtle` wash, ink-secondary | `Square` (maximized→) / the true two-overlapping-squares restore glyph (SVG-mask occlusion — never a `Copy` metaphor) |
| Close | danger-tinted wash at rest is TOO aggressive; distinct comes from hover — resting = same subtle wash, hover = danger | `X` |

Resting anatomy: 32px tall × 40px wide hit targets, radius 9px, 1.5px
hairline border in `--ac-border-subtle` — visible chips on the frosted bar,
not ghost glyphs.

**Hover state** (the owner's ask: colors shift + animations):

| Button | Hover fill | Motion |
|---|---|---|
| Minimize | `withAlpha(accent, 0.14)` + accent ink | tint 120ms + icon nudge y+1px (150ms) |
| Restore/Maximize | `withAlpha(accent, 0.22)` + accent ink | tint 120ms + icon scale 1.08 (150ms) |
| Close | `withAlpha(danger, 0.16)` + danger ink | tint 120ms + icon scale 1.08 (150ms) |

**Press**: `active:scale-[0.96]` (150ms back) — universal button contract.

## 3. Rules

- Distinctness comes from **hover identity + icon metaphor**, not from
  three clashing resting tints (three colored chips in the corner would
  fight every screen beneath them).
- The glyphs are ALWAYS semantic: minimize = line, maximize = square,
  restore = the two-overlapping-squares glyph. Never a metaphor mismatch
  (the pre-round-98 `Copy` icon standing in for restore was a bug).
- The buttons live OUTSIDE the drag region; keyboard focus rings follow the
  app standard; tooltips name the action + shortcut.
- Maximized-state icon swap is instant (no cross-fade — it must read as
  truth, not theater).
- All color work rides the `--ac-*` CSS-var leg (color-mix), so
  hovers/transitions are pure CSS — zero JS hover handlers (the TOKENS §1
  rule 4).
