<!-- last-reviewed: 2026-08-25 round-35 -->
# Round 07 — Full model list on expand + unified PlugBrain scroll (2026-08-22)

## Owner report

1. "When I click on the expand button, it should show me the bottom dropdown
   menu… all the available models" — the list did not show the models
   properly.
2. "On taller displays, the plug-in-your-brain screen was not showing
   properly because of the bottom model summary section. The model summary
   section was not scrollable like the top section" — the whole step should
   scroll as ONE unit: configuration at the top, Model Summary at the bottom.

## Fix 1 — expand shows the full catalog

Root cause: opening the dropdown prefilled the search box with the current
model id, so the "list" arrived pre-filtered down to (usually) just
`stealth/ox-alpha`. The expand chevron now clears the filter and lists the
entire live catalog (fetched through the sidecar's OpenRouter provider
adapter). Typing in the field still filters live, and manual ids still commit
on every keystroke.

Verified in the UI (dev:full backend): clicking the expand button rendered
**422 model rows** (meta/, deepseek/, stealth/ox-alpha, tencent/, z-ai/…)
with zero fetch errors.

## Fix 2 — PlugBrain scrolls as one

The step previously kept two internal scroll regions (config column) plus a
FIXED, non-scrolling summary rail — on windows shorter than the rail, the
rail's bottom (including Save & Continue) was clipped out of reach.

Now PlugBrainScreen lives in the wizard's shared scroll wrapper like every
other step: the whole screen scrolls as one unit. Wide windows keep the
approved two-section anatomy (configuration left, summary right, top-aligned
with the right-edge inset); narrow/short windows stack with the summary
below the configuration; tall windows fit on a single page.

Measured (read-only, in-browser) at three viewports after the change:

| Viewport | scrollH vs clientH | Behavior |
|---|---|---|
| 1080×1600 (tall) | 1512 = 1512 | fits on one page, no scrollbar |
| 1920×1080 | 1191 vs 992 | one unified scroll; Save reachable |
| 1280×800 (short) | 1191 vs 712 | one unified scroll; Save reachable |

**Status: delivered; awaiting owner confirmation.**
