<!-- last-reviewed: 2026-09-15 round-98 -->
# Usage — how to speak the language when editing UI

Owner direction (round-98): "whenever we try to make edits in our UI, the
design language is properly referred to."

## 1. The checklist (run it for every UI change)

1. **Tokens**: every color from the pipeline (TOKENS §1), every size from
   the ladders (TOKENS §2–3). Grep your diff for `#[0-9a-fA-F]{3,8}` and
   for raw `px` font sizes — zero hits outside the sanctioned palettes.
2. **Primitives**: check COMPONENTS §1 before writing any chip/card/pill/
   loading/error idiom; add the row if you create one.
3. **Motion**: every transition maps to a MOTION §2–4 row; new keyframes
   need a registry slot in the same round.
4. **States**: every surface answers loading / empty / error / ready
   (the round-97 state-awareness contract); skeletons via the shared
   primitives; errors `role="alert"` with cause + Retry.
5. **A11y**: roles, labels, keyboard paths, 44px hit targets on touch-
   shaped surfaces, `sr-only` where icon-only.
6. **Responsive**: test at the 480px chat floor and 1920px; the layout
   adapts (short-view rules for tall-content screens).
7. **Screenshots**: 1920×1080 + tall for anything visible; record in
   `docs/ui-iterations/round-NN.md`.
8. **This folder**: if the change introduces a pattern (not just uses
   one), document it HERE in the same round.

## 2. The review gates (who enforces the language)

- **Self**: the checklist above, before you commit.
- **Tests**: testids/roles pin the anatomy so visual regressions surface
  as suite failures, not vibes.
- **The round review agent**: every round's review pass audits diffs
  against this folder (the owner's subagent-review discipline) — hex
  literals, ad-hoc keyframes, re-implemented primitives, missing states
  are findings.
- **docs:check**: the stamp on each file here refreshes when the language
  itself changes (3-round rule).

## 3. The do-not list (the slop signature — instant review findings)

- A hex literal or `rgba(` in a component outside the sanctioned palettes.
- A new `animate-pulse` div instead of the Skeleton primitives.
- A fifth spelling of an error card, status chip, or hover cluster.
- Sizes off-ladder (9.75px, 11px-or-13px-when-12-was-right).
- Red for a non-failure; amber for a failure; "Generation failed" for a
  deliberate stop (round-97 D contract).
- A hardcoded duration/curve that isn't in MOTION §2.
- One-off hover handlers where a CSS-var utility could express it.
- Avatars, name headers, or Sparkles on chat turns (owner R37 verdict).
- Wallpapering working surfaces with wizard glows (WIZARD-DNA §8).

## 4. Amendment protocol

The language evolves the same way the rulebook does: the round that changes
the UI updates these files in the same commit family, and
DESIGN-SYSTEM.md §1 links here as the language layer. Owner verdicts
supersede everything (the standing rule) — when the owner rules, the ruling
lands in the relevant file's header note with the round number.
