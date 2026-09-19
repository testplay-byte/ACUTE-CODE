<!-- last-reviewed: 2026-09-19 round-108 -->
<!-- round: 108 -->
# Round 108 (part e) — the clay rework: form, not paint

The owner's round-108 verdict on v1.0.3 (R107-g's clay/chrome pass): "The new
version of the application was installed successfully without any issues or
problems whatsoever… I was not satisfied with the results. You implemented
clay but it was not implemented properly. At the very top you implemented
some glow fade and other stuff like that, which I was not satisfied with.
Maybe you need to look into it a bit better."

This file records workstream R108-e (the frontend-styling rework). The
round's other workstreams are recorded in the session worklog.

## §1 The diagnosis — what R107-g actually shipped

Every R107-g surface, audited and classified against the critique:

| R107-g element | Where it lived | Verdict |
|---|---|---|
| `.ac-clay-light` gradient top-light (white@30% fading out by 40% height) | all four dashboard StatCards | **the "glow fade" itself — REMOVED.** A white gradient painted over the top of every stat card reads as a tacked-on light wash, not as clay. |
| `.ac-chrome-edge` 1px top-edge glint hairline | StatCard, TitleBar, both theme pickers' selected cards | **the "stuff like that" at the very top — REMOVED everywhere.** The TitleBar hairline sat at the literal top of the window; conservative call: the owner was "not satisfied," so nothing gradient-glint survives on working UI. |
| Composer chrome focus glint (`.composer-shell::before`, 35%→100% hairline) | the composer shell | **REMOVED.** Another gradient glint at the top of a working surface; the owner-directed R105-B focus (accent edge + halo) is the complete focus story. |
| Third ambient glow as a platinum wash (`--ac-chrome-hi`@18%, blurred white light) | the wizard stage | **REVERTED to the round-98 owner-approved warm stage** (second accent `accent2`@6%). A blurred white light is a glow, not material. |
| `.ac-chrome-metal` platinum ramp | the wizard `CODE.` hero block | **KEPT** — a metal plate reads as material (the "jewelry"). |
| `.ac-chrome-sheen` 9s ambient pass | wizard hero + enabled CTAs | **KEPT but HALVED** — sheen stop 0.55→0.30 light / 0.16→0.10 dark, band width 16%→8% of the gradient. "Jewelry, rationed": a glint catching the light, not a shine sweep. |
| Clay Studio THEME (the palette) | `THEMES` table | **KEPT untouched** — the owner's issue was the material's execution, not the terracotta/sand palette (all theme tests still pin it). |

## §2 The rework — clay as shadow + form

The new clay material (TOKENS §9, COMPONENTS §8):

- **`--ac-clay-shadow`** — light: `0 2px 4px rgba(42,32,24,0.08), 0 16px 40px
  -8px rgba(42,32,24,0.13)`; dark: `0 2px 4px rgba(0,0,0,0.35), 0 16px 40px
  -8px rgba(0,0,0,0.45)`. Two legs, always: a TIGHT directional contact
  shadow (the card resting on the surface) under a LARGER very soft ambient
  one. Warm-tinted in light mode — the clay ink `#2A2018` family, because
  ceramics cast warm shadows, never cold black.
- **`--ac-clay-shadow-sm`** — the small-surface step (`0 1px 2px … + 0 8px
  20px -4px …`), same recipe at half the ambient footprint.
- Both ride the standard pipeline (`deriveThemeStyles()` →
  `syncThemeCssVars()` → `:root` pre-paint fallbacks) — the same slot as
  `softShadow`/`bentoShadow`, mode-aware + theme-independent.
- **`.ac-clay` / `.ac-clay-sm`** pattern classes paint `box-shadow` ONLY —
  no pseudo-elements, no host contract, composes with any inline
  `backgroundColor` exactly like the old inline `softShadow` leg did.

Applied to: **StatCard** (dashboard + usage DataStatsPanel — the inline
`softShadow` retired in favor of the class) and **TitleBar** (the app's
literal top now reads as a tactile slab resting on the frame — the honest
clay replacement for the removed hairline).

## §3 What shipped

