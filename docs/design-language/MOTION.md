<!-- last-reviewed: 2026-09-15 round-98 -->
# Motion — the animation grammar

Serves DESIGN-SYSTEM §4 (motion). Owner direction (round-98): "animations
are going to be part of our design language too — clean beautiful
animations documented for everything."

## 1. The grammar (five rules)

1. **One ease for the whole app**: `ease = [0.25, 0.1, 0.25, 1]`
   (`src/lib/motion.ts`). Nothing ships a custom curve without a slot here.
2. **Motion is meaning, not decoration.** An animation must answer one of:
   *where did this come from* (enter), *where did it go* (exit), *what
   changed* (state transitions), *look here* (attention), or *I'm alive*
   (working indicators). Anything else is slop.
3. **Motion respects energy.** Working/streaming states may loop; resting
   UI never fidgets. Nothing animates that the user didn't act on or
   receive.
4. **Reduced motion is a first-class input.** The global
   `prefers-reduced-motion` neutralizer in `src/index.css` collapses all
   keyframes — every new animation must survive that collapse gracefully
   (end-state visible, no layout dependence on the animation).
5. **No new keyframes without a slot here.** The registry below is the
   complete list; adding one requires a line in this file in the same
   round (the DESIGN-SYSTEM §4 rule, restated as language).

## 2. The duration tiers

| Tier | Duration | Used for |
|---|---|---|
| instant | 80–120ms | color/opacity hovers, chip tint shifts |
| quick | 150–200ms | dropdowns (scale-0.97 origin), collapsible height, popover sections, window-control responses |
| base | 250–350ms | panel width, message enter (y+12, 350ms), wizard step transitions (320ms) |
| deliberate | 400–500ms | ambient glows, step-indicator morphs |
| continuous | ∞ | thinking dots, streaming caret, working timer (the only loops) |

## 3. The keyframe registry (src/index.css)

| Keyframe | Tier | Meaning |
|---|---|---|
| `bounceDot` | continuous | thinking dots + streaming caret ("I'm alive") |
| `auto-scroll` | continuous | scrollbars appear only while scrolling (`useScrollFade`) |
| wizard step/fade set | base/deliberate | see WIZARD-DNA §3 |
| `ac-caret` / `ac-ellipsis` | continuous | stream caret, retry "…" |
| line-reveal | base | streamed line entrance |
| pixel-stream | quick | raster/image chunk reveal |
| Radix dialog set | quick | overlays (base transform = end-state — lesson #30) |

## 4. The interaction catalog (documented behaviors)

| Interaction | Motion |
|---|---|
| Button press | `active:scale-95` (all buttons — universal contract) |
| Primary button hover (wizard DNA) | `hover:scale-[1.03]` + shadow bloom, 150ms |
| Card hover (bento cards) | border → `border-strong`, subtle lift via `softShadow`, 120ms |
| List-row hover | `--ac-subtle-hover` wash, instant tier, no movement |
| Dropdown open | scale 0.97→1 origin-top, 200ms, `ease` |
| Collapsible expand | height auto 200ms (`ease`) |
| Message enter | y+12 → 0, 350ms, once |
| Message exit | y−8 fade, 200ms |
| Panel resize | width 250ms |
| Skeleton pulse | the shared primitives' breathing (continuous, decorative only) |
| Segmented context bar | width 300ms `ease` (Kilo-style, round-97 C) |
| Tool-line expand | height 200ms + icon chevron rotate 90°, 150ms |
| Toggle switch | track fill 150ms, thumb translate 150ms, both `ease` |
| Window controls (round-98 C1) | see WINDOW-CONTROLS.md — tint shift + scale 0.96 press + icon nudge |
| Toast enter/exit | y-slide 200ms, exit fade |
| Jump-to-latest pill | frosted pill, opacity 150ms on scroll-need |

## 5. When NOT to animate

- Text the user is reading (no letter-level motion outside streaming).
- Layout the user is dragging (panels resize with the pointer, not after it).
- Anything behind a `prefers-reduced-motion` collapse that would hide
  end-state.
- More than one attention animation at a time on screen (the working
  section owns attention while streaming).
