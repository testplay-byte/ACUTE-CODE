<!-- last-reviewed: 2026-09-19 round-109 -->
<!-- round: 109 -->
# Round 109 — the companion, rebuilt in clay (the Android app's UI round + the live link)

The owner's verdict on v0.104.0 (pairing verified working, UI rejected outright):
"The UI of the application was trash… the whole complete layout, the UI, and
everything about the application were bad." No adaptive layout management. A
design language demanded by name — **Clay Studio (the 3D vibe) + liquid
chrome**, borders with depth but "don't go with too many shiny borders" — and
a list of concrete defects: the bottom bar, the ugly top, no setup wizard, a
scanner that opened straight off a permission button, no camera zoom, silent
disconnects, unrendered markdown, a keyboard that buried the input field, and
a phone that could not configure anything. This file records the round that
answered all of it, plus the artifact ruling (**ARM64-only, no universal
APK**) and the three owner guides that ship with the release
(docs/guides/).

The design contract lives at `mobile/DESIGN.md`; the round's commits are
657c9d4 (the system + shell + flows), 28e8185 (the formatted transcript +
the feature/settings screens + the reliability fix), d3bf252 (the desktop
blocklist + ARM64-only + the version gate), 300127b (the guides + the CI
hotfix), 97d5da4 (the dead placeholder removed).

## §0 The owner's report, itemized

| The ask (R109) | The answer | Where |
|---|---|---|
| "The UI was trash… whole complete layout" — no adaptive layout | Every screen rebuilt on a new design system with a real type ladder, spacing scale, radii, and edge-to-edge insets; large-title headers vs compact pushed headers; every list/scroll surface keyboard- and inset-aware | `mobile/src/design/*`, `mobile/src/components/screen-scaffold.tsx` |
| Clay Studio + liquid chrome; depth, not shine | Clay = two-leg warm shadows + a matte top-edge highlight (form, not painted glow — the R108-e verdict carried to Android); chrome rationed to EXACTLY three surfaces: the floating bar's edge, the primary CTA's sheen, selected markers | `mobile/DESIGN.md` §, `tokens.ts` (clayShadow1/2, chrome stops) |
| Text, fonts, proper boldness, colors | Manrope 400–800 + JetBrains Mono bundled and gated before first paint; a fixed type ladder (display 28 / title 20 / heading 16 / body 15 / caption 12.5 / micro 11) with ink/tertiary/quaternary color roles | `theme.tsx` (useFonts gate), `primitives.tsx` (Type ladder) |
| Floating bottom nav, spacing on all four sides, rounded | A floating clay slab: margins on all 4 sides, radius 28, the ChromeEdge hairline, elevation shadow, a sliding spring indicator, a live approvals badge — and it slides away under the keyboard | `mobile/src/components/floating-tab-bar.tsx` |
| The ugly top | Large-title headers: the ALWAYS-VISIBLE connection pill (tap → connect hub), the activity bell with unread dot, display title + subtitle; compact headers on pushed pages | `screen-scaffold.tsx` |
| First startup → setup wizard → permissions → home | Welcome (brand moment) → camera permission with rationale + honest denied fallback → connect step → home; re-runnable from Settings → About | `mobile/app/onboarding/*` |
| "Grant Camera Access to Scan" was the wrong flow | The Connect hub: "Add a connection" → scan OR a full manual-entry page (address/tunnel + PIN + optional fingerprint, live tunnel/LAN detection, clipboard paste) → the confirm step with the host's identity card | `mobile/app/connect/*` |
| Camera zoom in/out | Pinch-to-zoom on the animated camera + zoom step buttons + torch toggle + animated framing brackets | `mobile/app/connect/scan.tsx` |
| Silent disconnects; "host offline" while the host was online; rescan-to-recover | The status pill on every screen; AND the root fix — the Kotlin `classifyNetworkError` no longer maps every `SSLException` to the fatal `tls` verdict (only real `CertificateException` pin mismatches do), so the probe ladder CONTINUES past a flaky handshake on one address | `mobile/android/.../AcuteNetModule.kt`, `link/runtime.ts` |
| Live, instantaneous two-way updates | The notifications SSE stream held open while connected: approvals/task/failure events land the moment they happen (bell + badge + live rows); the transcript streams with a live caret | `mobile/src/features/activity.ts`, `transcript.tsx` |
| Full disconnect + rescan, one gesture away | The connect hub + Settings → Connection's danger zone (unpair, honest about the desktop keeping its row) | `app/connect/hub.tsx`, `app/settings/host.tsx` |
| Configure models/providers/settings/agents/prompts from the phone | The full settings surface: providers (edit, write-only key set, model edits, test connection), agents, prompts (override/revert), the six preference domains, appearance; the usage DASHBOARD (chart + leaderboard + health), projects with session creation | `mobile/app/settings/*`, `app/(tabs)/dashboard.tsx`, `app/projects.tsx` |
| Bold not rendered, tool calls invisible, thinking not live, streaming not real-time | The pure markdown parser + renderer (bold/code/lists/tables/links/headings), working settled AND while streaming; expandable clay tool cards; thinking blocks in the live view; the pulsing caret marks the live end | `mobile/src/components/markdown-text.tsx`, `transcript.tsx` |
| The keyboard covers the input field | react-native-keyboard-controller across every form, the composer, and the session screen (KeyboardAwareScrollView + KeyboardProvider + adjustResize semantics) | `screen-scaffold.tsx`, `app/session/[id].tsx` |
| Proper console logging | The `[ACUTE-MOB]` logcat tag across link/stream/pair/outbox/activity/config, with the Android Studio filter recipes | `mobile/src/features/log.ts`, `mobile/README.md` |
| ARM64-only, no universal APK | `universalApk false` + the workflow's refuse-a-universal gate; ONE deliverable: `app-arm64-v8a-release.apk` | `mobile/plugins/with-android-release-signing.js`, `.github/workflows/mobile.yml` |
| The Cloudflare + Firebase guides | Three owner-followable guides ship in this release: CLOUDFLARE-SETUP (Modes A+B), FIREBASE-SETUP (FCM v1), MULTI-PROGRAM-ARCHITECTURE (ten desktops, one account) | `docs/guides/` |

