<!-- last-reviewed: 2026-09-22 round-118 -->

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

## Round-116 additions

- [ ] Every new/edited description, caption, and option body has `numberOfLines={1}`.
- [ ] Every "centered" title is absolutely centered over the row (not leftover-space).
- [ ] Back chevrons ride the chip idiom (44px, subtle fill, hairline border).
- [ ] Sheets: over-damped entrance, clamped progress, skirted panel, no overscroll.
- [ ] Tab bar: horizontal chips, label only on selected, 2px indicator border.
- [ ] Model pickers show real models only — no "Agent default" row.
- [ ] Tool cards: no right-side FAIL badges; failures are compact danger rows.
- [ ] Dashboard numbers are field-provenanced; whole-history sections say "all time".
- [ ] Any mobile package.json/lockfile change → `npm ci --dry-run` proof before tagging
      (MAINTENANCE.md §g 2c — the v0.109.0 lesson).

## Round-118 additions

- [ ] Sheets carry the static initial pose — no first-frame at-rest flash on open
      (`motion.md` §2's law).
- [ ] No field captions inside sheets — label + input only (donts #42).
- [ ] Selectors one-line, all options visible — 2–4 choices, no wrapping chip rows
      (donts #43).
- [ ] CTAs centered and self-sized (`minWidth 200`) — sheets AND pages; destructive
      confirms take the danger tone (donts #44).
- [ ] Sheet close = the circle chip (`QuietIconButton`) — never a bare X, never a
      grip.
- [ ] Back = the arrow (`ArrowLeft` in the quiet circle) — never the chevron bracket
      (donts #6).
