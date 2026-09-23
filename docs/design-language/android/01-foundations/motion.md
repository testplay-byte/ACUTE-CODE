<!-- last-reviewed: 2026-09-23 round-120 -->

# Foundations — Motion

Source of truth in code: `mobile/src/design/motion.ts` (the constants) +
`react-native-reanimated` 4.5.1 (the engine). **No framer-motion, no moti, no lottie on
Android.** One spring owns everything; linear easing is banned; resting UI never fidgets.

## 1. The one spring

```
SPRING = { stiffness: 180, damping: 22 }
```

Every spring in the app uses exactly this config — **EXCEPT the round-116 mechanical
springs, which are deliberately over-damped:**

```
SHEET_SPRING   = { stiffness: 180, damping: 24 }   // panels: one soft settle (R119-P)
TAB_SPRING     = { stiffness: 200, damping: 26 }   // the tab indicator: calm slide
```

**Round-119 amendment (R119-P — SUPERSEDED: `{210, 30}` → `{180, 24}`):** the
owner's verdict on the Add-Provider sheet — "the animations were not that good" —
retired the stiffer snap-cut. Panels ride the house **DISCLOSURE settle** (ζ ≈ 0.89,
one soft settle, no jelly — `SHEET_SPRING` now equals `DISCLOSURE_SPRING` by design),
and the timed legs are named constants: the scrim opens **200ms ease-out** (was 160
linear), the close departs **200ms ease-in-quad** on both legs (was 180 linear), and
the content row below the header fades in **120ms ease-out starting 40ms after the
panel begins to move** (reduced motion snaps it; the first-frame static-pose law
applies). The keyboard ride inherits the settle — its MECHANICS are untouched
(R118-E's law); the clamp, skirt, and every frozen sheet constant stand.

The house spring (180/22) stays for presses, toggles, entrances — moments where a
little life is right. Anything that carries a PANEL or a large surface rides the
over-damped configs; a bounce that reveals the page background is a defect, not
personality. If it doesn't feel right at these numbers, the design is wrong, not the
spring.

**Round-120 amendment (R120-S — SUPERSEDES the R119-P timed legs and the
start-arm; the spring pair stands):** the owner's verdict — "stuttering, and
they do not play in the proper time when needed" — was a START RACE and a
TRAVEL defect: the entrance was armed in the same effect that mounts the
Modal (the spring burned its fastest frames while Android created the dialog
window — "opens, then replays"), and the travel was computed off
maxHeightFraction (~0.78 × window + 48 ≈ 670dp on a tall phone) instead of
the panel's real height (~2× velocity for a settle tuned on 300–400dp). The
final spelling (the round's sheet-motion authority — the FULL law in
`components.md` §Sheets): entrance armed from the Modal's own `onShow` +
the `SHEET_SHOW_ARM_FALLBACK_MS` 150 JS guard, static poses before the arm;
the panel rides `withSpring(1, SHEET_SPRING {180, 24})` traveling its
MEASURED height (`sheetPanelTravelPx`); the scrim opens `withTiming` 240ms
ease-out cubic on the same frame; the CLOSE departs frame one — both legs
`withTiming` 220ms ease-out cubic — with the panel's exact callback owning
the unmount (220 < 240 pinned). The R119 content ride (120ms/40ms) is
RETIRED — `SHEET_CONTENT_FADE_MS`/`DELAY_MS` are DELETED (the absence is
pinned); the panel's opacity is 1 throughout. Reduced motion: the panel
snaps, the scrim fade is the only animated leg. The R118-E keyboard ride is
untouched (same `SHEET_SPRING`).

## 2. Entrance grammar

- **Fade-in-up**: opacity 0→1, translateY `ENTRANCE_DELTA` (8px)→0,
  `staggerDelay(i)` = 30ms × index. Already centralized in `PressableCard enterIndex`
  and `ApprovalCard` — reuse, never re-roll.
- Lists cap the stagger at 12 rows; beyond that everything enters on row 12's beat.
- Wizard screens: the hero (icon + title + tagline) enters FIRST (0ms), options stagger
  after. Every wizard screen animates in — a static first-run screen is rejected.
- **The static initial pose (R118-A, law):** every Modal-hosted animated surface —
  sheets, centered dialogs — carries a STATIC fallback style ahead of the animated
  one (panel pinned below the fold, scrim at 0). The Modal's new Android window can
  composite its first frame before Reanimated attaches, and an empty first animated
  style paints the panel OPEN at rest ("opens, then replays"). Last-wins flattening
  makes the pose inert after frame one — the flash becomes impossible.

## 3. State-change grammar

| Moment | Motion |
|---|---|
| Press | scale 0.98 + shadow collapse + 8% tint (the house press) |
| Toggle/select | spring to the new position (sliding pill, switch dot) |
| Expand/collapse (accordion) | expand springs height 0↔measured + chevron rotates 180° on its own spring; **collapse is a 200ms timing, never a spring (R118-C — closing never bounces)** |
| Success (granted, linked, created) | icon tile bg springs to `success`, icon crossfades to the check, a single `successHaptic` |
| Waiting (thinking) | the TurnBlock rail's three dots, 1.2s opacity pulse (600ms legs, 0.85↔1) with a 180ms stagger — calm, never a spinner (R119-A: the dots moved from the retired placeholder card into the rail's live state; the rail breathes only while the turn WORKS — once text streams, the LiveCaret owns the motion) |
| Live caret | 8×15 accent bar, 0.25↔1 opacity, 550ms each way — the house live rhythm; R118-D: the processing bubble's accent edge breathes 0.34↔0.62 on the same 550ms legs (the delivery-edge rhythm; static 0.55 mix under reduced motion) |
| Live edge (avatar) (R120-CM) | while a turn runs, the session header's avatar wears a 2dp accent ring breathing the delivery-edge rhythm — `mixHex(surfaceHeader, accent, 0.34↔0.62)` on the same 550ms legs (`LIVE_LINE_LEG_MS` + the exported `DELIVERY_EDGE_*` constants), static 0.55 under reduced motion, drawn outside the avatar's 36px box (inset −3, layout never shifts); NOTHING at rest |
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
7. **Tab label morph (round-116)**: the selected tab's label expands (width + opacity,
   ~200ms timing or TAB_SPRING) while the previous item's label collapses — the icon
   never moves, only the label breathes in beside it.
   Round-118 amendment (R118-B): the label's expanded `maxWidth` is the measured width
   **+2px** (`LABEL_EPSILON` — the pixel grid clips an exact fit), and the neighboring
   slots rebalance on the label's own timing (`TAB_LABEL_MS`) so the row stays fluid
   while the pill glides on TAB_SPRING.