## §1 The design system v2 (the contract)

`mobile/DESIGN.md` is the normative contract; the implementation:

- **Tokens** (`tokens.ts`): the Clay Studio theme added FIRST and made
  `DEFAULT_THEME_ID` (the desktop §1b palette verbatim); `clayShadow1/2/Sm/`
  + `clayPressed` + `clayTopEdge` + `surfaceRaised` + mono surfaces + the
  chrome/sheen gradient stops on `ResolvedTheme`; radii (card 20 / tile 24 /
  bar 28 / input 14); spacing xl=20 / xxl=24; the old `fontStack` kept as a
  compat alias for un-migrated components.
- **Theme** (`theme.tsx`): the `useFonts` gate (Manrope 400–800 + JetBrains
  Mono 400/500) blocks first paint — no system-font flash.
- **Primitives** (`primitives.tsx`): `ClayCard`, `PressableCard`, `ChromeButton`
  (accent + quiet sheen + busy), `QuietButton`, `ChromeEdge`, `ClayInput`
  (label/caption/focus ring), `Chip`, `StatusDot` (pulse), `ConnectionPill`,
  `Skeleton`, `SectionHeader`, `Badge`, and the full `Type*` ladder.
- **The R108-e forbiddances carried to Android**: no glow-fades, no
  gradient-glint hairlines on working surfaces, chrome as rationed jewelry —
  the desktop's hard-won verdict applied before the phone could repeat it.

## §2 The shell — the floating bar, the headers, the wizard, the connect flow

- **The floating tab bar**: the clay slab with 4-side margins, radius 28, the
  ChromeEdge, the sliding spring indicator, per-tab badges (approvals), and
  it slides away under the keyboard (`useKeyboardState`).
