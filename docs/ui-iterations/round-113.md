<!-- last-reviewed: 2026-09-20 round-113 -->
<!-- round: 113 -->
# Round 113 — live sync: every device mirrors every other device (the post-v0.106.0 test round)

The owner's verdict on v0.106.0: remote access held, the relay worked — and
then his live test between the PC and the phone exposed the gap nobody had a
wire for. A turn started on one device was INVISIBLE on the other until a
manual refetch ("no live streaming, no thinking/tool-run indicators" — he had
to switch sessions and back). Theme and settings changes never propagated
across devices. The Providers tab showed the addable catalog instead of his
configured few. The Sessions screen was "completely bad so completely remove
it… the project screen relies on the session screen too." Big page headers
wasted space on every screen, the Android keyboard covered the composer, and
the phone's chat screen was missing half the PC's controls. Plus the systemic
ask: system prompts and skills formatting improvements.

This file records the round that answered all ten items. The headline is the
**live-sync backbone** — one in-process events bus, one SSE stream
(`GET /api/v1/events/stream`), both clients consuming it, so a turn started
anywhere streams everywhere. The six commits: 84f846f (the events fan-out,
agent-core), 0306f83 (the desktop goes live), a127537 (the mobile session
replica), f7fdd02 (the space-honest desktop shell), 8a5c0c0 (the phone goes
live + the Projects tab), 1af3d5a (the prompt discipline round).

## §0 The owner's report, itemized

