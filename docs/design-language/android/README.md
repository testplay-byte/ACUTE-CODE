<!-- round: 115 -->

# ACUTE Android Design Language — "Clay Companion"

The mobile app's constitution. Born from the owner's round-115 verdicts, written so that
any agent (main or sub) can produce screens that look, move, and speak like one product.

> **Relationship to the PC docs:** `docs/design-language/*` (the six PC files) rules the
> desktop. This folder rules `mobile/`. Where both apply (shared wire copy, semantic
> colors), the PC rulebook wins on disagreement; where mobile differs deliberately
> (bubbles, gestures, sheets), THIS folder wins.

## The one-sentence version

Every color comes from the resolved token contract, every size from the 8pt ladder,
every motion from the one house spring, every screen from a pattern in §02 — and the
phone speaks in one-liners, never paragraphs.

## The three laws (the owner's round-115 words, made binding)

1. **Minimal by default.** One idea per screen region. Descriptions are one line or
   absent. If a paragraph is needed, the design is wrong.
2. **Animate the moment, not the surface.** Entrance, state change, success, and
   waiting are animated. Resting UI never fidgets. No glow, no shine, no Apple-y
   gradients on buttons.
3. **The phone is a companion, not a control panel.** It mirrors the desktop's truth
   (names, models, status) and never invents concepts the desktop doesn't have
   (no "Auto" model, no phantom states).

## The map

| Folder | File | Owns |
|---|---|---|
| `01-foundations/` | `tokens.md` | Color pipeline, themes, spacing, radii, touch targets |
| `01-foundations/` | `motion.md` | The one spring, entrance/stagger/pulse grammar, animated moments |
| `01-foundations/` | `typography.md` | The type ladder, the weight law, copy length limits |
| `02-patterns/` | `screen-archetypes.md` | The four screen shapes (minimal-center, list, detail, chat) |
| `02-patterns/` | `components.md` | Cards, buttons, sheets, avatars, chips, tab bar idioms |
| `02-patterns/` | `onboarding.md` | The wizard DNA — first-run rules |
| `02-patterns/` | `chat.md` | The WhatsApp-inspired conversation anatomy |
| `03-rules/` | `copy.md` | The voice — word choices, one-liners, banned words |
| `03-rules/` | `donts.md` | The slop signature — what gets a screen rejected |
| `03-rules/` | `checklist.md` | The pre-merge review checklist |

## How agents use this folder

- **Before** writing a screen: read its archetype (§02) + `donts.md`.
- **While** writing: import from `src/design/primitives.tsx` / `tokens.ts`; never hand-roll
  what exists; additive edits to shared primitives only.
- **After** writing: run `03-rules/checklist.md` against the diff, then lint + typecheck.
- When the owner's verdicts supersede anything here (they always do), append an amendment
  note to the affected file — never silently edit a rule another round relied on.

## Product decisions pinned by round-115 (do not re-litigate)

| Decision | Verdict |
|---|---|
| Welcome tagline | **"The companion for your desktop agent."** ("remote" is banned — see `copy.md`) |
| Desktop naming | Desktops mint a **word-pair friendly name** (adjective + noun, e.g. "Confused Coconut") at pair-window creation; it rides the pairing payload as `machineLabel`, shows on the phone's home and the PC's pairing dialog. Machine id/cert stay the real identity. |
| Uploads folder | `<projectRoot>/attachments/` is THE uploads folder (server truth, exists). UI copy may call it "uploads" but never creates a second folder. |
| Downloads folder | `<projectRoot>/downloads/` created on demand by the desktop browser's download path. |
| Model display | Never "Auto" as a state: the pill shows the honest ladder (override → session truth → effective → agent default label). "Auto" may only ever mean "agent default," spelled exactly that way. |
| Approvals tab | When ≥1 pending: the tab icon + label take the accent color with a gentle pulse (the badge alone was judged not enough). |
| Tab 5 | "More" hub (connection summary, activity, about) with Settings as an entry — not the settings list itself. |
