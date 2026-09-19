<!-- last-reviewed: 2026-09-19 round-110 -->
<!-- round: 110 -->
# Round 110 — remote access: the cloud relay (the anywhere-link round)

The owner's verdict on v0.105.0: the pairing worked, the wizard worked, the
homepage was "quite good-looking" — and then the list. **The connection
dropped every single time** ("reconnecting, disconnecting, reconnecting —
stuck in this loop"), appearance changes didn't reach the PC, Providers
showed the whole catalog instead of the configured few, a stray back arrow
on the Connect screen, too much description on "Add a Connection", no
pairing code after scanning, and projects/sessions "not proper." Plus two
systemic asks: a release pipeline that doesn't take an hour, and a
Cloudflare setup that isn't "quite complex and quite hard."

This file records the round that answered the connectivity core of that
list: **the cloud relay** (a one-time Cloudflare Worker, deployed once from
the browser, live and production-verified), the desktop connector that
dials it, the phone's LAN-first/relay-fallback ladder — and the
disconnect-loop root causes, killed on both sides of the wire. The commits:
86ac572 (the integration — desktop connector + mobile relay support + the
root fixes, all suites green), plus this docs commit.

## §0 The owner's report, itemized

| The ask (R110) | The answer | Where |
|---|---|---|
| **#1 THE DISCONNECT LOOP** — "it would automatically disconnect… every single time" | Root-caused on BOTH sides and fixed at the root: the notifications + turn SSE streams had NO heartbeat (idle connections died at NATs/Wi-Fi power-save); the servers' 5 s keep-alive collided with the phone's 5-minute connection pool; the phone flipped offline on ANY transient blip and NetInfo wakes bypassed backoff. All five roots fixed this round (§4) | `agent-core/src/server.ts`, `agent-core/src/routes/sse.ts`, `agent-core/src/lib/device-link.ts`, `mobile/src/link/connection.ts`, `mobile/src/link/triggers.ts` |
| Cloudflare "too complex" via docs → **one-time, browser-only, guided** | The relay: ONE Cloudflare Worker + Durable Objects, deployed once via the dashboard's "Connect with GitHub" (guided live over the NTFY side-channel); no domain, free plan, permanent `acute-relay.anikuta.workers.dev`; every future relay update = a git push (auto-redeploy, verified twice live) | `docs/guides/CLOUDFLARE-SETUP.md` (rewritten — now one paste), the acute-relay repo |
| **One-time setup, nothing per-connection** — ~100 connections, deletable | Rooms are Durable Objects (one per desktop, hibernating — idle rooms cost ~nothing); the phone adds zero per-connection work (the relay URL rides the pairing QR); connections are listable/evictable/prunable via the admin API; scales to ~1,000 later with a dashboard click and zero migration | the acute-relay repo (`Room`/`Registry` classes) |
| **Local AND internet, selectable, both at once** | Two independent toggles on the PC: the existing "Device link" (LAN) card and the NEW "Remote access (internet)" card — both can be ON simultaneously; the phone probes the ladder LAN-first, relay-last, automatically | `src/components/settings/DevicesTab.tsx`, `mobile/src/link/connection.ts` |
| **#4 Connect screen back arrow** (root screen, nothing to go back to) | The chevron renders only when `router.canGoBack()` — the post-onboarding landing has nothing behind it, so no arrow; pushed screens keep theirs | `mobile/app/connect/index.tsx` |
| **#5 "Add a Connection" too much description** | The hero is one line now: "Scan a pairing QR from your desktop, or enter an address manually." | `mobile/app/connect/index.tsx` |
| **#6 Pairing code not shown after scanning** | The confirm screen shows the PIN prominently (4+4 mono grouping, `pair-pin` testID), visible through the countdown and the pairing spinner | `mobile/app/connect/confirm.tsx` |
| #2 Appearance → PC sync | Deferred to the next round (scope: which phone settings propagate; needs a settings-write surface decision) — NOT rushed into this release | round-111 (planned) |
| #3 Providers: show only added + add-new flow | Deferred (needs a phone-side provider-create client riding the existing POST surface) | round-111 (planned) |
| #7 Projects/sessions "not proper" | Deferred — the owner's specifics are needed first (what exactly failed) | the next walkthrough |
| GitHub Actions ≈1 h per release | Deferred to its own round (candidates identified: per-push APK builds, cache keys, tag-run reuse) | round-113 (planned) |

## §1 The relay (one Cloudflare Worker, deployed once, free forever)

The old guide offered tunnels: Mode A (a `trycloudflare.com` URL that DIES
on every reboot — the opposite of one-time) or Mode B (a bought domain, a
`cloudflared` service install per PC, CLI-shaped config — the complexity
wall the owner actually hit). Both were rejected. The chosen design, locked
against the owner's six requirements (one-time; browser-only; nothing
per-device; WebSockets proper; ~100 connections; deletable):

