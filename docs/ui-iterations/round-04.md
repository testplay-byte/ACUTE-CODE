<!-- last-reviewed: 2026-08-25 round-35 -->
# Round 04 — PickFlavor rebuilt to demo anatomy; NeedBrain padding (2026-08-22)

## PickFlavor rebuild (APPROVED)

Owner's reference image = the demo's own `PickFlavorScreen.tsx`. Rebuilt to
match verbatim:

- **Left column (~60%)**: heading · MODE toggle card · **rich theme cards**
  (Aa chip + name + ✓, full-width palette strip, 54px mini app preview) in a
  2 → 3 column grid · Back/Continue flow **directly under the grid** — never
  pinned to the window bottom.
- **Right column (~40%, sticky)**: LIVE PREVIEW panel at natural height
  (code window + Contrast/Vibe stats inside the panel) with the themed tip
  bar below it.
- **All five demo themes** ported verbatim into `src/lib/themes.ts`:
  Nova Cream, Midnight Lab, Bento Blue, Sunset Pop, Mono Stone (the
  achromatic-accent check handles Mono without any id special-casing).

Owner verdict: **"Pick your flavor is now much better. It is exactly like how
it was supposed to be from the start."**

Also noted (queued): the Continue button felt "kind of dialed out" → fixed in
round 05.

## NeedBrain bottom-button padding (APPROVED scope, delivered)

Action row pinned via `mt-auto` had zero space beneath it. Added
`pb-6 md:pb-8 short:pb-4` to the row; browser-verified gap below
Back / Configure Model. Typecheck + wizard tests + build green. Pushed in
`d470418` (CI success).
