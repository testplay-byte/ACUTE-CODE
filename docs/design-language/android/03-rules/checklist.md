<!-- last-reviewed: 2026-09-23 round-120 -->

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

## Round-119 additions

- [ ] The composer is ONE row in every state — the input sits LEFT of the attach
      circle; no reserved band, no overlay paperclip, cap 146 (`chat.md` §Composer).
- [ ] ONE visual turn per exchange — the TurnBlock (activity rail / recessed well /
      tool rows / reply); no standalone thinking/tool/assistant cards as list items
      (`chat.md` §Transcript).
- [ ] Queued user rows render AFTER the in-progress turn, AS A MESSAGE — never a
      banner, never above the running turn (donts #49).
- [ ] The model level is the provider accordion — provider rows by default, ONE
      section open at a time, apply-and-return; no root rows trailing the list
      (donts #50/#51).
- [ ] Kebab level swaps animate — the directional 12dp slide + crossfade (reduced
      motion fades); never an instant re-render (`motion.md` §4.12).
- [ ] The model test probes TOOLS — the verdict line reports the tools leg honestly
      ("tools ✓ (called echo)" / accepted-but-text / rejected + the raw reason); a
      hard tools-rejection fails the test (`components.md` §Sheets).

## Round-120 additions

- [ ] ONE consolidated turn footer — "Ran {duration} · {n} actions · {tokens}
      tokens" (mono tabular-nums, the full breakdown on the title); no
      per-section duration blocks, ONE live clock per turn (donts #56; PC
      `COMPONENTS.md` §7 — the mobile twin is the TurnBlock rail).
- [ ] The fold renders file mutations — write/edit/create rows with path +
      verdict + diff summary, never hidden behind the collapse (PC
      `COMPONENTS.md` §7; mobile `chat.md` §Transcript — the settled well
      keeps every tool.use row).
- [ ] The composer dock law — the Add Context control DOCKED inside the
      inputWrap at the input's bottom-right (4/2), paddingRight 52 reserving
      its column on every line, never an overlap; the @-menu renders ABOVE
      the input (`chat.md` §Composer; donts #57).
- [ ] The toast law — one transient verdict, 2s auto-dismiss, newest
      replaces, TOP placement, the sheet's own ToastHost (`components.md`
      §Toast; donts #58).
- [ ] The live-turn truth law — the working/stop state derives from the
      BACKEND's turn registry (GET /sessions/:id/live, the 5s truth poll +
      rehydrateLiveTurn's mirror/detach/retire), never from "no frames
      lately" (PC `COMPONENTS.md` §7).
- [ ] The timeline minimap grammar (PC — mobile N/A): one bar per user
      exchange, hover-proximity scaling (28px peak / 8px rest / 56px
      falloff), current-exchange accent, the 2+2-line popover, click-to-
      scroll (`COMPONENTS.md` §7).
- [ ] Buttons carry no sheen/glow anywhere — the quiet-solid family, `sheen`
      deleted (donts #53); no inline key-row actions (donts #54); the model
      list grows only on Save (donts #55).
