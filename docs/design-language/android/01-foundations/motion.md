<!-- round: 115 -->

# Foundations — Motion

Source of truth in code: `mobile/src/design/motion.ts` (the constants) +
`react-native-reanimated` 4.5.1 (the engine). **No framer-motion, no moti, no lottie on
Android.** One spring owns everything; linear easing is banned; resting UI never fidgets.

## 1. The one spring

```
SPRING = { stiffness: 180, damping: 22 }
```

Every spring in the app uses exactly this config (the tab-bar's keyboard hide may ride
damping 26 — the one sanctioned exception). If it doesn't feel right at 180/22, the
design is wrong, not the spring.

## 2. Entrance grammar

- **Fade-in-up**: opacity 0→1, translateY `ENTRANCE_DELTA` (8px)→0,
  `staggerDelay(i)` = 30ms × index. Already centralized in `PressableCard enterIndex`
  and `ApprovalCard` — reuse, never re-roll.
- Lists cap the stagger at 12 rows; beyond that everything enters on row 12's beat.
- Wizard screens: the hero (icon + title + tagline) enters FIRST (0ms), options stagger
  after. Every wizard screen animates in — a static first-run screen is rejected.

## 3. State-change grammar

| Moment | Motion |
|---|---|
| Press | scale 0.98 + shadow collapse + 8% tint (the house press) |
| Toggle/select | spring to the new position (sliding pill, switch dot) |
| Expand/collapse (accordion) | spring height 0↔measured + chevron rotates 180° on its own spring |
| Success (granted, linked, created) | icon tile bg springs to `success`, icon crossfades to the check, a single `successHaptic` |
| Waiting (thinking) | three 6px dots, 1.2s opacity pulse, 180ms stagger — calm, never a spinner |
| Live caret | 8×15 accent bar, 0.25↔1 opacity, 550ms each way |
| Countdown pressure | the "Valid for Ns" chip tints warning under 30s, springs gently each tick — no seizure flashing |

## 4. The animated moments (round-115 mandates)

1. **Welcome hero icon**: gentle idle float (translateY ±4px, ~2.4s period, spring-free
   sine via `withRepeat(withTiming)` — the ONE sanctioned continuous idle animation,
   wizard only) + entrance scale 0.9→1 on the house spring.
2. **Camera granted**: the camera icon tile springs its background to `success` green,
   the icon morphs to `Check` (crossfade 200ms), the Skip button **slides out** (width +
   opacity spring, ~200ms), THEN the Continue button enters. Sequence, not a hard swap.
3. **Connect-to-PC hero (unpaired connect screen)**: an SVG pair (desktop + phone) with
   an infinite calm pulse — a soft link line between them whose dash offset travels
   (~1.6s loop) or three signal arcs that fade in sequence. Infinite but CALM: opacity
   pulses, no scale thrash.
4. **Pairing (full-screen)**: on "Pair with this host" the whole content crossfades out
   (150ms), a full-screen moment takes over — two clay chips (desktop + phone) slide
   toward each other, meet, and merge into one linked tile with the word-pair name
   typing in (`TypeTitle`), ~1.4s total, `successHaptic` on the merge. The result state
   (connected card) enters with the standard fade-in-up.
5. **Approvals pending tab**: icon + label tint to accent with a 1.6s opacity breathe
   (0.75↔1) while pending > 0.
6. **Chart entry**: bars grow from baseline (withTiming 350ms, staggered 12ms), donut
   sweep draws its arcs (withTiming 500ms) — once per data load, never looping.

## 5. What never animates

- Resting cards, resting text, backgrounds.
- The matte top edge (it's a material, not a light).
- Sheet chrome (grip, title) — the panel slides, its contents don't double-slide.
- Anything while `prefers-reduced-motion`/accessibility "remove animations" is on:
  entrance/stagger/idle animations drop; state changes snap.

## 6. Haptics (the 4-word vocabulary)

`selectionHaptic` (picking), `decisionHaptic` (submit/decide), `successHaptic`
(pairing, creation), `warningHaptic` (errors, expiry). All fail-open. One haptic per
moment — never per frame.

## 7. Durations (when `withTiming` is unavoidable)

instant 120ms (scrim pre-fade) · quick 180ms (sheet exit, crossfade) · base 300ms
(terminal moments) · deliberate 500ms (donut sweep). Everything else is the spring.