- **One Worker + two Durable Object classes**, private repo
  `testplay-byte/acute-relay`, deployed via the dashboard's *Connect with
  GitHub* — so every future relay fix is a `git push` and Cloudflare
  redeploys it (observed live twice this round).
- **Room** (one per desktop, keyed by the existing 64-hex `machineId`):
  hosts ONE outbound WebSocket tunnel (`/h/<machineId>/host`, HOST_KEY
  header auth) and proxies the phone's ordinary HTTPS+SSE requests
  (`/m/<machineId>/api/...`) through it. The heartbeat pair
  (`{"t":"ping"}` → `{"t":"pong"}`) is answered AT THE EDGE via
  `setWebSocketAutoResponse` — an idle room never wakes the relay.
- **Registry**: the connection index — list/evict/prune (delete old
  connections), gated by ADMIN_KEY.
- **The blind-pipe security model**: the relay never holds device tokens;
  guest requests carry the app's own Bearer token, validated by the desktop
  exactly as on LAN. Guest paths are allowlisted to `/health` + `/api/*`.
  The R109 device-token blocklist applies over the internet unchanged.

The deploy itself taught the round's hardest lesson: the first build failed
with `cloudflare:workers does not provide an export named
'WebSocketRequestResponsePair'` (error 10021). Root-caused empirically on a
local `wrangler dev` — probe workers enumerated the module's real exports,
walked the DurableObjectState prototype, and the TypeError's own text
revealed the truth: **the class is a Workers GLOBAL, not a module export**.
Fixed with a one-line import removal, verified 12/12 locally BEFORE the
next push (the owner never clicked retry), then production-verified 12/12:
health, admin auth ±key, the WSS tunnel over the real internet, guest
round-trips, SSE through the edge, registry listing, evict (close 4001),
503-after-evict, prune, and the path allowlist.

## §2 The desktop connector (the PC dials OUT; nothing inbound, ever)

`agent-core/src/lib/cloud-connector.ts` — one outbound WebSocket to the
relay, modeled on the device-link controller and the fcm-push
never-fatal-boot pattern:

- **Handshake**: on `welcome` → send `hello` (machineId, label, app
  version). **Liveness**: the exact text `{"t":"ping"}` every 25 s; a 10 s
  pong watchdog kills dead tunnels. **Reconnect**: 1 s → 60 s exponential
  backoff with ±30 % jitter; close 4000 (replaced) / 4001 (evicted) jump
  straight to the 60 s cap; it reconnects forever while enabled and NEVER
  throws upward.
- **Bridging**: every relayed request is performed against the desktop's
  OWN TLS device listener (`https://127.0.0.1:<tlsPort>` — the pinned
  self-signed cert, loopback-only), forwarding only the six safe headers
  (authorization, content-type, accept, accept-language, user-agent,
  x-requested-with). SSE responses stream frame-by-frame
  (`res-open`/`chunk`/`end`); everything else is buffered (≤ 10 MB) into a
  single `res`; failures become `err` frames. Pairing claims ride the same
  path — so pairing over the internet works exactly like pairing on LAN.
- **Control surface**: settings keys `cloudConnector.enabled/.relayUrl/
  .hostKey` + `GET/PUT /api/v1/settings/cloud-connector` (shell-token
  only — device tokens are walled off, per the R109 blocklist).
- **The QR carries the cloud**: while connected, `pair/start` adds
  `relay: "<base>/m/<machineId>"` to the QR payload — additive, `v` stays
  1, so v0.105.0 phones simply ignore it. `pair/claim` and `link-info`
  carry the same field.
- **The `ws` package** (8.21.3) rides `agent-core`'s registry dependencies —
  the sidecar bundle's `pnpm install --prod` picks it up with no extra
  wiring.

## §3 The phone: the ladder, the relay rung, and honest failure

- **Pairing**: the QR's optional `relay` field (https://, ≤ 200 chars,
  whitespace-free — present-but-invalid is a typed `bad-relay`, never a
  crash) and the claim response's `relay` (claim wins, QR falls back) both
  land in the host store (`acute.host.relay`). Manual entry got smarter
  too: a hand-typed relay room URL (`https://…/m/<64hex>`) keeps its room
  path instead of being origin-stripped.
