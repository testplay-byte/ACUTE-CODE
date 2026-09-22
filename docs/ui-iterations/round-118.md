<!-- last-reviewed: 2026-09-22 round-118 -->

# Round 118 — the fit-and-finish round (the owner's v0.111.0 device report: the chrome everywhere, the sheet system, the dashboard rethink)

The owner tested v0.111.0 on his Android device AND his Windows PC. The verdict on the
elevation round: the home screen reads proper ("depth looks proper, things well managed,
well separated, looking clean") and the session layout "looks good and beautiful" — the
foundation holds. What follows is his exhaustive punch list, transcribed faithfully into
work items. HIS EXPLICIT SEQUENCING: everything below EXCEPT the transcript-center
cards rethink ships in this round as v0.112.0 (Android + PC); the message-delivery
states (grayscale → normal → animated) ARE in scope; the center-section card rethink
(thinking/tool/failed-tool as separate cards, on BOTH platforms) is EXCLUDED — after the
release is verified, we EXPLAIN the center-section plan to him before touching it.

## §1 The owner's report — itemized

### A. The bottom navigation bar (his first impression — "needs a little UI redo")
1. **Corner glitches**: on all four corners the bar looks like "a sticker has been
   pasted and the sharp corners of it are shown… its boundaries are showing" — an
   edge/border artifact at the rounded corners.
2. **Edge padding for the selection**: with Home or More selected, the pill sits too
   close to the bar's left/right edges — it needs inset.
3. **Pill fit**: the selection bubble must FIT ITS CONTENT with proper padding. Home's
   icon+text ride too close to the bubble's sides; **Projects is the reference** ("there
   is proper padding, everything looks clean").
4. **Approval truncation**: the full "Approval" label is cut off. The full text must
   show, and "the other elements should move right or left while maintaining
   consistency and proper spacing" — i.e. ADAPTIVE slots, not fixed flex:1.
5. **Dashboard label**: shows, but neighboring icons sit too close to the selection.
6. **More label**: doesn't display properly, sits too close to the right edge.
7. **The bar's own border** needs to be "a bit more proper and a bit more better".

### B. Home — live preview + buttons
8. The live preview needs "a unique animated kind of experience" — much more animated.
9. The bottom two buttons on home must not sit flush at the very bottom — more
   breathing room below them.

### C. Home — recent activities
10. The five recent activities have NO separation — add divider lines (like the More
    section's stats dividers) but MORE visible, and raise the More section's divider
    visibility too (both places).

### D. Activities — mark all read
11. Tapping "mark all read" instantly errors "couldn't reach the desktop, try again"
    with NO trying state — while the top-right LIVE status shows connected. Suspect a
    wrong endpoint/shape or a reachability guard misfire. Diagnose + fix.

### E. Dashboard
12. Projects all-time: good collapsed; expanded is dirty — session rows lack
    separation, EVERY row shows the "open" tag (wrong — per-session status), tokens and
    price need proper formatting, session names need handling. The model chip was liked.
13. **Bounce**: the expand bounce must be SMOOTHER; the COLLAPSE must have NO bounce at
    all.
14. **The rest of the dashboard needs a real mobile-first layout rethink**: the
    14/30/90-day selector "most definitely not good", the scrollable cards row is a bad
    experience, daily token usage not clean, the models section not well handled —
    "which things need to be shown, how, and in which format" — plan for mobile first,
    tablet as the secondary target.

### F. More section — the top hero
15. The top section (Acute Companion + details) is not well handled. MOVE the live
    status from the home top into the More top section, COMBINED into one hero.
16. REMOVE the connection section from settings; it belongs in that same More hero —
    tapping the hero leads to the connections screen with the details, manage/scan/switch
    actions.
17. The connection screen itself: manage the connection, scan a NEW connection, and
    **switch between multiple PCs** — the multi-host capability the owner has now asked
    for twice.

### G. Appearance settings
18. The mode selector (system/dark/light) bounces too much — reduce, make smoother.
19. Chat customizability layout rework: heading at top with NO descriptions ever shown;
    the options render at the BOTTOM (not the right side), taking nearly full width,
    centered.
20. Remove the "synced across devices, applied live" footer status line.

### H. Providers (his words: "the area where you need to focus on properly")
21. "Your Providers" heading a bit bigger; provider NAMES bolder; a real separation
    between the providers list and the add section.
22. The Add-a-Provider button: CENTERED, not full width, better UI.
23. The add-provider bottom sheet is "trash" — the UNIVERSAL sheet problems (see §I).
24. Provider detail page (status, name, base URL, rename, test connection, API keys)
    "way too bad… needs to be well planned" — full layout rethink, incl. the
    add-API-key sheet.
25. Models: show the model NAME only (never the ID); the model-details sheet needs the
    universal treatment; the edit-model sheet the same.
26. **Test model: the PC shows NO status** while the device reports properly —
    surface the test result on the PC too.

### I. The UNIVERSAL bottom-sheet system (called out by name — this gates everything)
27. "It does not follow our design language… the animation is bad. First it opens
    directly from the bottom, THEN after a small while it plays the animation and stops"
    — the first-frame flash + late spring (the Modal-mount/Reanimated initial-style
    race).
28. The header: the X button "was not proper — needs to be planned better… just like
    how the back button is in our application"; the heading itself not proper; "on the
    left of that heading there was a simple line, which was not good" (the grip).
29. Field DESCRIPTIONS must never be shown (name, base URL, first API key — none of
    them). Input UI + heading UI need the house treatment.
30. The API-format options (chat completions / anthropic messages / responses) must sit
    on ONE line, all three visible at once.
31. The create button at the bottom "looks way too ugly".
32. This system applies to EVERY sheet: add provider, add API key, add model, model
    details, edit model, new project, new session — fix the SHEET once, migrate all
    call sites.

### J. Projects
33. First look: satisfied — clean, proper. But the New Project button opens the ugly
    sheet (§I), and the New Session button "was not according to our design language —
    bad, ugly".
34. Add Project needs a FOLDER option: browsing shows the folders inside + a dedicated
    "create a folder here" affordance so a fresh folder can be made and selected.
35. The manual path entry gets COVERED by the keyboard — it must rise with the keyboard
    (keyboard-aware scroll/avoid).
36. Expanded sessions: no depth, no separation between individual session rows.

### K. Session — the top bar
37. A slightly darker shade than the content below + a separator line at its bottom
    edge, so scrolling content reads against it.
38. More gap after the back button; **the back button must be a REAL arrow** ("I
    explicitly told you to use the back button with an arrow, like you just used a
    bracket") — ArrowLeft, not ChevronLeft; and make it a bit smaller.
39. The kebab menu itself: "quite good, quite satisfied". BUT the mode/model/thinking/
    context options must NOT open bottom sheets — "the top three-dot menu should change
    INTO the mode options and show all the three modes" IN PLACE (an in-place sub-level
    with a way back), same for model selection, thinking level, context details.
40. "Stop this session" must be two-step IN the same menu: first tap swaps the item to
    "Do you want to stop?", the second tap stops. Never one-shot.

### L. Session — the composer (bottom)
41. Long messages: the input area must EXPAND UP (auto-grow) — currently it doesn't.
42. While typing, the highlight/border density must be BOLDER ("increase the
    highlighting density a little bit more").
43. The text must ADAPT AROUND the attach/add-context button — wrap above it or sit
    beside it, never overlap.
44. While the agent processes: keep the stop button but NO "Stop" text — icon only.
45. The queue/send button next to stop: only shown WHEN TEXT IS TYPED — never on an
    empty composer.
46. The text selection does not clear when the keyboard hides — dismiss selection with
    the keyboard.
47. The stop button (bottom-right during processing) also needs a confirmation — this
    one a CENTER pop-up, minimal, in our design language.

### M. Session — message delivery states (IN SCOPE — replaces the double-check marks)
48. "Skip the double-check mark functionality" — it takes precious space. Instead the
    MESSAGE BODY carries the state: (a) just sent = dull grayscale/black-and-white with
    a slight blur; (b) received by the PC = the normal state; (c) the PC processing =
    an animated state on/around the message.

### N. Session — the CENTER (transcript cards) — EXCLUDED, plan only
49. Thinking / tool call / failed tool call / etc. each get "a proper card of itself,
    which makes the whole interface bad… everything looks ugly" — on BOTH PC and mobile.
    This needs a complete rethink (PC is better but still wrong). DO NOT IMPLEMENT this
    round — after the release verifies, EXPLAIN the plan to the owner first.

### O. PC-side (Windows)
50. The update+restart worked and auto-restarted — but during the restart the screen
    shows NOTHING. Show a processing state ("I don't [want to] stay in the dark").
51. The link-device QR modal: click enlarges the QR; clicking the ENLARGED QR should
    shrink it back (currently does nothing); the X closes the whole modal.
52. "Type it in by hand" panel: the pairing PIN is CUT OFF and the section does not
    scroll.
53. **Manual pairing still fails**: pasting the PC's pairing text into the phone and
    confirming errors "Unreachable — could not reach the host on any of its addresses.
    Is the desktop on and linked?" while the QR path pairs fine. Diagnose the manual
    path's reachability probing vs the QR path's, and fix.

### P. Process mandates (his words)
- Update the Android design-language docs along the way.
- Sub-agents for planning AND for flaw-finding/review; run them in parallel.
- A highly detailed to-do list (~20–40 entries) BEFORE implementation.
- No rushing. Verify everything. Release v0.112.0 (Android + PC), verify the release,
  THEN explain the §N plan.

## §2 The wave plan (six parallel analyses → the implementation order)

Six planning tracks ran against the code (A universal sheet, B chrome/tab-bar/home/more,
C dashboard, D session chrome + delivery, E providers/projects, F PC-side + manual
pairing). The headline diagnoses:

- **A (sheet)**: the "opens directly, then plays the animation" = the first-frame
  Modal-mount race — `useAnimatedStyle`'s initial empty style paints the panel at REST
  before Reanimated attaches (fix: static initial pose in the style array, last-wins).
  The grip = the owner's "simple line" → deleted (a non-draggable sheet wears no
  handle). Header becomes TypeTitle + a 36px quiet circle close. Field captions banned
  in sheets; one-line SegmentedControl for N-way choices; centered self-sized CTAs
  (minWidth 200). 15 sheet call sites audited and mapped.
- **B (tab bar)**: the corner "sticker" = the square `boxShadow` wrapper View casting a
  rectangular halo around the rounded slab (fix: one rounded card-filled wrapper — the
  ClayCard pattern) + ChromeEdge's diagonal ramp (fix: vertical ramp, dark stop 0.16→
  0.22). The pill/truncation/edge complaints all reduce to the fixed `flex:1` slots +
  the `edge` clamp → one adaptive-slot algorithm dissolves them (selected slot grows to
  content, neighbors compress, `TAB_INSET_X 12`, `PILL_PAD_X 12`, +2px label epsilon).
  Mark-all-read NEVER LEFT THE PHONE: `activity.ts` owns the app's only two bodyless
  POSTs and the Kotlin transport rejects POSTs without bodyText — `bodyText: "{}"` is
  the whole fix. The More hero absorbs the live status; settings' connection row dies;
  host-store goes multi-host (list + activeId + per-host tokens + switchHost).
- **C (dashboard)**: horizontal carousels banned — one vertical scroll; period selector
  = a self-sized 3-segment control (14d/30d/3mo); headline = ONE card with a 2×2
  TYPE_STAT grid (4-across ≥768dp); chart gains thin centered bars + weekday ticks +
  "today" anchored; the Activity grid section dies (duplicate); models = donut + ranked
  list in one card (per-model carousel deleted); expanded sessions get the recessed
  `surfaceWell` + honest status badges (queued shows NOTHING — the resting state is not
  a badge) + right-aligned mono token/cost pairs + 2-line titles; disclosure motion
  split: expand `DISCLOSURE_SPRING {180,24}` (ζ 0.89 — a breath of settle), collapse =
  200ms timing (CANNOT overshoot by construction).
- **D (session)**: the top bar gets `surfaceHeader` (bg+6% ink / +30% black dark) +
  hairline separator + the live line overlaid; back = `ArrowLeft` (the owner's explicit
  ruling — the chevron was the "bracket") in a 40px quiet circle; the kebab menu
  transforms IN PLACE (sub-levels with back chevron + Check rows; apply → return to
  main); Stop = two-step armed label in-menu + a centered ConfirmDialog primitive for
  the composer button; the composer grows natively (min 44/max 176 — delete the
  controlled-height loop), focus ring 1.5dp, two-tier attach geometry (single-line:
  button beside; tall: full-width text + a 40dp reserved band under it), icon-only stop
  circle, queue button only when text is staged, keyboardDidHide → blur() (selection
  clears); delivery states ride the message body — sending = desaturated + 12% veil,
  sent/delivered = normal, NEW `processing` rung (promoted at the first content frame
  after the ack) = the accent edge breathing (550ms, 0.34↔0.62), failed = normal fill +
  danger edge + the existing Retry; the double-check tick ladder is RETIRED.
- **E (providers/projects)**: "Your providers" heading → SectionHeader large (20/700);
  configured names 15/700; strong Hairline section break; the Add-a-Provider button →
  the centered ChromeButton CTA (minWidth 200); the provider detail page becomes
  hero→keys→models (the name-hash color tile carries from the list; Test connection =
  the ChromeButton primary; keys get accentTint tiles + mono-12 mask·last-used lines +
  inset rules); model rows are NAME-only (the ID dies in list rows, lives on detail
  surfaces); New Project/New Session/"Use this folder" = the same centered CTA; the
  folder browser gains "Create a folder here" (first row + inline namer + auto-select,
  backed by a NEW `POST /system/fs/mkdir` server route — phone-reachable by the R114-b
  trust model); the manual path field gets a ClayInput + the sheet itself becomes
  keyboard-aware (panel rides the IME via RN-core Keyboard events inside the Modal;
  content padding absorbs the remainder — KeyboardAvoidingView stays banned per R115-K);
  the projects sessions well adopts track C's row anatomy.
- **F (PC)**: the QR modal = Radix's modal scroll-lock sets `body{pointer-events:none}`
  and the fullscreen overlay INHERITS it — clicks fall through to the dialog beneath
  (PROVEN in a live Chromium repro; fix = one `pointer-events-auto` class). The PIN
  cutoff = the manual panel wrapper's `overflow-hidden` zeroing its flex min-size so it
  absorbs the whole height deficit (fix = `shrink-0`). The manual pairing failure = the
  PC's pairing text carries `addrs[0]` ONLY — on the owner's Windows box that's a
  virtual adapter (WSL/Hyper-V 172.x) sorted first by the sidecar's first-octet sort —
  while the QR carries the full ladder; the phone's manual path probes one rung and
  dies with the owner's verbatim error at pair-flow.ts:294 (fix = 3 legs: the text
  carries all addresses, the phone parses + probes them all, and the sidecar puts the
  default-route NIC first via a dgram connected-socket probe + APIPA last). The update
  restart gap = a localStorage marker + a "Setting up v0.112.0…" relaunch splash
  variant. The PC test-model status = the testing band renders at the card + failures
  persist (the 5s auto-collapse dies for FAIL, PASS folds at 10s).