- **Headers**: large-title mode (connection pill + bell + unread dot +
  display title + subtitle) for tab roots; compact mode for pushed pages.
  The connection pill is ALWAYS on screen — connected · connecting ·
  offline — tap it to reach the connect hub.
- **The setup wizard** (`app/onboarding/*`): welcome → permissions (camera
  rationale, honestly skippable — manual pairing never needs it) → connect;
  the gate reads the onboarding flag; replayable from Settings → About.
- **The connect flow** (`app/connect/*`): the hub ("Add a connection" +
  host management + scan-a-new-code), the scanner (pinch zoom via
  `useAnimatedProps` on the animated camera + zoom steps + torch + animated
  brackets + honest "not an ACUTE code" feedback), manual entry (full form
  + live tunnel/LAN detection + clipboard paste + optional fingerprint),
  and the confirm step (the identity card + the `pairWithHost` ladder +
  typed failure copy).

## §3 The formatted transcript

- **The markdown parser + renderer** (`markdown-text.tsx`, 260 lines + 178
  lines of parser tests): bold is bold, code blocks are mono tiles,
  headings, lists, quotes, tables, links — a pure parser (no
  react-native-markdown dependency) so the tests pin the grammar.
- **Transcript v2** (`transcript.tsx`): the clay language throughout, the
  live pulsing caret at the streaming end, expandable tool cards (collapsed
  headline → the full story), thinking blocks rendered in the live view.
- **Composer v2** (`composer.tsx`): the chrome send CTA (busy while
  sending), the outbox row with per-message dismiss.