| Surface | Change |
|---|---|
| `src/lib/themes.ts` | `clayShadow`/`clayShadowSm` added to `ThemeStyles` + `deriveThemeStyles()` + the bridge (`--ac-clay-shadow`, `--ac-clay-shadow-sm`); `--ac-chrome-sheen` halved (0.30/0.10). |
| `src/index.css` | `.ac-clay-light` + `.ac-chrome-edge` + the composer glint DELETED; `.ac-clay`/`.ac-clay-sm` added; the sheen band narrowed 16%→8%; `:root` fallbacks for the new vars + the halved sheen. |
| Dashboard | StatCard: `ac-clay` (shadow form) replaces the gradient top-light + hairline; inline `boxShadow: softShadow` removed (the class owns depth now). |
| App frame | TitleBar: `ac-clay` — soft warm shadow under the frosted bar; `relative` + `ac-chrome-edge` gone. |
| Composer | The chrome glint pseudo-element removed; R105-B accent edge + halo untouched (the owner-directed focus grammar). |
| Theme pickers | The chrome hairline removed from the selected cards (Settings + wizard flavor grid) — selection is the accent border + ring, as before R107-g. |
| Setup wizard | Third ambient glow reverted to the warm `accent2`@6% stage; the `CODE.` hero keeps metal + the quieter sheen; ActionButton/Get Started keep the quieter sheen over their accent gradients. |
| Tests | `themes.test.ts`: sheen pinned at the halved stops; new clay-shadow describes (two-legged form, warm light tint, mode-aware, theme-independent, sm step-down). `TitleBar.test.tsx`: the R59-A shell pin extended — `ac-clay` present + `ac-chrome-edge` pinned DEAD (the bar is Tauri-only, so the browser shots can't show it; the test is the visual contract's enforcer). |
| Docs | TOKENS §9 (new — the clay shadow material) + §8 (sheen halved, glow classes gone) + §1c; COMPONENTS §8 reworked; MOTION §3/§4; WIZARD-DNA §1/§2/§7; WINDOW-CONTROLS §1; USAGE §5 (+1 do-not); DESIGN-SYSTEM §1. All stamps → round-108. |

## §4 Deliberately NOT done

- The Clay Studio THEME palette untouched (contrast-calibrated in R107-g;
  the critique was the material's execution, not the colors).
- No `.ac-clay` spread to the dashboard's chart/quick-actions/recent-activity
  cards yet — they keep their `softShadow`/flat resting treatment (the
  R107-g boundary held); a follow-up can unify the dashboard bento family
  on the clay recipe if the owner likes the stat-row read.
- No sheen/metal on any working-UI surface (unchanged law); Send/Stop
  untouched (R100-D pins).
- No new type-ladder steps, radii, hexes, or JS hovers — the audit never
  moved (no baseline re-pin needed: the rework only REMOVED class usages).
- Nothing in agent-core/cli/mobile/workflows; no git mutations (the
  orchestrator reviews + commits).

## §5 Verification

- `pnpm design:audit` — clean (R1 101/101, R2 1573/1573, R3 0/0, R4 18/18,
  R5 31/31 — all at baseline; ZERO re-pins).
- `pnpm typecheck` — clean. `eslint` on every touched file — clean.
- `npx vitest run` on the touched areas — 36 files / 635 tests green
  (lib + dashboard + shell + SettingsPage + onboarding + composer),
  including the 9-test themes suite.
- `pnpm docs:check` — clean.
- Visual: headless-browser screenshots at 1920×1080, clay theme pinned via
  localStorage, light AND dark — wizard welcome, flavor picker, dashboard
  (see `shots/`): no gradient glow/fade overlays at the top anywhere, the
  stat cards + title bar read matte/soft/tactile via the warm layered
  shadow, the wizard hero reads as a metal plate with a quiet glint, zero
  console errors.
- Re-verification pass (same round, post-work): computed-style proofs on
  the live DOM — the 4 stat cards render the exact two-legged recipe
  (warm `rgba(42,32,24)` legs light / black legs dark), a full-document
  pseudo-element sweep finds ZERO gradient `::before`/`::after` on the
  dashboard and exactly TWO on the wizard (the hero + CTA sheen bands at
  the halved stops, 46–54% narrowed gradient); the picker cards have
  `::before: none`; the CTA sheen's mid-pass lift measured at the pixel
  level tops out ≈45/255 brightness on the terracotta (a gentle peach
  glint — jewelry, not a slash). Full root suite re-run green (4087
  passed / 15 skipped); vite build green.
- Owner walkthrough: PENDING — the round closes when he sees it running.