- **The ladder**: stored LAN addresses first (bare host + port, TOFU pin —
  unchanged), the relay LAST (full URL, standard CA). Same machineId
  identity check on every rung. The relay's `503 {error:{code:
  "host_offline"}}` is classified as RETRYABLE connectivity — never an
  unpair trigger; only a real 401 wipes.
- **R110 #1's mobile half** (see §4): 5 s probes, two-cycle hysteresis,
  transition-gated + 5 s-debounced NetInfo wakes, non-overlapping probe
  rounds, and SSE teardown aligned to the hysteresis-verified state.

## §4 The disconnect loop — five roots, five fixes

| # | Root cause (measured, not guessed) | The fix |
|---|---|---|
| 1 | The notifications stream and the turn stream had **no heartbeat at all** — silent after `hello`, murdered by NATs/Wi-Fi power-save | 10 s `: ping` comment frames on BOTH streams (the terminal stream's existing pattern, applied everywhere) |
| 2 | Node's default **5 s keepAliveTimeout** on both servers vs the phone's 5-minute OkHttp connection pool with `retryOnConnectionFailure(false)` — every request after >5 s idle hit a server-closed socket | `keepAliveTimeout` 65 s + `headersTimeout` 66 s on BOTH the loopback Fastify server and the TLS device listener |
| 3 | **One transient failure = "offline"** — zero hysteresis, the pill flapped on every blip | Two consecutive failed cycles before connected→offline; a success between cycles resets the count |
| 4 | **NetInfo wakes bypassed backoff** — every network callback fired an immediate probe (storms) | Wakes gate on actual reachability TRANSITIONS + a 5 s debounce; foreground wakes stay immediate |
| 5 | **3 s probe timeout** — a busy desktop (a running turn) misses it | 5 s rung timeout (claim gets 2×), plus a no-overlap in-flight guard so rounds never stack |

## §5 The small pairing-screen fixes (the owner's #4/#5/#6)

- **#4**: the Connect hub is root-aware — `router.canGoBack()` gates the
  chevron; the post-onboarding replace-landing shows nothing (nothing to
  go back to), pushed-from-tabs keeps the affordance.
- **#5**: the "Add a connection" hero is one line — the shape hint does the
  explaining ("cloud relay — reaches the desktop from any network" on the
  manual page).
- **#6**: the confirm screen carries the PIN as a first-class citizen —
  4+4 mono digits, live window countdown, visible through the pairing
  spinner. The owner sees the code he's about to type.

## §6 Verification (every number below was actually run at 86ac572)

| Suite | Result |
|---|---|
| agent-core (131 files) | **2525/2525** — includes the four new R112 files: cloud-connector (handshake, watchdog, backoff+jitter, req→res/SSE/err mapping, base64 round-trip, 10 MB cap, never-throw), cloud-settings (auth ±token, hostKey keep/clear, runtime reconfigure, throwing-factory degradation), qr-relay (connected-only field, /m/ composition, claim carries it, payload stays additive), keepalive (heartbeats registered + cleaned up, timeouts set on both servers) |
| Root (238 files) | **4153 passed / 0 failed** (15 skipped, unchanged policy) — +58 over v0.105.0 (the DevicesTab remote-access card tests) |
| Mobile (10 suites) | **210/210** — was 164; +46 (relay validation, ladder order, 503-retryable-never-unpair, hysteresis, debounce, no-overlap, manual room URLs, PIN display) |
| Typecheck ×3 + lint | clean / clean / clean / clean (agent-core, mobile, root; eslint) |
| The relay, production | 12/12 (health, admin ±key, live WSS tunnel, guest round-trips, SSE through the edge, list/evict/prune, allowlist) |

## §7 Deferred (with reasons, not excuses)

- **Appearance → PC sync (#2)**: needs a scope decision (which phone
  settings propagate) + a settings-write surface from the phone — its own
  round, not a rushed rider.
- **Providers: only-added + add-new (#3)**: the phone lacks a
  provider-create client; the desktop POST surface exists. Next round.
- **Projects/sessions specifics (#7)**: the owner's walkthrough detail is
  required first — vague fixes are how bugs hide.
- **Firebase (FCM push)**: deferred by the owner's explicit choice this
  round ("I don't think we require Firebase for the time being").
- **GitHub Actions speed**: its own round (per-push APK builds, Gradle/pnpm
  cache keys, tag-run APK reuse identified as candidates).

Next: the v0.106.0 release (version bump + tag + assets), then the owner's
off-LAN walkthrough — pair once, walk out of Wi-Fi range, watch it stay
connected.
