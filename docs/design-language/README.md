<!-- last-reviewed: 2026-09-24 round-126 -->
# The ACUTE-CODE Design Language — "Clay Companion" (PC edition)

**Owner direction (round-98, 2026-09-15):** "create a design language folder
and make sure that in that folder we properly handle our design language…
animations are going to be part of our design language too, so make sure…
there are clean beautiful animations documented for everything, and whenever
we try to make edits in our UI, the design language is properly referred to."

**Owner direction (round-126, 2026-09-24 — the complete PC redesign):** the
desktop adopts the Android app's design language — "similar… not outright
copy" — as **Clay Companion**: the clay substrate (warm surfaces, two-leg
shadows, rims + recessed wells), the two-tier terracotta accent, the badge
tone containers, the one-house-spring motion, and the mobile constitution's
laws (minimal by default; animate the moment, never the surface). This
folder IS that language for the PC.

This folder IS that language. `docs/design/DESIGN-SYSTEM.md` remains the
engineering rulebook (spacing, anatomy inventory, interaction contracts);
this folder adds the layer the owner asked for: the **tokens**, the
**motion grammar**, the **component grammar**, the **screen archetypes +
navigation grammar**, the **Wizard DNA** (the owner-approved aesthetic), and
the **window-controls spec** — plus the usage rules that make the language
enforceable.

## The files

| File | What it owns |
|---|---|
| [TOKENS.md](TOKENS.md) | The color pipeline (THEMES → deriveThemeStyles → `--ac-*` vars → Tailwind), the type scale (Manrope/JetBrains Mono), the spacing scale, the semantic colors, **the surface ladder (§10)**, **the status grammar (§11)**, the two-tier accent (§1d) |
| [MOTION.md](MOTION.md) | The animation grammar: the house springs, the timed tiers, the keyframe registry, the interaction catalog, reduced-motion, when-to-animate |
| [COMPONENTS.md](COMPONENTS.md) | The shared primitive catalog + the composition rules (clay cards, badge tones, buttons, chips, skeletons, the chat turn anatomy §7) |
| [SCREENS.md](SCREENS.md) | **R126:** the five PC screen archetypes + the navigation model — the binding contract for nav chrome |
| [WIZARD-DNA.md](WIZARD-DNA.md) | The setup wizard's owner-approved patterns, extracted as reusable specs (glows, rotations, keycaps, display type, step indicators) |
| [WINDOW-CONTROLS.md](WINDOW-CONTROLS.md) | The app-frame spec: the border, the title bar, the minimize/restore/close buttons (distinct resting tints + hover motion — round-98) |
| [USAGE.md](USAGE.md) | How to use this language when editing UI: the checklist, the review gates, the do-not list |

## The one-sentence version

**Every color comes from the theme tokens, every size from the scales, every
animation from the motion grammar, every pattern from the primitive catalog,
every screen from an archetype — and the wizard is the reference for what
"delightful" looks like here.**

## Relationship to the mobile constitution

`docs/design-language/android/` ("Clay Companion") rules `mobile/`; THIS
folder rules the desktop. They share the material (clay), the accent
family, the motion constants, and the laws — adapted per platform (the
phone: floating tab bar, bottom sheets, 44px touch; the desktop: the
sidebar shell, dialogs, IDE densities). Where both apply (shared wire copy,
semantic colors), THIS folder wins on disagreement, and the disagreement
gets an amendment note on both sides — never a silent edit.

## Relationship to DESIGN-SYSTEM.md

`docs/design/DESIGN-SYSTEM.md` = the rules (what MUST be true).
`docs/design-language/` = the language (how to SPEAK it) — tokens, motion,
patterns, and the aesthetic reference, each file cross-linked with the rule
it serves. When the two disagree, the rulebook wins and the language file
gets fixed in the same round. (R126 note: DESIGN-SYSTEM §2's bento
1.5px-border DNA and §1's nova-as-default were superseded by this round —
the supersessions are recorded in TOKENS §1b/§5 and DESIGN-SYSTEM.md was
amended in the same round.)
