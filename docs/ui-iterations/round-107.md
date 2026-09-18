<!-- last-reviewed: 2026-09-18 round-107 -->
<!-- round: 107 -->
# Round 107 (part g) — the Clay Studio theme + the liquid-chrome patterns

The owner's round-107 UI directive: "In some areas I would like you to go
with the Clay Studio aesthetic and also a mixture of liquid chrome in that…
to make sure the overall UI looks much better, much more proper, and much
more well-handled."

This file records the design-language half of that ask (workstream R107-g,
the frontend-styling pass). The round's logic/commands workstreams
(R107-a/b/c) are recorded in the session worklog, not here.

## §1 What "clay substrate, chrome jewelry" means here

- **Clay Studio** = a sixth THEME (the cleanest whole-app vehicle — the
  THEMES table is append-only by design): hand-thrown-ceramics warmth —
  sand neutrals, a muted terracotta accent, a brown-tinted charcoal for
  dark mode. Matte, soft, approachable. NOT indigo/blue (the standing ban).
- **Liquid chrome** = a cross-theme TOKEN family + CSS pattern classes:
  a warm-platinum ramp (`--ac-chrome-hi/mid/lo`), a moving highlight band
  (`--ac-chrome-sheen`), a reflective 1px hairline, and a soft clay
  top-light. Metal as the accent counterpoint, rationed to signature
  surfaces.
- The division of labor is documented as language: TOKENS §1b (the theme)
  + §8 (the ramp), COMPONENTS §8 (the pattern classes + where each is
  allowed), MOTION §3 (the `ac-chrome-pass` keyframe), WIZARD-DNA §1/§2/§7
  (the wizard refresh), WINDOW-CONTROLS §1 (the title-bar hairline).

## §2 What shipped

| Surface | Change |
|---|---|
| Theme catalog | **Clay Studio** appended to `THEMES` (id `clay`) — terracotta `#C4653F` / `#D98A63` accent, sand `#F4EEE5`/`#FDFBF7` light, warm charcoal `#26211C`/`#2F2924` dark, warm ink `#2A2018`/`#F2EBE1`. Contrast measured against the envelope the five existing themes tolerate (accent/bg 3.45:1 light, 5.90:1 dark, ink 13–15:1). Presents itself in both pickers automatically (Settings + wizard step 1) — zero special-casing. |
| Token pipeline | Four `--ac-chrome-*` vars added to `syncThemeCssVars()` (mode-aware, theme-independent) + `:root` pre-paint fallbacks in `src/index.css`. |
| Pattern classes | `.ac-clay-light` (top-light diffusion), `.ac-chrome-edge` (reflective hairline), `.ac-chrome-metal` (platinum ramp), `.ac-chrome-sheen` (the ambient 9s pass; `ac-chrome-pass` keyframe; explicit reduced-motion rule hides the band). |
| Dashboard | StatCard carries clay top-light + chrome hairline — composes with the existing inline card/accent/shadow styles; no layout change (h-[92px] pin intact). |
| Composer | The R105-B whole-section focus keeps its accent edge + halo; a chrome glint hairline now rides the shell's top edge (35% at rest → 100% on focus-within, opacity-only 200ms). |
| App frame | TitleBar carries the chrome hairline (`relative` + `ac-chrome-edge`; pointer-events:none so the Tauri drag region works through it). Window-control grammar untouched (WINDOW-CONTROLS §2). |
| Theme pickers | The SELECTED card in Settings and the wizard's flavor grid carries the chrome hairline — the chosen theme gets the glint. |
| Setup wizard | The hero `CODE.` block is now liquid chrome (platinum ramp + ambient sheen, ink `--ac-text`); the primary ActionButton (enabled state only) + the Welcome "Get Started" button carry the sheen over their accent gradients; the third ambient glow is a platinum wash instead of accent-colored (two warm + one cool). |
| Tests | New `src/lib/themes.test.ts` (catalog shape, warm-family check, both-mode resolution, contrast envelope, chrome vars mode-aware + theme-independent); SettingsPage's theme-grid pin extended to the sixth card. |

## §3 Deliberately NOT done

- No sheen/hairline on chat transcript surfaces, tool rows, or working
  buttons — MOTION rule 3 (resting UI never fidgets) + WIZARD-DNA §8.
- The dashboard hero text stays de-costumed (R100-G verdict held — the
  chrome lives on the stat cards, not a re-costumed display title).
- No new type-ladder steps, no new radii, no baseline re-pin — every count
  stayed at or under the pinned baseline (audit clean, 102 files).
- The Send/Stop buttons untouched (R100-D "no glow, no fidget" pins).

## §4 Verification

- `pnpm design:audit` — clean (R1 101/101, R2 1573/1573, R3 0/0, R4 18/18,
  R5 31/31 — all at baseline; no re-pin needed).
- `pnpm typecheck` — clean. `eslint` on every touched file — clean.
- `npx vitest run` on the touched suites — themes/theme-store (14),
  SettingsPage + Dashboard + TitleBar + SetupWizard (63), Composer (91) —
  all green.
- Visual: VLM-reviewed screenshots at 1920×1080 in the sandbox
  (`pnpm dev` + headless browser; wizard welcome/picker + dashboard, clay
  light AND dark) — confirmed: the warm terracotta/sand read, the selected
  card's + all four stat cards' top-edge hairline, the CODE. block reading
  as liquid chrome with legible ink, the CTA sheen mid-pass, zero console
  errors, zero layout glitches. The highlight stat card's glint is also
  verified via computed styles (white 55% gradient at opacity 1 — visually
  subtler on the lighter accent fill, by design).
- Owner walkthrough: PENDING — the round closes when he sees it running.
