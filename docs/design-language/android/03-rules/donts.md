<!-- last-reviewed: 2026-09-20 round-115 -->

# Rules — The Don'ts (the slop signature)

Any one of these in a diff = reject and rework. They are the exact patterns the owner
called out across three rounds of feedback.

## Layout slop

1. **Multi-line descriptions** on cards, options, sheets, footers. One line, or none.
2. **Step numbers / 1-2-3 dots / progress paragraphs** in wizards.
3. **Redundant affordances** — two buttons to the same screen (the scan card + scan
   CTA), a chevron AND an action button on one row.
4. **Full-width "New X" actions at list tops** with descriptions and arrows. New
   actions live at list bottoms, half width, icon + two words.
5. **Footnote essays** under content ("The PIN window is…", "Tap a project to…").
6. **Text-only back buttons.** Always the chevron icon.
7. **Cluttered/cramped forms** — inputs jammed with hint paragraphs between them.
   Generous spacing, one hint max.
8. **Floating gap below a sheet** during its open animation (page background visible).
9. **Headers on tab roots** (titles, bells, pills) — roots are chromeless.
10. **Dead measurement patterns**: height-0-clipped accordions (Yoga deadlock — use
    absolutely-positioned measurement children), KAV-stacked keyboard compensation.

## Visual slop

11. **Glow / apple-shine / gradient washes** on buttons (especially wizard CTAs).
12. **Hardcoded colors, radii, font sizes** instead of the token contract.
13. **Blue or indigo** as accent/default (semantic `running` blue only for live state).
14. **Spinners on list screens** (skeletons instead) or anywhere a calmer idiom exists.
15. **Colored dots standing in for identity avatars** — letters in colored circles.
16. **Squinted images** (fixed tiny tiles for user-sent images).
17. Timestamps floating outside bubbles; meta lines stacked under assistant turns.

## Behavior slop

18. **Asking for derivable data** (project name when the folder gives it; color pickers
    for a server-assigned color).
19. **Un-navigation-capped browsing** (folder "up" past the user's home).
20. **States that lie**: a Pair button on an expired window, an "Auto" model label, a
    "queued" badge on an open session, processing that shows nothing until the first
    delta.
21. **Manual controls for gestural things** (+/- zoom buttons next to pinch).
22. **Flashlight toggles** in scanners (banned; photo-pick instead).
23. **Duplicated near-identical copy blocks** across screens (the three camera-denied
    essays) — one spelling each, shared.
24. **Sheet content below the visible panel** or backgrounds showing through during
    animation.

## Motion slop

25. Static wizard screens (no entrance), color-swap-only state changes.
26. Fidgeting resting UI, looping attention thrash.
27. Animated scan lines that don't travel; dead shared values.
28. Missing haptic on decision moments; haptics per frame.

## Copy slop

29. Any banned word from `copy.md` ("remote", "Auto", mechanism essays).
30. ALL-CAPS hardcoded strings (uppercase via `textTransform` only).
