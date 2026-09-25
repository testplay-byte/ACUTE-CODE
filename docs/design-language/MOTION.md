<!-- last-reviewed: 2026-09-24 round-126 -->
# Motion — the animation grammar

Serves DESIGN-SYSTEM §4 (motion). Owner direction (round-98): "animations
are going to be part of our design language too — clean beautiful
animations documented for everything."

**ROUND-126 (the Clay Companion redesign): the mobile constitution's motion
grammar is adopted, adapted to framer-motion.** The mobile app's one-house-
spring law (`mobile/src/design/motion.ts`) translates DIRECTLY — framer-motion
springs take the same `{stiffness, damping}` numbers reanimated does. The
timed legs keep their PC tiers where they already matched. Every R126 change
is marked **ROUND-126**.

## 1. The grammar (six rules)

1. **One house spring for the whole app** — ROUND-126 (mobile §1, adopted):
   `SPRING = { stiffness: 180, damping: 22 }` on framer-motion's
   `type: "spring"`. Presses, toggles, entrances, state morphs — moments
   where a little life is right. Anything that carries a PANEL or a large
   surface rides the over-damped pair below. If it doesn't feel right at
   these numbers, the design is wrong, not the spring. The pre-R126 cubic
   `ease = [0.25, 0.1, 0.25, 1]` (`src/lib/motion.ts`) survives for the
   TIMED legs (CSS transitions, keyframes) — springs own the interactive
   moments, timings own the ambient ones.
2. **Mechanical surfaces are over-damped** — ROUND-126 (mobile §1):
   `SHEET_SPRING = { stiffness: 180, damping: 24 }` (panels/dialogs: one
   soft settle, ζ ≈ 0.89 — no jelly) and `TAB_SPRING = { stiffness: 200,
   damping: 26 }` (the calm slide for tab indicators/segmented knobs).
   A bounce that reveals the page background is a defect, not personality.
3. **Motion is meaning, not decoration.** An animation must answer one of:
   *where did this come from* (enter), *where did it go* (exit), *what
   changed* (state transitions), *look here* (attention), or *I'm alive*
   (working indicators). Anything else is slop.
4. **Animate the moment, never the surface.** Entrance, state change,
   success, and waiting are animated. Resting UI never fidgets — no glow,
   no shine loops, no idle drift outside the wizard's sanctioned set.
5. **Reduced motion is a first-class input.** The global
   `prefers-reduced-motion` neutralizer in `src/index.css` collapses all
   keyframes — every new animation must survive that collapse gracefully
   (end-state visible, no layout dependence on the animation). Springs snap
   (`{ duration: 0 }`).
6. **No new keyframes without a slot here.** The registry below is the
   complete list; adding one requires a line in this file in the same
   round (the DESIGN-SYSTEM §4 rule, restated as language).

## 2. The constants — ROUND-126 (mobile motion.ts, verbatim)

| Constant | Value | Role |
|---|---|---|
| `SPRING` | `{180, 22}` | the house spring — presses, entrances, toggles |
| `SHEET_SPRING` | `{180, 24}` | panels/dialogs/drawers — one soft settle |
| `TAB_SPRING` | `{200, 26}` | tab indicators, segmented knobs |
| `STAGGER_STEP_MS` | `30` | list entrance stagger (`staggerDelay(i) = i × 30`) |
| `ENTRANCE_DELTA` | `8px` | the fade-in-up rise |
| `PRESS_SCALE` | `0.98` | the house press (replaces `active:scale-95` on clay cards) |
| `CROSSFADE_MS` | `200` | icon/state crossfades |
| `DISCLOSURE_SPRING` | `{180, 24}` | accordion expand (same as SHEET) |
| `DISCLOSURE_COLLAPSE_MS` | `200` ease-out | accordion collapse — a TIMING, never a spring (closing never bounces — mobile R118-C law) |
| `DISCLOSURE_FADE_MS` | `150` | the collapse's opacity fade |
| `LIVE_CARET_LEG_MS` | `550` | the live rhythm — opacity 0.25↔1, each way (the 8×15px accent bar) |
| `DELIVERY_EDGE_LEG_MS` | `550` | the processing-bubble/avatar breathing edge, `mixHex(surface, accent, 0.34↔0.62)` — static 0.55 reduced-motion |
| `CHART_BAR_GROW_MS` | `350` | chart bars grow from baseline, once per data load |
| `CHART_BAR_STAGGER_MS` | `12` | the per-bar stagger |
| `DONUT_SWEEP_MS` | `500` | the donut's arc draw |
| `STATUS_PULSE_LEG_MS` | `600` | thinking dots, 1.2s cycle, 0.35↔1, 180ms stagger |
| `LIVE_DOT_LEG_MS` | `800` | "happening now" dots, 0.55↔1 |