## §3 The wave order (implementation)

1. **Foundations** — tokens (chromeEdgeDark 0.22/0.08, surfaceHeader, sheet constants),
   motion (DISCLOSURE_*), primitives (ChromeEdge vertical + overflow, Hairline strong,
   QuietButton busy, QuietIconButton, SegmentedControl, LiveCaret, SectionHeader large,
   ChromeButton tone + accessibilityExpanded).
2. **The sheet system** — static initial pose, the header row, grip deletion, the
   keyboard layer (one commit, tracks A+E).
3. **Chrome** — the adaptive tab bar + corner fix, home (live caret, dividers, bottom
   inset, offline-only status strip), the More hero, settings' connection-row removal,
   mark-all-read fix.
4. **Session** — the top bar, the in-place menu, ConfirmDialog, the composer geometry,
   the delivery states, the `processing` rung.
5. **Dashboard** — the vertical stack, the session rows, the disclosure motion.
6. **Providers + projects** — the screens, the folder browser + mkdir route, the
   keyboard-aware sheet interlock.
7. **Multi-host** — host-store, connection.switchHost, the connect hub switcher.
8. **Appearance** — TAB_SPRING, the chat-pref rows, the footer removal.
9. **PC-side** — the three DevicesTab fixes, the restart marker, the PC test status,
   the sidecar's preferred-NIC ordering.