| The ask (R113) | The answer | Where |
|---|---|---|
| **#1 Theme/appearance changes don't propagate** between PC and Android (and vice versa) | A server-backed appearance domain — `GET/PUT /api/v1/settings/appearance` (`{themeId: nova\|bento\|midnight\|sunset\|mono\|clay\|null, mode: system\|light\|dark}`) — and every settings PUT broadcasts `{"type":"settings","domain":"appearance","value"}` on the events bus. The desktop hydrates at boot, PUTs optimistically with an echo guard (no PUT-back loop), and resolves "system" against the live OS preference; the phone does the same (AsyncStorage is the offline fallback). A flip on either device shifts the theme on the other within the frame round-trip | `agent-core/src/routes/settings.ts`, `src/lib/theme-store.ts`, `mobile/src/features/appearance-sync.ts` |
| **#2 Settings changes don't update in live view** across devices | ALL settings-domain PUTs broadcast (orchestration/memory/debug/retry/thinking-loop/browser/desktop-notifications/device-link/cloud-connector[secret-free]/appearance/vision). The desktop maps every frame to the exact TanStack query keys the settings tabs use (10-domain table) → live refetch + apply; the phone's preferences screen refetches while open (epoch-guarded, no double-fetch on mount) | `agent-core/src/routes/settings.ts`, `src/lib/events-stream.ts`, `mobile/src/features/events.ts` |
| **#3 Providers tab showed the addable catalog**, not the configured providers | The server now tells the truth: every provider row carries `configured: boolean` (a custom row OR keyCount > 0) and pool-aware `hasKey` (keyCount > 0 — the old primary-slot-only `hasKey` read `false` for a provider whose keys all sat in pool slots), from ONE view builder shared by GET / POST-adopt / POST-create / PATCH. Both clients render configured-first: "Your providers" above an "Add a provider" catalog tier, honest empty states | `agent-core/src/providers/registry.ts`, `agent-core/src/routes/providers.ts`, `src/components/settings/ModelsProvidersTab.tsx`, `mobile/app/settings/providers/index.tsx` |
| **#4 "The session screen is completely bad so completely remove it… the project screen relies on the session screen too"** | Removed on both platforms. Mobile: the Sessions tab is GONE — merged into a Projects tab (registry + counts + running pulse + quick-new-session) that opens a project detail screen carrying that project's own sessions; the tabs are now home · projects · approvals · dashboard · settings. Desktop: the dead sessions-screen source is deleted (the route was already gone since the round-49 removal — R113-d pruned the orphaned source and its dead api.ts exports), and ProjectView session rows navigate per-session (`?session=<id>`) with an inline New session affordance | `mobile/app/(tabs)/projects.tsx`, `mobile/app/project/[id].tsx`, `src/components/projects/` (ProjectView), `src/README.md` (routes table) |
| **#5 Big page headers on every screen** waste space | Desktop: the page-level Kicker+h1 blocks were deleted across the working screens (Dashboard, Usage, Settings, Agents, ProjectView, placeholders, DemoViewer) — each screen's real content is its top now; in-content kickers (tab intros, rail labels) survive. Mobile: the ScreenScaffold's large TypeDisplay tier is deleted — compact header rows everywhere, tab roots carry no taglines | `src/pages/` + `src/components/` (header deletions, R113-d), `mobile/src/components/screen-scaffold.tsx` |
| **#6 THE BIG ONE — messages sent from mobile/PC don't appear live on the other device; no live streaming, no thinking/tool-run indicators; had to switch sessions and back** | The live-sync backbone (§1): an in-process events bus publishes EVERY frame the initiating turn socket receives, plus session log/status/creation, project creation, and settings PUTs; `GET /api/v1/events/stream` (SSE, 10 s heartbeat) mirrors it to every connected client. The desktop replays a remote turn through the SAME live-transcript machinery (thinking block, streaming caret, tool cards, queue chips — the sidebar spinner runs while ANY device runs a turn; debounced refetches fold the persisted log after terminal frames). The phone streams remote turns through the SAME applyLiveFrame reducer its own sends use (caret/tool/queue chips, zero transcript special-casing), refreshes lists on the ~1 s debounced batch, and the stale-status poll bug is dead (live status frames flip the badge + widen the 3 s poll the moment a PC turn starts). An own stream always wins (mirrored frames ignored while busy); Stop on a remote turn routes to the server's /stop; Enter while a remote turn runs queues | §1 below; `agent-core/src/lib/events-bus.ts`, `agent-core/src/routes/events.ts`, `src/lib/events-stream.ts`, `src/lib/stream-store.ts`, `mobile/src/features/events.ts`, `mobile/src/features/sessions.ts` |
| **#7 Android keyboard covers the input** | The session screen gained the safe-area bottom inset + the keyboard-controller pattern — the composer fully clears the keyboard | `mobile/app/session/[id].tsx` |
| **#8 Mobile chat composer missing**: attach/upload file, select file from project, operation mode, context window usage, model selection, thinking level | All delivered (§4): the control row (mode switcher · model selector sheet · thinking-level cycle · context ring + breakdown sheet) plus the attach flow (expo-document-picker → upload through the binary-body native module) and the @-project-file picker; send/queue/stop machine; attachment chips | `mobile/src/components/composer.tsx`, `mobile/src/features/attachments.ts`, `mobile/src/features/context-meter.ts`, `mobile/src/features/composer-state.ts` |
| **#9 Mobile transcript missing** tool calls/errors/etc. | Tool cards + error cards already existed (R109); the round made the rest real: images/screenshots with a full-screen viewer, question cards (numbered options), todo cards, sub-agent cards — with the clay animations | `mobile/src/components/transcript.tsx`, `mobile/src/components/image-viewer.tsx`, `mobile/src/features/sessions.ts` |
| **#10 System prompts + skills formatting improvements** | The prompt discipline round (§5): argument-hygiene + benign-exit rules grounded in the OMP roadmap + opencode/aider/cline research, paid for by same-round dedup (budget 23,765 → 23,871 of the 24,000 cap — held WITHOUT a bump); every skill load carries the Agent-Skills envelope (name + when-to-use description + body) on all three surfaces, with the builtin doubled header fixed | `agent-core/src/agents/prompts.ts`, `agent-core/src/tools/plugins/skills.ts`, `agent-core/tests/r113-prompts-skills.test.ts` |

## §1 The live-sync backbone (the wire, and why it is shaped like that)

The root cause of item #6 was structural: turn deltas rode ONLY the
initiating client's own SSE response (`routes/sse.ts`), and the notification
bus carried only end-of-turn toasts. No event ever said "a session you are
looking at changed" — so the desktop and the phone each saw a frozen world
unless they were the one driving the turn.

