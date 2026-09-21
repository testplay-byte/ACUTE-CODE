<!-- last-reviewed: 2026-09-21 round-116 -->

# Rules — The Don'ts (the slop signature)

Any one of these in a diff = reject and rework. They are the exact patterns the owner
called out across three rounds of feedback.

## Layout slop

1. **Multi-line descriptions** on cards, options, sheets, footers. One line, or none.
2. **Step numbers / 1-2-3 dots / progress paragraphs** in wizards.
3. **Redundant affordances** — two buttons to the same screen (the scan card + scan
   CTA), a chevron AND an action button on one row.
4. **Full-width "New X" actions at list tops** with descriptions and arrows. New
   actions live at list bottoms, icon + two words.
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

## Round-116 additions (the owner's v0.109.0 walkthrough)

31. **Wrapping descriptions** — #1 is now enforced in code: `numberOfLines={1}` on
    EVERY description/caption/option body; wrapping is a defect, not a layout
    accident.
32. **Off-center "centered" titles** — a title centered in the space REMAINING beside
    side slots is not centered. Absolutely-center it over the header row.
33. **Vertical tab labels** — icon-over-text stacks with every label always visible.
    The bar is horizontal chips; the label renders only on the selected item.
34. **Hairline selection borders** on segmented controls / tab indicators — 2px when
    selected, always.
35. **Machine truth in identity rows** — base URLs and API-key counts never appear in
    list rows; providers rows carry the models count + a colored identity.
36. **"Agent default" rows in model pickers** — the picker lists real models only and
    highlights the PC's actual selection.
37. **Right-side FAIL text badges on tool cards** — failures read as a compact danger
    row + expandable details, never a shouty badge column.
38. **Square camera viewfinders** — the scanner frame is portrait, monochrome-
    treated, with the decode path untouched.
39. **Two option cards where ONE primary button carries the intent** (the unpaired
    home's single Connect-to-PC).
40. **Left-hugging bottom actions** — the list-bottom "New X" is centered.
41. **Back chevrons without a chip** — 44px target, subtle fill + hairline border.