10. **Docs + tests** — every design-language amendment the specs drafted, every jest
    hook they specced.
11. **The release** — v0.112.0, all gates, tag, both workflows, publish, end-state
    verification.
12. **The §N explanation** — the center-section rethink plan, explained to the owner
    AFTER the release verifies.

## §3 Verification

- **The full gate ladder on the MERGED tree** (the five tracks were built in isolated git worktrees by
  parallel agents — B/C/D/E/F branches — then merged): mobile tsc clean · jest **38 suites / 811 tests**
  (baseline 28/616) · agent-core tsc clean · vitest **145 files / 2734** (was 144/2710) · root vitest
  **252 files / 4491** (was 4457) · root eslint 0 · docs:check 264/0 (the servo.org HEAD flake is
  sandbox egress, not content).
- **The independent review pass** (a dedicated reviewer agent walked the owner's §1 report item-by-item
  against the CODE, not the reports): **zero blockers** — every in-scope item verified real (the adaptive
  slots, the in-place kebab transformation, BOTH stop confirmations, the auto-grow, the deleted tick
  ladder, the folder flow, the three pairing legs, the pointer-events fix); the frozen files
  (tokens/motion/primitives/sheet) byte-clean; the do-not-touch lists intact; the four deep-checked
  test suites judged REAL pins. Both WARNs it raised were closed in `59f7514` (the sheet-anatomy
  drift-guards; the unified timeAgo law — "just now" under a minute, minutes start at 1, "0m ago" dead).