**The design** (R113-a, commit 84f846f): ONE process-wide pub/sub —
`agent-core/src/lib/events-bus.ts`, the notification-bus pattern verbatim
(singleton, subscribe → unsubscribe, try/catch + stderr log around every
subscriber so a watcher's dead socket never propagates into a turn) — with
publish points chosen at single choke points, verified empirically
(`appendSessionEvent` is the only runtime writer into `session_events`;
`setSessionStatus` the only direct status UPDATE, flip-gated; the SSE `send()`
closure publishes BEFORE the clientGone check, so the mirror survives the
initiator's own death mid-turn).

**The wire contract** (documented for downstream clients; this is the
contract both shipped clients code against):

- `GET /api/v1/events/stream` — bearer-gated SSE; SHELL + DEVICE tokens both
  pass; NOT device-blocklisted (the phone reaches it through the cloud relay,
  whose guest allowlist permits `/health` + `/api/*`); `: ping` comment
  heartbeat every 10 s (the R112 disconnect-loop fix applied here too).
- Frames:
  `{"type":"hello"}` (once, immediately on open — semantics: **"resync
  everything"**; a fresh/reconnected watcher refetches its state, then
  follows frames);
  `{"type":"session","sessionId","projectId","kind":"event"|"status"|"created","seq?","status?"}`
  (log append / status flip / new session);
  `{"type":"turn","sessionId","frame"}` — the LIVE turn mirror: `frame` is
  the EXACT `StreamTurnEvent` the initiating socket receives, published
  pre-serialization (text-delta, thinking-delta, tool-*, meta.*, queued,
  error, done, stopped, debug-*, subagent-status…);
  `{"type":"project","projectId","kind":"created"|"updated"}`;
  `{"type":"settings","domain","value"}` — every settings domain PUT, the
  persisted object as the domain's GET serves it (secrets NEVER ride the
  frame; cloud-connector broadcasts `hostKeyPresent`, not the key).
- **NO server-side session filtering** — one global channel; every client
  filters by `sessionId` locally (deliberate: a single-owner sidecar gains
  nothing from per-session subscriptions and pays reconnect complexity).

Honest vocabulary notes (documented in-code too): "created" fires at the
`createSession` storage choke point (covers POST /sessions AND delegation
children; `forkSession` announces its own), project "updated" is dead
vocabulary (no update route exists — DELETE stays unannounced in v1), and
status frames fire only on REAL flips (a no-op write is not news).

**The desktop half** (R113-b, 0306f83): `src/lib/events-stream.ts` (the
notifications-stream reader pattern, split into pure parse + open + dispatch;
300 ms trailing debounce on refetch-class frames; terminal set =
done/error/stopped) + `EventStreamStarter` mounted in AppShell beside its
notifications twin. Remote turn frames replay through the SAME
`handleStreamEvent` reducer the initiating socket's reader dispatches through
— zero panel special-casing beyond a `remoteRunning` busy union (the caret and
the context donut live-poll during a remote turn too). Terminal frames retire
the mirror after a 1.5 s beat (cancellable — a new remote turn opening inside
the window is not killed by a stale clear) and refetch the folded log/usage.
The sidebar spinner composes with the active-streams marks idempotently.

**The mobile half** (R113-e, 8a5c0c0): `mobile/src/features/events.ts` (the
activity controller's exact lifetime + R42 foreground discipline + R110 blip
discipline; hello = immediate resync; a ~1 s debounce batches session-frame
bursts into ONE list refresh; turn frames go to listeners only — the open
session screen). Remote turns stream through the existing `applyLiveFrame`
reducer; the initiator guard keeps the phone's own turns undoubled;
rebase-on-rehydrate folds the persisted user card under the mirrored tail;
the widened 3 s poll only runs while something is actually live (the
stale-status bug).

## §2 Appearance sync (item #1, end to end)

- **Server**: the appearance domain follows the desktop-notifications
  settings pattern exactly — fail-open corrupt reads, 400s that name the
  field, secret-free broadcast. GET default `{"themeId":null,"mode":"system"}`
  (null = no server preference — each client falls back to its LOCAL default,
  the honest pre-R113 behavior); PUT takes a partial `{themeId?, mode?}`
  patch. Device tokens are WELCOME here (the phone changing the desktop's
  theme is a first-class use case; only management-surface domains reject
  device tokens).
- **Desktop**: boot GET hydrates (themeId only when non-null; mode outright;
  failures silent → local offline fallback); every local flip
  (setTheme/setMode/toggleMode — the wizard's buttons included) PUTs
  optimistically; the echo guard stops the PUT-back loop; "system" resolves
  via `prefers-color-scheme` with a LIVE OS-flip listener.
- **Mobile**: hydrate on connect/reconnect/hello; appearance-domain frames
  apply live without a fetch; theme setters that push mid-apply never PUT
  back (the echo pin is a test); the server wins when reachable,
  AsyncStorage is the offline fallback.

## §3 The space-honest shells + Projects-first navigation (items #4/#5)

- **Mobile tabs**: home · PROJECTS · approvals · dashboard · settings. The
  Projects tab is the registry (color dot, name, mono root, session count +
  running pulse, per-row quick-new-session, the New-project sheet —
  `createProject` finally wired); a row opens the project detail screen
  (`mobile/app/project/[id].tsx`) listing that project's sessions with live
  badges + relative time. The standalone Sessions tab and the root projects
  screen are deleted; home's Sessions card folded into Projects. Every
  screen renders the one compact header row (the large TypeDisplay tier is
  deleted from the scaffold; pushed-screen context subtitles survive — the
  spec's target was TAB-ROOT taglines).
- **Desktop**: the page-level Kicker+h1 blocks are gone from the working
  screens (the only h1s left: the wizard's onboarding screens, ProjectView's
  deliberate 13px row-tier name, error chrome); ProjectView session rows open
  THEIR session (`?session=<id>`) with an inline New session button (the
  sidebar's create-then-land recipe, with a no-agent fallback landing the
  chat screen's teaching empty state); the legacy sessions-screen source is
  deleted along with its dead `ChatEntry`/`toChatEntries` api.ts exports
  (rg-proven dead; every `hooks/use-sessions.ts` export verified still
  alive).
- **Providers configured-first** (item #3's UI half): the two-tier rail
  groups on the SERVER's `configured` bit — the R59 client-side
  preset-ids heuristic is retired as the grouping mechanism
  (`PRESET_PROVIDER_IDS` survives only as detail-pane display logic); the
  catalog tier stays visible and selectable (that is where a key lands).

## §4 The mobile session screen becomes a real replica (items #7/#8/#9)

R113-c (a127537) rebuilt the session screen around the owner's composer
list. Every control the PC's composer has, the phone now has:

- **The control row**: operation-mode switcher · model selector sheet (the
  agent's model + manual override) · thinking-level cycle · the context ring
  with a breakdown sheet (the same budget truth the desktop donut reads).
- **Attach/upload**: expo-document-picker → expo-file-system, uploaded
  through the acute-net native module's new binary-body support
  (pinned-TLS OkHttp); attachment chips with per-item dismiss.
- **@-project-file picker**: select a file from the project — the project's
  own tree, not the phone's storage.
- **Send/queue/stop machine**: the outbox overrides round-trip (queued
  messages carry the composer's model/thinking/mode choices).
- **The keyboard fix**: safe-area bottom inset + the keyboard-controller
  pattern — the composer fully clears the keyboard (item #7).
- **The rich transcript**: tool cards + error cards already existed; images
  and screenshots now render (full-screen viewer), question cards carry
  numbered options, todo cards and sub-agent cards are real — with the clay
  animations on the primitives.

## §5 The prompt discipline round (item #10)

R113-f (1af3d5a), grounded in the OMP adoption roadmap + the opencode/aider/
cline research corpus (`docs/research/`):

- **Two verified gaps, fixed**: TOOL USE gained the ARGUMENT HYGIENE rule
  (copy paths/ids/selector paths from the outputs that issued them — never
  invent, never trust memory; a guessed argument is a wasted call — the R67
  guessed-path and R94 stale-field report class); TERMINAL gained the
  BENIGN-EXIT rule (non-zero exit is often the answer — grep/test/diff exit
  1 on no-match; read the output before deciding anything failed).
- **Paid for by dedup**: five weakest duplicated lines retired (GIT's three
  sequencing lines → one, TERMINAL's discovery line, CODE NAVIGATION's
  list_dir line, WEB ACCESS's compressed search-first, MCP's retry tail).
  Measured default prompt: 23,765 → 23,871 chars — the 24,000 r71 budget
  holds WITHOUT a bump.
- **The skills envelope**: `read_skill` bodies render
  `# Skill: <name>` + `> <description>` + body for DB, user, and file skills
  alike (migration-free); a tolerant exact-match dedup drops builtin bodies'
  own house header (one identity header, not two); the description is now
  coherent on all THREE surfaces (prompt index, search_skills results,
  loaded body).
- **Deliberately NOT changed** (studied, judged already at or above the
  research bar): the 32-section ordering, PRECEDENCE/autonomy ladders,
  six-phase loop, RECOVERY protocol, honesty contract, hint/reminder voices,
  the always-on composition. Two-tier tool loading / TTSR stay runtime
  machinery, out of prompt-text scope.

## §6 Verification (every number below was actually run, per commit)

| Commit | Scope | Gates fresh at the committed tree |
|---|---|---|
| 84f846f (R113-a) | agent-core only, 14 files +1,621/−33 | agent-core **2551/2551** (134 files; baseline 2525, +26 = events-bus 5 + appearance 13 + events-stream 5 + providers +3 — incl. the initiator-dies-mid-turn mirror test); ROOT `tsc -p tsconfig.json --noEmit` clean (the R112 lesson — root covers agent-core/tests); eslint clean (root + scoped); secret scan 0 hits |
| 0306f83 (R113-b) | src/ only, 18 files +1,890/−35 | root vitest **4234/4234** (243 files, 0 failed); ROOT tsc clean; eslint clean; design:audit clean (R2 1591/1591 AT the R112-f baseline — no re-pin; text stayed inside the idiom); secret scan 0 hits |
| a127537 (R113-c) | mobile/ only, 22 files +4,691/−148 | mobile tsc clean; mobile jest **268/268** (13 suites; baseline 210 → +58); tree clean; secret scan 0 hits |
| f7fdd02 (R113-d) | src/ only, 23 files +547/−934 | root vitest **4236/4236** (242 files — −3 ChatView tests, +5 new); ROOT tsc clean; eslint clean; design:audit clean (101 files; R2 1552/1591, BELOW baseline — a text-removal round, no re-pin); secret scan 0 hits |
| 8a5c0c0 (R113-e) | mobile/ only, 23 files +3,166/−499 | mobile tsc clean; mobile jest **332/332** (17 suites; +64: events 25 + sessions remote-mirror 12 + appearance-sync 17 + config 8 + the scaffold type pin); no new dependencies; secret scan 0 hits |
| 1af3d5a (R113-f) | agent-core only, 6 files +549/−17 | agent-core **2570/2570** (135 files; +19 prompts/skills); ROOT tsc clean; eslint clean; prompt budget 23,871/24,000 measured; secret scan 0 hits |

**The integrator-verified final matrix at 1af3d5a**: root typecheck clean ·
root vitest **243 files 4255/4255** (0 failed) · eslint clean · build green
(the mermaid chunk ok) · e2e **12/12** · license:audit clean (**299** prod
deps) · mobile tsc clean + **17 suites 332/332** · secret scans (the full
diffs, every round): **0 hits** for `github_pat_`/`sk-or-v1-`/`nvapi-`.
This docs round adds docs:check 241 scanned / 0 failures (2 transient URL
WARNs under the cap).

### §6.1 The round's infra noise (honesty section)

- The R113-b full-suite run hit a sandbox disk at 100 % (5.4 GB of stale
  `acute-*` test-artifact dirs + 204 stale .db files in /tmp from earlier
  rounds' gate runs) — a re-run failed 1,977 tests en masse with no code ever
  wrong. Cleared, re-run: green. Recorded so nobody chases that ghost.
- The R113-c finisher launch "timed out" AFTER completing its commit+push —
  its report was lost, so the integrator re-verified everything from the
  committed tree (the numbers above are that re-verification).

## §7 Deferred (with reasons, not excuses)

- **The owner's round-113 walkthrough** — the live-sync test on real
  hardware (pair the phone, start a turn on either device, watch it stream
  on the other; flip the theme; check the composer). The suites pin the
  machinery; only the owner's hands close the loop.
- **The off-LAN relay walkthrough** (R112's outstanding item) — the owner's
  to do; the relay itself is production-verified 12/12.
- **Providers add-new from the phone** — the remaining half of R110 #3: the
  configured-first split + pool-aware `hasKey` landed on both clients, but
  the phone's rows push into the same editor; a phone-side provider-create
  client riding the desktop's POST /providers surface is its own small round.
- **Firebase (FCM v1) — the guided one-time setup** — deferred by the
  owner's explicit choice; the guide and the ping-only skeleton are ready.
- **GitHub Actions — the release pipeline under 20 minutes** — queued (its
  own round; per-push APK builds, cache keys, tag-run reuse identified).
- **The StablePrefix split** (OMP roadmap #2) — R113-f's noted next
  candidate; needs a dedicated round (chat.ts + runtime.ts + golden re-pin).
- **The OMP #11 nudge tier** — cheap filler, only if the owner asks.

Next: the release round (the version bump renames the CHANGELOG's Unreleased
section), then the owner's walkthrough.
