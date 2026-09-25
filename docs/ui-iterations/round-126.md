<!-- last-reviewed: 2026-09-25 round-126 -->
# ROUND 126 — the Clay Companion redesign: the complete PC UI on the Android app's design language

**The owner's directive:** "In this round, you are only going to focus on the UI redesign… completely
redesign the whole UI of the desktop application… utilize sub-agents and make them work on the things
independently. Then you are going to review their work properly, and do not be easy on them… go one
page at a time… we are going to go with a similar UI design to our Android application. We are not
going to outright copy it… also we are going to build the PC design version design language
documentation along the way… keep the door open for backup to the current state easily."

The rollback door: **`backup/pre-redesign-r126`** (pushed at v0.118.0 / main HEAD 515825c).

## §0 The language (what "Clay Companion" means on the PC)

The mobile constitution (`docs/design-language/android/` — "Clay Companion") is the reference; the
PC adapts it (never copies): the same material (clay substrate, two-tier accent, badge tones, the
house springs), PC densities (32px nav rows, IDE row tables, 240px sidebar), PC idioms (the shell +
dialogs instead of the tab bar + sheets). The constitution is now `docs/design-language/` itself —
TOKENS (with the new §1d two-tier accent, §10 surface ladder, §11 status grammar), MOTION (the
spring grammar on framer-motion — `{180,22}` house, `{180,24}` disclosure/sheet, `{200,26}` tab),
COMPONENTS (the clay card/chip/button recipes + the R119/R120 chat anatomy untouched), SCREENS
(NEW: the five PC archetypes + the navigation laws), USAGE, WIZARD-DNA (kept — the wizard stays the
one theatrical surface), WINDOW-CONTROLS.

## §1 The foundation (the orchestrator, personally)

