<!-- last-reviewed: 2026-09-17 round-100 -->
<!-- round: 100 -->

# ROUND-100 MASTER PLAN — the honest browser + the UI that stops looking generated

The owner's eleventh walkthrough (v0.97.0): the browser "is still utilizing
the Microsoft Edge browser under the hood" and "the size is 4x what the
previous one was"; the UI "looks way too bad. It looks AI-generated" with
only the startup page + setup wizard spared; the chat window needs a
complete overhaul; the agent should be improved and "tested in your own
environment too"; and a proper Linux release. This plan binds the round's
two research reports to workstreams. **The research docs are normative for
the how; this plan is normative for the what and the order.**

- Research A (browser + Linux): `docs/research/browser-engine-and-linux-round-100.md`
- Research B (UI): `docs/research/ui-design-language-round-100.md`

## The decisions (from the research, ruled by the orchestrator)

**D1 — Browser (Windows):** revert `fixedRuntime` → `downloadBootstrapper`,
delete the `webview2-runtime` resource + CI cab-fetch (installer ~258 MB →
~37–40 MB), de-brand the panel's child webviews (custom UA without the
`Edg/` token, `AcuteBrowser/1.0` added), and add the honest Engine line
(Settings → Browser + About). The trilemma is measured and real: on Windows
2026 you pick two of {not-Chromium, production compat, ≤100 MB} — Servo is
66.4% WPT (breaks real sites), CEF is +165 MB (worse than the complaint).
The honest path is: small installer, zero visible Edge brand, full compat —
plus the genuinely-not-Edge engine arriving via Linux this same round.
Servo stays the documented opt-in fallback (research §B.2) if the owner
rules Chromium-lineage unacceptable on Windows.

**D2 — Linux release:** deb + AppImage (+rpm if cheap) via a new
`linux-bundles` release.yml job; WebKitGTK panel (not Edge) with the same
15 actions; the `keys.rs` Linux port is the one new subsystem (ADR-0031);
AppImage = the auto-update candidate, deb = check-and-open honesty.

**D3 — UI:** the token system is sound-but-unapplied — revise the two
defective token rules (type floor 10px + weight law; radius 5-step scale),
add the enforcement gate (`scripts/design-audit.mjs`), then apply
per-screen in priority order: chat (P0) → settings (P1) → sidebar (P2) →
dashboard/usage (P3) → right sidebar (P4) → misc (P5). The wizard-DNA
boundary table (research §C3) governs what decoration is legal where.

**D4 — Agent:** live-fire self-test battery on real OpenRouter turns (the
CLI harness), fix what breaks, and teach the agent the platform facts
(Linux build exists; engine lines; the update flows).

## Workstreams (commit + push each after its gates pass)

| id | work | contract |
|---|---|---|
| A | browser size + de-brand | research §B.1 items 1–5 exactly |
| B | Linux release | research §C.1–C.5 (keys ADR, CI job, boot gate, docs, agent awareness) |
| C | tokens revision + audit gate + primitives | research §C1 + §C2 checklist; TOKENS.md/COMPONENTS.md revised; `design-audit.mjs` wired into verify + CI |
| D | chat window overhaul | research §C4 verbatim + the acceptance bar C4.8 |
| E | settings overhaul | research §C2 P1 |
| F | sidebar + shell density | research §C2 P2 + P5 |
| G | dashboard/usage/right-sidebar polish | research §C2 P3 + P4 |
| H | agent live-fire battery + fixes | OpenRouter keys; CLI harness; findings → fixes + re-pins |
| I | close-out | round-100.md, CHANGELOG 0.98.0, status.json, version ×4, HANDOFF, AGENT-MEMORY, ORCHESTRATION-WORKLOG, tag v0.98.0, CI+Release verify, DASHBOARD sync |

Gates per workstream: lint + typecheck + full vitest root suite green
(seen with own eyes), docs:check green, license audit when deps change,
push immediately. UI workstreams additionally: zero new console errors,
the acceptance-bar items for their screen, and screenshots recorded for
round-100.md where feasible (VLM pass if the stack runs).
