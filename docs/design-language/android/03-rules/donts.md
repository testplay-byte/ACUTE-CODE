<!-- last-reviewed: 2026-09-22 round-119 -->

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
6. **Text-only back buttons.** Always the arrow — `ArrowLeft` in the quiet circle
   chip (R118-D). Never the chevron bracket (the owner's word for it), never text.
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
37. **Right-side FAIL text badges on tool rows** — failures read as the row's
    inline danger chip + quiet danger wash + expandable details, never a shouty
    badge column. (R119-A reworded: the standalone tool CARDS became the TurnBlock's
    well rows — the law stands, the noun changed.)
38. **Square camera viewfinders** — the scanner frame is portrait, monochrome-
    treated, with the decode path untouched.
39. **Two option cards where ONE primary button carries the intent** (the unpaired
    home's single Connect-to-PC).
40. **Left-hugging bottom actions** — the list-bottom "New X" is centered.
41. **Back chevrons without a chip** — 44px target, subtle fill + hairline border.

## Round-118 additions (the owner's v0.111.0 walkthrough)

42. **Field captions/description blocks inside sheets** — label + input only; no
    explainer essays between fields, no consequence captions under CTAs (R118-A).
43. **Segmented options that wrap or hide** — 2–4 choices on ONE line, all visible
    (R118-A).
44. **Full-width CTAs in sheets** — centered, self-sized, `minWidth 200`; the
    destructive confirm takes the danger tone; quiet escapes centered beneath
    (R118-A).
45. **Grab handles on non-draggable sheets** — a drag strip on a Modal sheet is a
    lying affordance; the grip is deleted (R118-A).
46. **State glyphs duplicating the body** — a tick/clock ladder restating what the
    body already colors; the delivery ticks are retired for this reason (R118-D).
47. **One-shot destructive rows** — Stop/Remove/Delete rows that fire on the first
    tap; arm in place first ("Do you want to stop?") or open the centered confirm
    (R118-D).
48. **Controls without content** — an always-mounted disabled queue button with
    nothing to send, a spinner on a vanished result: if there is nothing to act on,
    render nothing (R118-D).

## Round-119 additions (the owner's v0.112.0 walkthrough)

49. **Queued messages rendered as banners/notifications** — a queued message is a
    MESSAGE: the user-bubble idiom with waiting chrome around it (the 0.75-opacity
    bubble / the dull sending rung + the mono "queued" caption), never an amber
    warning card, never a notification strip (R119-C — the owner's exact verdict:
    it "does not appear as a message, but rather as a notification or error
    message"). And it renders AFTER the in-progress turn, never above it (R119-A).
50. **A selector level that trails the parent's rows** — a sub-level with no
    explicit empty branch lets the root rows render BENEATH the level's own list
    (the model-level defect the owner reported); every level owns its complete row
    set — nothing trails (R119-B).
51. **Pickers that expand everything by default** — a flat, fully-sectioned wall of
    every model where a provider row (name + count + chevron) would do: provider
    names by default, ONE section open at a time (R119-B — the owner's ask).
52. **The composer input above the attach control** — two-tier input geometry
    (full-width text over a reserved band) is deleted; the input sits LEFT of the
    add-file circle in EVERY state, tall included (R119-B — the owner's exact
    words: "the text would be typed on the left side of the add file option").