- **The token bridge** (`themes.ts` + `theme-store.ts` + `index.css`): the clay theme's literals are
  the mobile entry VERBATIM; `deriveThemeStyles` gained the mobile resolution prologue (inkWarm
  family, two-tier accent, clay's accentText hard-pin, the AA ink ladder, well/header/tint/rim
  formulas, badgeTint 12%/20%); 24 new `--ac-*` vars + 27 Tailwind mappings + 6 pattern classes
  (`.ac-well`, `.ac-clay-rim`, `.ac-clay-edge-dark`, `.ac-clay-pressed`, `.ac-clay-sheet`,
  `.ac-mono-block`); the clay shadows retuned to the mobile v2 two-leg strings + the pressed/sheet
  steps; Manrope 400–800 + JetBrains Mono 400/500 bundled (the mobile's own files); the :root
  fallbacks are now the clay/light derivation; **parseColor fixed** (a DOM-without-canvas
  environment silently blacked every mixHex derivative — the hex parser is now the always-available
  fallback).
- **The identity migration**: clay is the default, with a ONE-TIME nova→clay walk on both legs (the
  persisted profile v1→v2 + the server hydration boundary with its one-shot flag and the
  after-the-echo-guard convergence PUT). A deliberate post-migration nova pick rides untouched.
- **The navigation decision** (SCREENS §2 law #2, the round's biggest UX call): the sidebar's project
  row body NAVIGATES into the project's chat; a dedicated hover-revealed rotating chevron owns the
  session-tree toggle. The sessions render in ONE recessed well with hairline dividers. The rail,
  the settings nav, the footer — all on the new selection grammar (accentTint + accentDeep ink +
  the 2px accentDeep marker).

## §2 The waves (sub-agents, one page at a time, review-gated)

| Wave | Surface | The one-line verdict |
|---|---|---|
| 3a | Dashboard | ONE clay stat card (inset-divided cells, ink-only highlight), SectionCard sections, quiet-solid primary, badge-tone statuses, accentDeep bars |
| 3b | Usage | The gliding segmented range control, hairline leaderboards, disclosure drill-down, recessed sub-agent wells |
| 3c | ProjectView | The landing rhymes with the sidebar's session well; quiet-solid New-session |
| 3d-1 | Chat layouts | ~950 dead lines RETIRED (verified unreachable); the chat card is clay |
| 3d-2 | AgentChatPanel | The mobile's user-bubble recipe, deep-accent turn headers, §11 status surfaces, chip-grammar empty state |
| 3d-3 | WorkingSection | THE de-blue: the activity well + §11 status chips + the mono-block tails; running-blue extinct in the money screen |
| 3d-4 | Composer | The mobile send recipe, chip-grammar toolbar, clay flyouts, the themed ContextDonut |
| 3e | Right sidebar | The panel chrome + seven panels; THE SubAgentPanel de-blue ledger (10 conversions) |
| 3f-1/2/3 | Settings | SectionCard's own conversion; the 5,525-line giant's 48 arbitrary borders → 0; the nine-tab breadth wave |
| 3g | Wizard | The theatrical DNA KEPT on clay-derived materials (the glows derive from the accent family now) |
| 3h | Coherence | Toaster/bell/agents/demos + every sibling-flagged debt closed + the orphan retirement + the duration sweep |

Every wave: gates green before its record (tsc + its suites + the FULL suite + eslint +
design-audit), live browser verification in both modes (computed styles matched the TOKENS literals
verbatim — the rims, the two-leg shadows, the badge tones), VLM reviews of the screenshots, and the
worklog discipline (the interrupted-run successor pattern: audit → tighten → verify → record).

## §3 The evidence

- **Gates (final)**: tsc CLEAN · **274 suites / 4,840 tests** GREEN · eslint CLEAN · design-audit
  CLEAN with counts only DOWN (hex 101→74, arbitrary values 1635→1519, heavy weights 16→12, JS
  hovers 21→13) · the production build BUILDS (mermaid chunk check ok) · e2e 12/12 · license clean.
- **The audit's drift ratchet moved DOWN ~90 spellings** — the redesign paid for itself in
  consistency debt alone.
- **Screenshots** (`shots/r126/`): shell-dashboard-{dark,light}, chat-screen-clay,
  dashboard-3a-*, usage-3b-*, projectview-3c-*, chatpanel-3d2-*, workingsection-3d3-*,
  composer-3d4-*, rightsidebar-3e-*, settings-3f1-*, modelsproviders-3f2-*, settings-3f3-*,
  wizard-3g-*, notifications-3h, agents-3h, final-{dashboard,chat,settings}.
- **VLM verdicts** (the review gate): "polished, high-fidelity redesign that effectively communicates
  the Clay materiality" (shell), "highly cohesive… the color palette is restricted to variations of
  brown, charcoal, and terracotta" (chat — no blue areas flagged), "cohesive clay material… no large
  blue-filled areas" (right sidebar), "executed with high fidelity… modern and grounded" (the final
  chat acceptance).

## §4 The honest caveats

1. **Kept by design** (the owner's own laws, flagged by every VLM pass): the per-project identity
   colors (the blue marketing-site avatar is the project's OWN color, R48-a) and the AA secondary
   ink tiers (0.62/0.52 — the mobile ladder, deliberately dimmer than primary).
2. **Verified at pin level, not live**: the streaming-state materials (the live caret mid-stream,
   the retry ladder waiting), the real sidecar's test bands (the live passes rode the demo
   fixtures + route mocks), and the secondary OS windows (audit + suites only). The owner's next
   device pass is the live confirmation.
3. **The doc-vs-code care**: every supersession is recorded in-round (DESIGN-SYSTEM's R126 note,
   TOKENS §1b/§5, the README's mobile-relationship rule); no rule was silently edited.
4. The jump-to-latest pill and the queued-bubble veil keep their pre-R126 spellings (documented
   keeps by 3d-2); the bell's open-tint rides the shell's inline pattern (neighbor coherence).
