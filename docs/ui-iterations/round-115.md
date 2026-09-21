<!-- last-reviewed: 2026-09-20 round-115 -->
# Round 115 — the design language round (the owner's full-app walkthrough, answered)

The owner's verdict on v0.108.0: both apps work — sync holds, the relay holds,
pairing works end-to-end. What he graded this round was the CRAFT: the first-run
screens carried essays and step-numbers, the scanner had a torch and zoom buttons,
manual entry was "the worst screen I have ever seen," the projects accordion
expanded nothing (the arrow rotated, the list never opened), the keyboard still
covered the composer, the chat screen was "way too cramped" with its five-pill
control row, the home screen showed theme pickers and quick-action grids, the
bottom sheets ghosted the page behind them during their opening animation, the
PC's QR sat tiny in its dialog, and every screen was one redesign away from the
product he has in his head.

He also asked for the thing that outlives the round: **a proper Android design
language, written in a modular way** — multiple folders and files, proper
Markdown, so agents can follow it. That became the round's §0 and its
constitution.

This file records the round that answered every item. Seven commits:
f91bd41 (the design language + the systemic sheet-animation fix + the QR-photo
deps), 03708e2 (the wizard's minimal screens + the pairing round end-to-end),
6ab66eb (the connect flow + the honest home), 06fcf48 (the More hub + the
projects rebirth + the keyboard dock), 051c2e9 (the chat's WhatsApp anatomy +
approvals + the dashboard's donut + settings polish), 99f06a3 (the transcript's
render layer), d31c10c (the final review).

## §0 The design language (R115-a — the constitution)

`docs/design-language/android/` — eleven files in three tiers:

- **`README.md`** — the map, the three laws (minimal by default; animate the
  moment, not the surface; the phone is a companion, not a control panel), and
  the round-115 product decisions pinned so no later round re-litigates them
  (the "companion" tagline, word-pair desktop names, attachments/uploads,
  downloads, the More hub, the pulsing approvals tab).
- **`01-foundations/`** — `tokens.md` (the color pipeline, the clay material,
  the chrome rationing — wizard CTAs went FLAT this round), `motion.md` (the
  one spring, the entrance/state grammar, the six mandated animated moments),
  `typography.md` (the ladder + the copy-length law: descriptions are one line
  or deleted).
- **`02-patterns/`** — `screen-archetypes.md` (every screen is ONE of four
  shapes), `components.md` (buttons, cards, letter avatars, sheets, the folder
  browser, the tab bar), `onboarding.md` (the wizard DNA), `chat.md` (the
  WhatsApp-inspired anatomy).
- **`03-rules/`** — `copy.md` (the voice, the banned words — "remote" and
  "Auto" both retired), `donts.md` (the thirty-entry slop signature), and
  `checklist.md` (the pre-merge review, run by the R115-P final audit).

## §1 The owner's report, itemized

| The ask (R115) | The answer | Where |
|---|---|---|
| **Welcome: "remote" is the wrong word; card descriptions must be one-liners; delete the bottom kicker; no glow on Get Started; animate the hero** | The tagline is "The companion for your desktop agent."; the three cards keep titles with one-line descriptions ("Every project and session, live from your pocket." etc.); the "YOUR DESKTOP DOES ALL THE WORK" kicker is deleted (the gap is intentional breathing room); the CTA is FLAT accent clay (`ChromeButton flat` — the sheen is rationed to in-app primaries only); the logo tile enters on a scale spring + floats ±4px on a 2.4s idle (the one sanctioned continuous animation) | `mobile/app/onboarding/welcome.tsx`, `mobile/src/design/primitives.tsx` |
| **Camera screen: remove the 1-2-3 steps and every extra option; only the camera ask; icon+text slightly above middle; button below; animate the grant; hide Skip when granted** | Minimal-center archetype: camera tile + "Camera access" + one caption + one button, flex-spaced to sit above/below the middle line. Granted = the tile springs to success green, Camera crossfades to Check (200ms), Skip slides out (width+opacity spring), THEN Continue enters; successHaptic. Denied = the caption swaps to one warning line, nothing else appears | `mobile/app/onboarding/permissions.tsx` |
| **Link your desktop: no paragraphs, no TLS card, two options, footer "Scan" + "Do it later", no third button** | Exactly that: two `PairOptionCard`s (the shared pattern, `pair-options.tsx`) + the footer pair; the trust card and the duplicated long CTA deleted | `mobile/app/onboarding/connect.tsx`, `mobile/src/components/pair-options.tsx` |
| **Manual entry was "the worst screen ever" — too cluttered, no paste, no proper back** | Rebuilt as a Detail-archetype form: one-line hero, a prominent **Paste pairing text** row that parses the desktop's copied `addr:port · PIN` format (the smart-paste contract — the PC side grew the Copy buttons this same round), one-clause shape hints, the PIN grouped 4+4 as typed, the certificate fingerprint collapsed behind a disclosure, Continue disabled-until-valid with busy + return-key submit | `mobile/app/connect/manual.tsx`, `mobile/src/link/pairing.ts` (`parsePairingText` + tests) |
| **Scanner: square view, heading, proper back, gestures-only zoom, NO flash, upload a QR photo instead** | Square 1:1 viewfinder (radius 20, centered), the corner brackets pulse and the scan line ACTUALLY travels (the old one only pulsed — dead `scanY` shared value), "Scan QR code" chevron header, pinch-only zoom (the +/− buttons and the fake multiplier deleted), the torch deleted outright, and **"Choose a photo instead"**: document-picker → image-manipulator downscale to ≤1200px → magic-byte sniff (PNG→upng-js, JPEG→jpeg-js) → jsQR (`attemptBoth`) → the exact locked parse path as live scan, with honest per-case failure lines | `mobile/app/connect/scan.tsx`, `mobile/src/features/qr-from-image.ts` (+ tests) |
| **Connect screen: no back/notification buttons; "Connect to PC" + SVG icon + infinite animation; the two options** | The unpaired hub is minimal-center: "Connect to PC" + an SVG moment (two clay chips — desktop and phone — joined by a dashed link line whose dash-offset travels a calm 1.6s loop, reduced-motion renders the resting line) + the two options; no chrome at all | `mobile/app/connect/index.tsx` |
| **Confirm the host: highlight the address/PIN/countdown separately; expiry → a "rescan" state, not a dead button; no 120s footnote; a full-screen pairing animation** | ADDRESS (own mono tier) / PAIRING PIN (26px grouped mono) / Valid-for chip (own row, warning tint under 30s with a calm per-tick spring) / certificate behind a one-line disclosure. Countdown 0 → the actions area is REPLACED by "The window closed — rescan the QR code" + "Scan again". The footnote is deleted. Pairing = a full-screen moment: content crossfades out, the desktop and phone chips spring together and merge, the desktop's word-pair name types in (~1.4s, successHaptic), then home. Failure springs back out to the honest FailureCard | `mobile/app/connect/confirm.tsx` |
| **The PC's QR is too small; click it → fullscreen; the desktop needs a copy-pairing-text option** | The tile grows to `min(60vh, 420px)`; clicking opens a fullscreen overlay (QR at `min(90vh, 90vw)`, Esc/backdrop/X close); "Copy pairing text" copies `addr:port · PIN` (testid `pair-copy-text`) with per-block copies in the manual fallback | `src/components/settings/DevicesTab.tsx` |
| **Random desktop names → clean word-pair names ("confused coconut"), shown on the phone AND the PC** | `machine-label.ts` mints adjective+noun pairs ONCE, persisted at `<dataDir>/machine-label.json` (the VAPID/cert pattern — stable across restarts); it rides `pair/start` + `link-info` (additive `machineLabel`), the claim's `machine.name` (the phone's hostLabel), and the relay hello label; the PC's pairing dialog shows "This desktop is …" | `agent-core/src/lib/machine-label.ts`, `agent-core/src/routes/mobile.ts`, `agent-core/src/lib/cloud-connector.ts`, `src/components/settings/DevicesTab.tsx` |
| **The PC should follow the phone's created session** | Device-token session creations publish the created frame with additive `source:"device"`; the PC auto-navigates to `/project/:id/chat?session=:sid` via the session-nav inbox (the Toaster mechanism) — GUARDED: busy (any active stream) → a "New session from your phone" toast with an Open body instead | `agent-core/src/routes/sessions.ts`, `agent-core/src/lib/events-bus.ts`, `src/lib/events-stream.ts`, `src/lib/session-nav-store.ts`, `src/components/shell/EventStreamStarter.tsx` |
| **Home: no theme picker, no quick-action grid, no approvals/projects cards; the desktop status simplified; show what matters** | The honest home: a compact live-status row ("Live · {word-pair name}", offline appends "· messages will queue"), the unread activity strip, **"Happening now"** (running sessions with project letter avatars + live badges, live via the events epochs), and recent activity. The hero card, quick-actions grid, and appearance section deleted | `mobile/app/(tabs)/home.tsx` |
| **Projects: New Project at the BOTTOM, half width, no description/arrow; letter-in-colored-circle icons (not dots); smart path (last segments, drop the name-matching one, shed the first on overflow); no per-row +; the accordion DOESN'T EXPAND (the core bug); no footer hint** | THE YOGA DEADLOCK, fixed: the clip View rested at height 0 + overflow hidden, and Yoga clamps a relative auto-height measurement child to 0 — onLayout reported 0 forever, so the spring target stayed 0 (the chevron rotated on its own transform, which is why the arrow moved and nothing opened). The fix: the measurement child is ABSOLUTE (top/left/right) inside the clip (natural height at any clip height), the static `height: 0` is deleted (it also raced the animated value), and the measured height lives in a shared value the spring reads fresh. Plus: letter avatars (`letter-avatar.tsx`, shared), `shortRootPath` (the smart truncation, 9-case table-driven tests), count badges, the half-width bottom New Project row, the footer deleted | `mobile/app/(tabs)/projects.tsx`, `mobile/src/components/letter-avatar.tsx`, `mobile/src/features/fs-browse.ts` |
| **New Project sheet: no name, no color — only the folder; the browser can't climb past the user's home; "Use this folder" shows the selection and flips to "Select another folder"** | The sheet asks ONE question: the folder browser (breadcrumbs + dirs list), the name DERIVED from the folder's basename, color omitted (server auto). The server caps `parent` at the user's home directory (the Up affordance disappears there naturally); the manual path escape hatch stays for power users. Selected state = the full path as a mono chip + the flipped button + a separate "Create the project" | `mobile/app/(tabs)/projects.tsx`, `agent-core/src/routes/system.ts` |
| **The sheets ghost the page during their opening animation (background visible below)** | The panel was 40% translucent rising only 96px — you saw the page THROUGH the sheet. Now the panel enters fully OPAQUE, sliding its entire max height from below the fold, the scrim on its own faster 160ms timing; the R114 pixel-clamp and Modal-host guarantees untouched | `mobile/src/components/sheet.tsx` |
| **Chat, WhatsApp-inspired: back + project DP + project/session names at top; the options move to a top-right menu; the composer keeps only the upload + input** | The identity bar: chevron + project letter avatar + project name over session name + kebab. The kebab opens the Session-options sheet (Operating mode / Model / Thinking / Context — each with its live value + Stop while a turn runs) routing to the existing sheets. The composer's five-pill control row is DELETED — the visible row is attach + input + send/stop inside the dock. The header's status words moved out; a 2px accent line breathes under the bar while a turn runs | `mobile/app/session/[id].tsx`, `mobile/src/components/composer.tsx` |
| **Full Access showed a "task mode" too — only the operating mode; the model picker should be providers → expand → models** | The task-mode section is deleted from mobile (the desktop keeps it); the mode sheet is three big rows with one-line descriptions. The model sheet groups by provider: provider section rows expand inline through the same proven accordion (auto-opening the in-play model's provider), "Agent default" on top | `mobile/src/components/composer.tsx` |
| **The transcript: time in the wrong place, images/thinking/details not shown properly, ugly formatting; better processing** | The render layer rebuilt (data model untouched): user bubbles right-aligned with INLINE bottom-right timestamps + a tighter bottom-right corner (the WhatsApp tail hint) + accent-tinted clay; the assistant meta line (model · time) ABOVE the content; the skill read as ONE quiet chip; images as proper rounded thumbnails with skeleton loads; the ThinkingPlaceholder breathes (0.85↔1) inside a fade-in-up entrance; every card tightened to one visual idea per region | `mobile/src/components/transcript.tsx`, `markdown-text.tsx`, `image-viewer.tsx` |
| **The keyboard STILL covers the input** | Three mechanisms were fighting (the hook's implicit adjustResize + the library KAV's parent-relative padding + the hand-rolled inset fade) — version roulette. Now ONE deterministic dock: the KAV is deleted, the window is pinned `ADJUST_NOTHING` for the screen's lifetime, and the composer's padding is a single UI-thread expression `max(inset, keyboardHeight)` fed by two idempotent paths (the worklet handler + the JS event twin — whichever fires, the values agree) | `mobile/app/session/[id].tsx`, `mobile/src/components/composer.tsx` |
| **Approvals: a centered "nothing to approve" state; the tab should pulse when something waits; the cards need better layout** | The empty state is the centered cluster (ShieldCheck chip + "Nothing needs your approval" + one caption). The approvals TAB breathes accent (icon + label, 0.75↔1 opacity ~1.6s) while pending > 0 — the badge alone was judged not enough. The card: category badge + expiry chip right-aligned, the headline in body-strong (mono retired), three-line detail, risk line, 50px Approve/Deny with the optimistic settle springs kept | `mobile/app/(tabs)/approvals.tsx`, `mobile/src/components/approval-card.tsx`, `mobile/src/components/tab-bar.tsx`, `mobile/app/(tabs)/_layout.tsx` |
| **Dashboard: combine with usage; the model donut; the activity table; better graphs** | The model leaderboard folded into a DONUT + legend (the PC's ModelDonut math ported to react-native-svg; arcs sweep in over 500ms; legend rows highlight their segment, 44px targets); a new Activity section (requests / turn errors / tool failures / peak day with proportional sparkbars — field-proven, nothing fabricated); the daily bars now GROW from baseline (350ms, 12ms stagger, once per load) | `mobile/app/(tabs)/dashboard.tsx`, `mobile/src/components/chart-donut.tsx` |
| **Settings: appearance selectors ugly, the preview useless, add-provider should be ONE option, model editing not proper, and a "More" hub instead of the settings tab** | Appearance: a 2-column theme-card grid, a spring-sliding segmented mode control, chip-row chat prefs, the preview card DELETED. Providers: one "+ Add a provider" reveal (the preset wall collapsed behind it); the model actions sheet reordered Test → Edit/Hide → Delete-last-danger with icons; the edit sheet spaced with a quiet Cancel. Tab 5 is now **More** (connection, activity, about + the Settings entry) with the settings hub pushed behind it | `mobile/app/settings/appearance.tsx`, `mobile/app/settings/providers/*`, `mobile/app/(tabs)/more.tsx`, `mobile/app/settings/index.tsx`, `mobile/src/components/tab-bar.tsx` |
| **Dedicated uploads + downloads folders** | Uploads = `<root>/attachments/` (the existing server truth — documented as THE uploads folder in the constitution). Downloads = `<root>/downloads/`: the convention is pinned at the browser-proxy's binary passthrough (the only future download origin — the current browser streams in memory, honestly reported) and fs-ops' recursive mkdir creates it on demand | `agent-core/src/browser-proxy.ts`, `agent-core/src/tools/fs-ops.ts`, `docs/design-language/android/README.md` |
| **A modular design language, in proper Markdown, for agents to follow** | §0 — eleven files, three tiers, machine-checkable rules in `checklist.md`; the R115-P audit ran all thirty donts against the final tree | `docs/design-language/android/**` |

## §2 The two systemic bugs (worth remembering)

### The Yoga measurement deadlock (the accordion that never opened)

A clip container at `height: 0, overflow: "hidden"` with a RELATIVE auto-height
child measures that child as ZERO on Android's Yoga — `onLayout` fires with 0,
the spring animates 0→0, and no later data arrival re-measures (the parent is
still 0). The chevron rotated because it was an independent transform. The fix
pattern — now triplicated across projects, the disclosure, and the model sheet:

```
clip (overflow: hidden, NO static height) → measurement child (absolute,
top/left/right, collapsable={false}) → shared value → spring
```

Absolute children measure at natural height regardless of the clip's height —
the measurement is always real, and the open panel re-springs on re-measure.

### The keyboard triple-mechanism (why R114's fix still failed)

`useReanimatedKeyboardAnimation` silently pins `adjustResize` (a no-op on API
35 edge-to-edge, live on ≤34) while the library `KeyboardAvoidingView` computes
padding from parent-relative frame math that under-reports on inset devices —
and the hand-rolled inset only faded the safe area. Three partial owners of one
lift = version roulette. The dock owns it alone now: `ADJUST_NOTHING` + one
expression + two idempotent feeds.

## §3 The verification matrix (all at d31c10c, re-run fresh)

- ROOT `tsc -p tsconfig.json --noEmit` clean · root `vitest` 244 files
  **4337 passed / 15 pre-existing skips** · `eslint .` clean ·
  `design:audit` clean (101 files, all rules at or below baseline).
- agent-core standalone: **2618/2618** (137 files — +10 over the R114 close:
  the machine-label wire suite incl. a real-TLS claim and the frame
  round-trip).
- Mobile: `tsc` clean · **24 suites / 500 tests** (+69 over the R114 close:
  parsePairingText 26, qr-from-image 4, shortRootPath 10, chart-donut 22,
  composer/approval-card pins, the honest re-pins).
- The R115-P design audit: 20 patterns checked against the android design
  language — the copy vocabulary aligned, the orphaned theme-picker deleted,
  dead helpers tombstoned, stale comments corrected.

### The release (v0.109.0 — first tag failed, re-issued by R115-r)

The first `v0.109.0` tag (c99e07b) was pushed with the round declared
shipped, but the **Mobile APK run 35535853130 died in ~10 seconds at
`npm ci`**: R115-a's lockfile regeneration had dropped 13 React Native
toolchain entries (`@react-native/babel-preset`, `jest-preset`, the
`metro-*` family, `expo-linking`, the babel peer plugins) and flipped 75
`devOptional`→`dev` flags — while every local gate stayed green, because
the sandbox's pre-installed `node_modules` masked the out-of-sync lock
(the runner installs from the lockfile only). The draft release sat
unpublished with 6 assets and no APK; `/releases/latest` still answered
v0.108.0. The release was not done.

**R115-r (442b29c) repaired and re-issued it**: the lockfile restored
from the proven v0.108.0 base (1368395) with the four QR-photo deps
re-added — a six-entry additive diff (`expo-image-manipulator` +
`jpeg-js` + `jsqr` + `upng-js` and their `expo-image-loader`/`pako`
transitives), proven by `npm ci --dry-run` in a clean room, a real
clean-room `npm ci`, `tsc` clean, **24 suites / 500 tests** green, and
the 7-file version gate. The stale draft (392567240) was deleted, the
tag deleted on remote AND locally (a lingering local tag silently
re-pushes the old commit), and `v0.109.0` re-created at 442b29c.

**The end state, verified:** main runs green (CI 35550797554, Mobile APK
35550797480 — `npm ci` + jest + prebuild + gradle all green on the fixed
lock) · tag runs green (Release 35551965986, Mobile APK 35551966018) ·
fresh draft 392648426 carried **7/7 assets** · PUBLISHED
(`draft:false`, `make_latest:"true"`, body = the 0.109.0 CHANGELOG
section) · `/releases/latest` → **v0.109.0** · the APK content-checked
over HTTP: zip central directory **1240 files**,
`assets/index.android.bundle` (Hermes) PRESENT, **3 dex**,
`lib/arm64-v8a/` ONLY. The shipping runbook gained the standing guards
(MAINTENANCE.md §g: the pre-tag mobile lock-sync proof 2c, the
both-workflows/7-assets watch 4–5, the publish + end-state verification
6/6b) so the class of failure cannot recur silently.

### Deferred with reasons (the standing queue)

- The accordion + keyboard + sheet fixes need one DEVICE pass (the Yoga and
  worklet analyses are conclusive; a device is cheap insurance) — the
  photo-QR decode especially (jsQR on real photos).
- User-sent images still render as framed thumbnails without pixels (the wire
  carries no attachment bytes to the phone — the `attachmentImageUri` hook is
  the zero-change seam when the model grows).
- The browser's actual "save download" affordance (the convention + mkdir are
  pinned at the passthrough; no download path exists to wire yet).
- The PC transcript's own polish pass (the owner's round-115 PC asks were
  pairing-scoped; the transcript verdicts were mobile-side).
