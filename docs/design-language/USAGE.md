<!-- last-reviewed: 2026-09-19 round-108 -->
# Usage — how to speak the language when editing UI

Owner direction (round-98): "whenever we try to make edits in our UI, the
design language is properly referred to."

ROUND-100 (R100-C): the language is now MACHINE-ENFORCED — `pnpm
design:audit` counts the violations and fails CI on any regression (§2
below), and the first three shared primitives (`Kicker` / `SectionCard` /
`SettingsRow`) give the waves something to import instead of re-implementing
(§3 below).

## 1. The checklist (run it for every UI change)

1. **Tokens**: every color from the pipeline (TOKENS §1), every size from
   the ladders (TOKENS §2–4). Run `pnpm design:audit` (§2) — the grep-your-
   diff era ended with round-100: the script counts hex literals, arbitrary
   values, sub-10px type, heavy weights, and JS hover handlers for you.
2. **Primitives**: check COMPONENTS §1 before writing any chip/card/pill/
   loading/error idiom; add the row if you create one. The round-100 wave
   starts every card/label/row from `src/components/ui/` (§3 below).
3. **Motion**: every transition maps to a MOTION §2–4 row; new keyframes
   need a registry slot in the same round.
4. **States**: every surface answers loading / empty / error / ready
   (the round-97 state-awareness contract); skeletons via the shared
   primitives; errors `role="alert"` with cause + Retry.
5. **A11y**: roles, labels, keyboard paths, ≥28×28px hit targets (TOKENS
   §3), `sr-only` where icon-only.
6. **Responsive**: test at the 480px chat floor and 1920px; the layout
   adapts (short-view rules for tall-content screens).
7. **Screenshots**: 1920×1080 + tall for anything visible; record in
   `docs/ui-iterations/round-NN.md`.
8. **This folder**: if the change introduces a pattern (not just uses
   one), document it HERE in the same round.

## 2. The audit gate — `pnpm design:audit` (ROUND-100 R100-C)

The enforcement loop's missing half (research §C1.6):
`scripts/design-audit.mjs` scans `src/components/**` + `src/pages/**`
(tests, `onboarding/`, and `demos/` excluded) and counts five rules:

| Rule | Counts | Why |
|---|---|---|
| R1 | hex literals `#[0-9a-fA-F]{3,8}` | TOKENS §1: colors flow from the pipeline |
| R2 | arbitrary Tailwind px values (`text-[..px]`, `w-[..]`, `rounded-[..px]`, …) | TOKENS §2–4: sizes come from the scales |
| R3 | sub-10px text (`text-[8/9/8.5/9.5px]`) | TOKENS §2: the 10px hard floor |
| R4 | `font-bold` / `font-extrabold` / `font-black` | TOKENS §2: the weight law |
| R5 | `onMouseEnter` / `onMouseLeave` handlers | TOKENS §6: hover is a CSS class |

**How to run**: `pnpm design:audit` (it also runs inside `pnpm verify`,
right after the test step, and therefore in CI).

**The ratchet rule**: `scripts/design-audit-baseline.json` pins the
per-rule counts. Exit 0 while every count is **≤ its baseline**; exit 1
with a per-rule diff table (plus the top hotspot files and the fix hint)
the moment any count **exceeds** it. Growth is a regression by definition
— the baseline never goes up without a documented, deliberate exception.

**How waves lower baselines**: when a wave finishes a cleanup (say, D
retires every `onMouseEnter` in project-chat/), it re-pins the lowered
counts with `node scripts/design-audit.mjs --update-baseline` (or
`UPDATE_BASELINE=1 pnpm design:audit`) IN THE SAME COMMIT as the cleanup —
the printed counts are the new floor everyone after it must stay under.
Re-pinning is the LAST step of a cleanup, never a fix for a regression.
Known limitation (documented in the script header): comment stripping is
string-literal-blind and can only ever undercount; sanctioned palettes
that live inside the scanned tree are counted and pinned — the ratchet
guards against growth, not existence.

## 3. The round-100 primitives (import, don't re-implement)

The first three `src/components/ui/` primitives (research §C1.6 item 2).
All three are theme-aware through the existing utilities/hook (they work
in light AND dark — the `--ac-*` CSS vars do that), all accept
`data-testid`, and all are covered by unit tests that pin the class
contracts:

- **`Kicker`** (`src/components/ui/Kicker.tsx`) — THE label-tier heading:
  11px/500 uppercase `tracking-[0.08em]`, tertiary ink, optional 12px
  lucide `icon`, `as` h2/h3/div. When a screen needs a kicker, this is the
  only spelling — a hand-rolled 11px-bold variant is an audit finding
  waiting to happen (and a §4 do-not).
- **`SectionCard`** (`src/components/ui/SectionCard.tsx`) — the
  settings/panel card: `rounded-2xl` (the 16px step — note: a SCALE
  utility, not `rounded-[16px]`), 1.5px `border-line`, `bg-card`, `size`
  md=p-5/lg=p-6, optional `shadow` (softShadow), optional `kicker` +
  `title` header slot (title wires `aria-labelledby` to its 13px/600
  heading), and an optional `ariaLabel` passthrough (R100-E1: the adopting
  settings cards carried aria-labels their tests pin — adoption must not
  drop them). Every new settings tab starts its cards here.
- **`SettingsRow`** (`src/components/ui/SettingsRow.tsx`) — the
  label+control row: 36px min-height, 13px/400 label + optional 11px
  tertiary `description`, `flex-1 min-w-[200px]` label block, right-aligned
  shrink-0 control slot, optional `divider` hairline for stacked rows. It
  renders NO hover of its own — the parent adds the `hover:bg-hover` class
  (TOKENS §6: hover is CSS, never JS).

## 4. The review gates (who enforces the language)

- **Self**: the checklist above + `pnpm design:audit` (§2), before you
  commit.
- **The audit gate**: CI runs it through `pnpm verify` — a diff that adds
  a hex literal, an off-scale size, sub-10px type, a heavy weight, or a JS
  hover handler FAILS the build, no human review required.
- **Tests**: testids/roles pin the anatomy so visual regressions surface
  as suite failures, not vibes (the three primitives' class contracts are
  pinned in `src/components/ui/*.test.tsx`).
- **The round review agent**: every round's review pass audits diffs
  against this folder (the owner's subagent-review discipline) — hex
  literals, ad-hoc keyframes, re-implemented primitives, missing states
  are findings.
- **docs:check**: the stamp on each file here refreshes when the language
  itself changes (3-round rule).

## 5. The do-not list (the slop signature — instant review findings)

- A hex literal or `rgba(` in a component outside the sanctioned palettes
  (audit R1).
- An arbitrary `text-[Npx]`/`rounded-[Npx]`/`w-[Npx]` where a scale step
  exists (audit R2) — and sub-10px type anywhere outside onboarding
  (audit R3).
- `font-bold`/`font-black`/`font-extrabold` outside the wizard display +
  StatCard value (audit R4) — the weight law: 400 chrome, 500 active, 600
  headers/titles/buttons.
- A new `animate-pulse` div instead of the Skeleton primitives.
- A fifth spelling of an error card, status chip, or hover cluster.
- Sizes off-ladder (9.75px, 11px-or-13px-when-12-was-right).
- An `onMouseEnter`/`onMouseLeave` handler outside onboarding (audit R5) —
  hover is a CSS class (`hover:bg-hover`), always.
- Red for a non-failure; amber for a failure; "Generation failed" for a
  deliberate stop (round-97 D contract).
- A hardcoded duration/curve that isn't in MOTION §2.
- Avatars, name headers, or Sparkles on chat turns (owner R37 verdict).
- Wallpapering working surfaces with wizard glows (WIZARD-DNA §8) — and,
  same law, wallpapering working surfaces with the chrome sheen: the
  animated `.ac-chrome-sheen` is signature-surface-only (COMPONENTS §8);
  resting UI gets the `.ac-clay` shadow form, nothing painted on top.
- A gradient "glow/fade" wash, top-light overlay, or glint hairline on a
  resting surface (the deleted `.ac-clay-light`/`.ac-chrome-edge` — the
  R108-e verdict: "at the very top you implemented some glow fade and
  other stuff like that"). Clay depth is SHADOW + FORM
  (`.ac-clay`, TOKENS §9), never painted light.
- A metal hex written into a component instead of the `--ac-chrome-*`
  vars (TOKENS §8 rule 3) — chrome flows from the pipeline like every
  other color.

## 6. Amendment protocol

The language evolves the same way the rulebook does: the round that changes
the UI updates these files in the same commit family, and
DESIGN-SYSTEM.md §1 links here as the language layer. Owner verdicts
supersede everything (the standing rule) — when the owner rules, the ruling
lands in the relevant file's header note with the round number.