- **Cannot be verified in this sandbox** (the release checklist for the owner's device): the tab-bar
  corners at 200% zoom + the 360dp pill poses + reduced motion; the dashboard squint test + the ≥768dp
  reflow; the session chrome at rest + the sending→processing sequence; **the sheet keyboard gate** (the
  namer/manual-path/CTA above the IME — watch for double-compensation if the Modal's dialog window also
  pans with the IME); the real Windows multi-adapter LAN pairing (the 172.x→192.168.x climb); the NSIS
  relaunch marker surviving the WebView2 restart; the real dgram default-route probe.

## §4 The §N deferral (the center-section rethink — NOT implemented, per the owner's sequencing)

The transcript-center card rethink (thinking / tool calls / failed calls as separate cards, on BOTH
platforms) was explicitly excluded from this round: the owner directed that everything else ship as
v0.112.0 first, and that the center-section plan be EXPLAINED to him after the release verifies. §6 of
this document (the release record) is followed by that explanation, delivered in the round's closing
report.

## §6 The v0.112.0 release (R118-i — shipped and end-state verified)

Tag `v0.112.0` at `49a4068` (the release-prep commit). All four workflows green: the tag `Release`
run `35756063878` (launcher-kit + the Windows installer + the two AppImages + the two debs), the tag
`Mobile APK` run `35756063880` (the APK attach), the main `CI` run `35756059694`, and the main
`Mobile APK` run `35756059877`. The §g 2c lock-sync proof passed before tagging (`npm ci --dry-run`
clean — no mobile deps changed this round).

Draft `393949568` carried all 7 assets, then was PUBLISHED (PATCH `draft:false`, `make_latest:"true"`,
body = the CHANGELOG's 0.112.0 section, no `target_commitish` — the §g 6 procedure). End-state
verified per §g 6b:

- `/releases/latest` answers `v0.112.0` authenticated; the PUBLIC check answers the same via the HTML
  redirect (`/releases/latest` → `/releases/tag/v0.112.0` — the unauthenticated API was rate-limited
  from the sandbox IP at check time).
- 7/7 assets on the published page: the six desktop ones (AppImages 134,330,888 / 136,604,152 B,
  debs 68,422,238 / 68,378,704 B, x64-setup.exe 39,356,724 B, launcher-kit 145,710 B) plus
  `ACUTE-CODE_0.112.0_android-arm64.apk` 56,789,693 B.
- **APK content check** (downloaded via the API, full zip central-directory pass): 1240 entries;
  `assets/index.android.bundle` present with the Hermes bytecode magic `c6 1f bc 03`; 3 dex files;
  `lib/` contains **arm64-v8a only**; exact size match.

No stale drafts remain. The round is shipped — followed by the §N center-section explanation the
owner directed (delivered in the round's closing report; its implementation awaits his verdict).