The duration tiers for TIMED legs (unchanged where they already matched):
instant 80–120ms (hovers, chip tint) · quick 150–200ms (dropdown scale,
collapsible height) · base 250–350ms (panel width, message enter) ·
deliberate 400–500ms (step morphs, donut sweep) · continuous ∞ (the
sanctioned loops only: thinking dots, stream caret, working timer, pixel
stream, the wizard's ambient set, the 9s chrome pass).

## 3. The keyframe registry (src/index.css)

| Keyframe | Tier | Meaning |
|---|---|---|
| `bounceDot` | continuous | thinking dots ("I'm alive") |
| `auto-scroll` | continuous | scrollbars appear only while scrolling (`useScrollFade`) |
| wizard step/fade set | base/deliberate | see WIZARD-DNA §3 |
| `ac-caret-pulse` | continuous | the chat answer's live caret — ROUND-126: tuned to the house live rhythm (opacity 1↔0.25, 550ms legs); `ac-caret-blink` stays for SubAgentPanel's terminal rows |
| `ac-pulse` / `ac-line-reveal` / `ac-pixel-stream` | continuous/base/quick | stream pulse, streamed line entrance, raster chunk reveal |
| `ac-chrome-pass` | continuous (9s ambient) | R107-g/R108-e: the liquid-chrome sheen — signature surfaces ONLY (wizard CTA + hero metal); never working-UI buttons. If it draws attention to itself, cut it further. |
| Radix dialog set | quick | overlays (base transform = end-state — lesson #30) |

## 4. The interaction catalog (documented behaviors)

| Interaction | Motion |
|---|---|
| Clay card press | **ROUND-126**: scale `0.98` on SPRING + the shadow collapses to `--ac-clay-shadow-pressed` + an 8% tint toward ink — the house press (`active:scale-95` retires from clay cards; the plain `active:scale-95` stays legal on small icon buttons) |
| Button press (non-card) | `active:scale-95`, instant |
| List-row hover | `--ac-subtle-hover` wash, instant tier, no movement |
| Card hover (clay cards) | border rim → `border-strong` swap, 120ms — no lift, no translate (the clay card is already elevated; hover confirms, never performs) |
| Dropdown open | scale 0.96→1 origin-top on SHEET_SPRING; dismiss 120ms fade |
| Collapsible expand | height on DISCLOSURE_SPRING `{180, 24}`; chevron rotates 180° on its own spring |
| Collapsible collapse | **TIMING, never a spring**: 200ms ease-out height + 150ms fade (closing never bounces — mobile R118-C) |
| Message enter | fade-in-up: opacity 0→1 + y `ENTRANCE_DELTA`(8)→0 on SPRING, `staggerDelay(i)` 30ms steps, capped at 12 rows |
| Message exit | y−8 fade, 200ms |
| Panel/dialog enter | **ROUND-126**: scale 0.96→1 origin-center on SHEET_SPRING over a 160ms scrim (the centered-confirm grammar; static first pose — a Modal's first frame must composite the closed state, never the open one) |
| Panel resize | width 250ms timed (panels resize WITH the pointer while dragging; the timed leg is only for programmatic opens/collapses) |
| Skeleton pulse | the well's breathing: `bg-well` fill, opacity 0.45↔0.85, 700ms legs |
| Segmented control | the knob glides in index space on TAB_SPRING; selected label weight flips with it |
| Tab indicator | width + position on TAB_SPRING; the label morph rides `TAB_LABEL_MS` 200ms |
| Toggle switch | thumb on SPRING; track fill 150ms timed |
| Tool-line expand | height on DISCLOSURE_SPRING + chevron rotate |
| Live caret | 8×15px accent bar, radius 2, opacity 0.25↔1 at 550ms legs — the house live rhythm (chat answers, live tails) |
| Delivery edge | while a turn/bubble is processing: its edge breathes `mix(surface, accent, 0.34↔0.62)` at 550ms legs; static 0.55 under reduced motion; NOTHING at rest |
| Chart entry | bars grow from baseline (350ms, 12ms stagger), donut sweeps (500ms) — once per data load, never looping |
| Success moment | icon tile bg springs to `success`, icon crossfades to the check (200ms) — a moment, never a loop |
| Window controls (round-98 C1) | see WINDOW-CONTROLS.md — tint shift + scale 0.96 press + icon nudge |
| Composer focus (R105-B) | pure CSS `:focus-within`: accent@50% border + 3px accent-soft halo on the shell, 200ms transition |
| Toast enter/exit | **ROUND-126**: rising dock rides `--ac-clay-shadow-sheet` + a y-slide settle on SHEET_SPRING; exit 200ms fade |
| Jump-to-latest pill | frosted pill, opacity 150ms on scroll-need |
| Message-timeline bar growth (R120-C-PC) | hover-proximity scaling: CSS height transition 200ms quick tier, linear falloff (28px peak / 8px rest / 56px radius); 0s jump under reduced motion |

## 5. What NEVER animates (mobile §5, adopted)

- Resting cards, resting text, backgrounds — the matte top edge is a
  material, not a light.
- Sheet/dialog chrome — the panel slides, its contents don't double-slide.
- Text the user is reading (no letter-level motion outside streaming).
- Layout the user is dragging (panels resize with the pointer, not after it).
- Anything behind a `prefers-reduced-motion` collapse that would hide
  end-state.
- More than one attention animation at a time on screen (the working
  section owns attention while streaming).

## 6. The animated moments (mobile round-115 mandates, adapted)

1. **Screen entrance** — the hero block enters first (0ms), sections
   stagger after (30ms steps, 12-row cap). Already-centralized idioms ride
   as-is; new screens use `staggerDelay`.
2. **Success** — the icon tile springs to `success` + the check crossfades
   in (200ms). One moment, then rest.
3. **Waiting** — the three-dot rail (600ms legs, 180ms stagger) or the
   live caret (550ms); never a spinner on list screens.
4. **Live** — the delivery edge + the caret own the "working now" rhythm;
   everything else holds still.
5. **Countdown pressure** — the chip tints warning under 30s and springs
   gently each tick; no seizure flashing.
6. **The wizard's theatrical set** stays (WIZARD-DNA §3) — the ONE place
   ambient loops are sanctioned.