- **Session v2** (`app/session/[id].tsx`): the real Android keyboard
  handling (react-native-keyboard-controller; the "field disappears under
  the keyboard" bug is dead), stream logging.

## §4 The live link + the reliability fix

- **The activity module** (`features/activity.ts`): the pure store +
  controller riding `GET /notifications/stream` SSE (hello + notification
  frames), the R42 foreground discipline, reconnect page refresh,
  mark-read/mark-all; `useUnread`/`useActivityFeed` hooks; started in the
  root layout.
- **The reliability fix**: `AcuteNetModule.kt` — `SSLException` reclassified
  (only `CertificateException` verdicts are the fatal pin-mismatch `tls`
  state), and the TLS ladder CONTINUES past a per-address mismatch — the
  "host offline until rescan" trap is dead at the Kotlin root, not patched
  over in JS.
- **The always-visible truth**: the status pill on every screen; offline
  states are immediate, honest, and actionable (retry now).

## §5 The phone configures the desktop — and the desktop-side wall

- The settings hub + stack: Connection (identity card, diagnostics,
  danger zone), Appearance (six themes, Clay Studio default, the preview
  card), Preferences (the six domains — orchestration/retry/memory/debug/
  thinking-loop/desktop-notifications — every change saves immediately,
  reverts honestly on failure), Providers (edit + write-only key set +
  model edits + test connection), Agents (editor with the changed-subset
  save), Prompts (override/revert with the live empty-trims warning).
- The usage DASHBOARD tab: windowed totals (14d/30d/3mo), the hand-built
  SVG bar chart with molded clay caps, the model leaderboard, health.
- Projects: the browser with per-project session creation and deep-links
  into the sessions filter.
- **The desktop-side blocklist** (`agent-core/src/server.ts` + 8 new tests):
  a paired device token can reach the management surface but can NEVER
  reveal raw provider keys, reset the app, drive terminals, or control the
  computer — those routes answer 403 to a device token no matter what.

## §6 The artifact — ARM64-only

The owner's ruling ("you do not need to build the Android universal APK at
all… just the ARM64 v8 version"): `universalApk false` in the signing
plugin, plus a workflow gate that FAILS if a universal APK appears. One
deliverable: `ACUTE-CODE_0.105.0_android-arm64.apk`. The stable repo signing
key carries forward — updates install IN PLACE over v0.104.0.

## §7 The owner guides (the next rounds' runway)

`docs/guides/` (all stamped round-109, indexed by docs:check):

- **CLOUDFLARE-SETUP.md** — Mode A (the quick tunnel, try it today, no
  account) and Mode B (the named tunnel, the permanent setup), step by
  step, with what to hand back to the orchestrator next session.
- **FIREBASE-SETUP.md** — the FCM v1 push path: project → app registration
  (`com.acutecode.companion` EXACTLY) → the service account → where it
  goes. The push model stays PING-ONLY by the owner's ruling.
- **MULTI-PROGRAM-ARCHITECTURE.md** — ten desktops / one Cloudflare account
  / ten links in one pocket: the multi-host registry design, the
  right-sidebar web-publishing reuse, the four-round sequence.

## §8 Verification

- Mobile suite: **164/164** (10 suites; the markdown parser + the activity
  day-grouping pinned) — re-run locally at the release commit.
- Root suite (all workspaces incl. agent-core): **4095 passed / 15 skipped /
  0 failed** — re-run locally at the release commit; CI's `pnpm verify`
  (lint + typecheck + tests + design audit + build + e2e + license audit)
  green on the tagged commit, plus the launcher unit tests and both Rust
  compile gates (linux x64 + arm64).
- Agent-core: 2,472/2,472 (the 8 new device-blocklist tests included in the
  root count).
- The Mobile APK workflow: the RELEASE variant with the embedded-bundle hard
  gate (the R108 lesson), arm64-only, green on the tagged commit.
- The release was verified asset-by-asset after publication (sizes, the
  ARM64-only APK, the embedded Hermes bundle via ranged-HTTP zip reads).

## §9 The owner's TEST CHECKLIST (v0.105.0)

1. **Install over v0.104.0** — `ACUTE-CODE_0.105.0_android-arm64.apk` from
   the Release. Same signing key: it updates in place, nothing to
   uninstall. First startup runs the wizard.
2. **Pair by QR** — pinch to zoom in the scanner, torch if the room is
   dark; or try the manual-entry page (Settings → Connection → the hub).
   The status pill should read connected within a second or two of the
   confirm step.
3. **Watch the shell** — the floating bar (4-side margins, the spring
   indicator, the approvals badge), the large-title headers, the
   connection pill always visible. Tap the pill when the desktop is off:
   the truth arrives immediately; the ladder keeps probing.
4. **Open a session and type** — the composer must stay ABOVE the keyboard
   (the round's keyboard fix). Send a message: bold renders, code blocks
   are mono tiles, the tool cards expand, the caret pulses while streaming,
   thinking shows in the live view.
5. **The dashboard tab** — 14d/30d/3mo windows, the chart, the model
   leaderboard. **Projects** — tap one, create a session.
6. **Settings from the phone** — Providers (set a key — write-only; test
   the connection), Agents, Prompts, Preferences. Every change saves
   immediately and says so honestly.
7. **Unpair and re-pair** — Settings → Connection → the danger zone;
   re-scan the desktop's QR. The full-disconnect-and-rescan path works.
8. **Logcat** — filter `tag:ACUTE-MOB` (the README has the recipes).
   Disconnect the desktop's Wi-Fi: the phone's pill flips to offline
   WITHOUT a manual refresh; bring it back: the ladder reconnects.

Then, when ready: `docs/guides/CLOUDFLARE-SETUP.md` Mode A — anywhere
access in ~5 minutes, no account needed.

## §10 Deliberately NOT done

- **No multi-host UI on the phone yet** — the architecture guide
  (§7) is the contract for the later round; the phone's host store stays
  single-host by honest scope.
- **No Firebase push wiring yet** — the desktop's push publisher ships
  DORMANT by design; the guide's completion is what wakes it next round.
- **No per-bar a11y on the usage chart** — react-native-svg shapes don't
  carry accessibility props in their typings; the chart is a labeled
  container.
- **No create-model client on the phone** — catalog models without a
  configured record render read-only with an honest caption (the desktop's
  models tab owns creation).
- **The ClaySwitch remains file-local** (duplicated in preferences.tsx and
  the provider editor) — a promotion to `primitives.tsx` when it itches.
