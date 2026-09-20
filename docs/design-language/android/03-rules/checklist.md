<!-- last-reviewed: 2026-09-20 round-115 -->

# Rules — The Pre-Merge Checklist

Run against every mobile diff before review. A "no" to any question = rework.

## Structure

- [ ] Which archetype is this screen? (minimal-center / list / detail / chat) — name it
      in the PR description.
- [ ] Every description is ONE line or deleted.
- [ ] No footnotes, no kicker essays, no step indicators.
- [ ] Actions: one primary per screen; escapes are quiet; "New X" at list bottoms.
- [ ] Back buttons are chevron icons.

## Tokens & components

- [ ] Zero hardcoded colors/sizes/radii — everything from `useTheme().tokens` /
      `tokens.ts` (new values ADDED to the contract, not inlined).
- [ ] Reused primitives (`ClayCard`, `PressableCard`, `Sheet`, `ClayInput`, Type
      components); shared-primitives edits are additive only.
- [ ] Letter avatars for project identity (no colored dots).
- [ ] No blue/indigo accents; no glow/sheen on wizard CTAs.

## Motion

- [ ] Entrance animation on every wizard/screen hero (fade-in-up, stagger).
- [ ] State changes animate (granted/linked/expanded/settled) per `motion.md`.
- [ ] The one spring (180/22) — no linear easing, no fidgeting rests.
- [ ] Haptics: one per moment, from the 4-word vocabulary.

## Copy

- [ ] No banned words ("remote", "Auto", mechanism essays).
- [ ] Button labels ≤ 3 words.
- [ ] Reused state vocabulary (`copy.md`) — no fresh spellings of known states.

## Honesty

- [ ] No lying states (dead buttons on expired windows, phantom statuses).
- [ ] Loading = skeletons; errors = honest one-line + retry.
- [ ] Derived data is never asked from the user.
- [ ] The model ladder displays honestly end-to-end.

## Machine gates

- [ ] `pnpm lint` + `pnpm typecheck` clean (repo root, mobile included).
- [ ] `pnpm test` — touched feature files have tests updated/pinned (pure helpers get
      table-driven tests).
- [ ] Design audit not violated (PC tree where relevant).

## Process

- [ ] Worklog appended (Task ID, agent, steps, stage summary).
- [ ] Docs amended (not silently edited) if the owner's verdicts superseded a rule.