8. **Anchored dropdown (round-116)**: the header menu springs in below its control
   (scale 0.96→1 + opacity, origin top-right, ~180ms) and dismisses on tap-outside
   with a 120ms fade. Never a bottom sheet.
9. **Broken-link idle (round-116, unpaired home)**: the desktop/phone chips drift a few
   px apart and back (~2.8s period) with the dashed link line's gap widening in sync —
   calm, looping, the "currently not connected" pulse.
10. **Centered dialog entrance (round-118, R118-D)**: the confirm card springs in at
    the screen center (scale 0.96→1 on the house spring, origin center) over the
    160ms sheet scrim; exit is a 120ms fade. Scrim tap cancels; the confirm haptic
    fires only on confirm. Carries the static initial pose (§2) — it is a
    Modal-hosted surface.
11. **Disclosure (round-118, R118-C)**: expand rides `DISCLOSURE_SPRING {180, 24}`
    (ζ ≈ 0.89 — one soft settle, no jelly); collapse is `withTiming` **200ms ease-out
    + a 150ms opacity fade** — a timing curve cannot overshoot, so closing NEVER
    bounces. The chevron follows its level's direction; the onLayout re-measure rides
    the spring; reduced motion snaps both ways. (R119-A: the TurnBlock's activity
    well rides this same disclosure — `Reveal` — for its expand/collapse.)
12. **Kebab level swaps (round-119, R119-B)**: the owner asked for "some animation
    while switching between the menus" — the dropdown panel's body (title row +
    content) is KEYED by level and swaps directionally: drilling in, the new level
    slides in from the RIGHT **12dp over 180ms ease-out** while the root mirrors out
    LEFT (120ms); going back reverses it — the sub-level exits RIGHT the way it came
    in. The direction derives from level DEPTH (root 0 / named sub-levels 1 — the
    pure `levelSwapDirection`), never a per-menu flag; equal-depth swaps dissolve;
    reduced motion = the plain 120ms fade. The panel's own entrance (spring
    0.96→1) + exit fade are untouched and frozen: `PANEL_WIDTH 220`,
    `ENTRANCE_SCALE 0.96`, `EXIT_FADE_MS 120`.
13. **The attachment viewer (round-120, R120-P):** the composer's pop-up viewer
    for staged attachments — the centered clay card springs in at **0.96→1**
    (`VIEWER_ENTRANCE_SCALE`, origin center — the centered-dialog grammar)
    over the **160ms scrim** (`VIEWER_SCRIM_MS`); the exit is a **120ms fade**
    (`VIEWER_EXIT_FADE_MS`). The card is `min(520, windowWidth − 40)` wide
    (`viewerCardWidth`) with the 60%-height scrollable body
    (`VIEWER_BODY_HEIGHT_RATIO`); the text arm carries the honest "first 128
    KB" caption. Carries the static initial pose (§2) — it is a Modal-hosted
    surface. All constants frozen + pinned by `attachment-viewer.test.ts`.

## 5. What never animates

- Resting cards, resting text, backgrounds.
- The matte top edge (it's a material, not a light).
- Sheet chrome (header row) — the panel slides, its contents don't double-slide.
  (R118-A: the grip is deleted — see `round-117-elevation.md` §2.2's supersession.
  R119-P's ONE sanctioned exception — the content row's 120ms/40ms fade-in under
  the moving panel — is RETIRED by R120-S: the content ride is deleted; the fold
  itself reveals the content top-first, and the panel's opacity is 1 throughout.)
- Anything while `prefers-reduced-motion`/accessibility "remove animations" is on:
  entrance/stagger/idle animations drop; state changes snap.

## 6. Haptics (the 4-word vocabulary)

`selectionHaptic` (picking), `decisionHaptic` (submit/decide), `successHaptic`
(pairing, creation), `warningHaptic` (errors, expiry). All fail-open. One haptic per
moment — never per frame.

## 7. Durations (when `withTiming` is unavoidable)

instant 120ms (scrim pre-fade) · quick 180ms (crossfade) · sheet legs — scrim open
**240ms ease-out cubic** / close **220ms ease-out cubic** both legs (R120-S —
supersedes the R119-P 200/200 pair) · base 300ms (terminal moments) · deliberate
500ms (donut sweep). Everything else is the spring.
