<!-- last-reviewed: 2026-09-17 round-102 -->
# The ACUTE-CODE Design Language

**Owner direction (round-98, 2026-09-15):** "create a design language folder
and make sure that in that folder we properly handle our design language…
animations are going to be part of our design language too, so make sure…
there are clean beautiful animations documented for everything, and whenever
we try to make edits in our UI, the design language is properly referred to."

This folder IS that language. `docs/design/DESIGN-SYSTEM.md` remains the
engineering rulebook (spacing, anatomy inventory, interaction contracts);
this folder adds the layer the owner asked for: the **tokens**, the
**motion grammar**, the **component grammar**, the **Wizard DNA** (the
owner-approved aesthetic), and the **window-controls spec** — plus the
usage rules that make the language enforceable.

## The files

| File | What it owns |
|---|---|
| [TOKENS.md](TOKENS.md) | The color pipeline (THEMES → deriveThemeStyles → `--ac-*` vars → Tailwind), the type scale, the spacing scale, the semantic colors, alpha-tint rules |
| [MOTION.md](MOTION.md) | The animation grammar: easing, duration tiers, the keyframe registry, reduced-motion, when-to-animate |
| [COMPONENTS.md](COMPONENTS.md) | The shared primitive catalog + the composition rules (pills, chips, cards, buttons, skeletons, error cards) |
| [WIZARD-DNA.md](WIZARD-DNA.md) | The setup wizard's owner-approved patterns, extracted as reusable specs (glows, rotations, keycaps, display type, step indicators) |
| [WINDOW-CONTROLS.md](WINDOW-CONTROLS.md) | The app-frame spec: the border, the title bar, the minimize/restore/close buttons (distinct resting tints + hover motion — round-98) |
| [USAGE.md](USAGE.md) | How to use this language when editing UI: the checklist, the review gates, the do-not list |

## The one-sentence version

**Every color comes from the theme tokens, every size from the scales, every
animation from the motion grammar, every pattern from the primitive catalog —
and the wizard is the reference for what "delightful" looks like here.**

## Relationship to DESIGN-SYSTEM.md

`docs/design/DESIGN-SYSTEM.md` = the rules (what MUST be true).
`docs/design-language/` = the language (how to SPEAK it) — tokens, motion,
patterns, and the aesthetic reference, each file cross-linked with the rule
it serves. When the two disagree, the rulebook wins and the language file
gets fixed in the same round.
