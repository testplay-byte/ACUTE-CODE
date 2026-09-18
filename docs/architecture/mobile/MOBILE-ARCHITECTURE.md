<!-- last-reviewed: 2026-09-18 round-106 -->
<!-- status: the implementation deep-dive for the Android companion (v1,
     built R106). The owner-facing contract lives in
     docs/planning/LINKING-PROTOCOL.md; the decisions in
     docs/planning/ANDROID-R3-OWNER-RULINGS.md. This document is for
     anyone reading or changing mobile/ code. -->

# MOBILE-ARCHITECTURE.md — the Android companion, as built

The v1 companion is a React Native (Expo SDK 57) app in mobile/ — a
standalone npm workspace (outside pnpm-workspace.yaml, so the desktop
pipeline's --frozen-lockfile is untouched). It is a VIEW + INPUT medium
for the desktop agent (the owner's ceiling ruling): every action is an
API call to the sidecar; nothing is processed on the phone and no file is
ever changed by the phone.

## §1 The layer map

```
mobile/
  app/                      expo-router file routes (the screens)
    _layout.tsx             the root stack (theme + gesture + splash hold)
    index.tsx               the router gate (paired ? tabs : pairing)
    pairing.tsx             QR scan + manual fallback + confirm + ladder
    settings.tsx            themes · host identity · unpair · about
    (tabs)/_layout.tsx      the custom TabBar (presentational + adapter)
    (tabs)/home.tsx         the host card + quick entries + theme dots
    (tabs)/{projects,sessions,approvals,notifications}.tsx
    session/[id].tsx        the transcript + live stream + composer
  src/design/               the "quiet instrument" design system
    tokens.ts               5 desktop themes 1:1 + 8-pt grid + type ladder
    theme.tsx               provider (system/dark/light, persisted)
    primitives.tsx          PressableCard · Hairline · Badge · TypeScale
    motion.ts               spring 180/22 · 30ms stagger · fade-in-up
  src/link/                 the linking + connection layer (pure TS)
    pairing.ts              QR payload + manual-entry parsers/validators
    host-store.ts           SecureStore(token) + AsyncStorage(identity)
    connection.ts           the state machine + api()/sse() + backoff
    pair-flow.ts            validate → probe → claim → store
    native-transport.ts     acute-net JS binding → NetTransport
    triggers.ts             AppState + NetInfo → retry signals
    runtime.ts              the ONE manager instance
    use-link.ts             the React subscription hook
  src/features/             the feature clients (pure TS + tested)
    approvals.ts · sessions.ts · outbox.ts · api.ts
  src/components/           shared widgets (host-card, composer, transcript…)
  modules/acute-net/        the LOCAL Expo native module (Kotlin + OkHttp)
```

## §2 The native module — acute-net (the linchpin)

RN's fetch/XHR can neither TOFU-pin a self-signed certificate nor stream
SSE reliably — so ALL device traffic rides one local Expo module
(modules/acute-net/, Kotlin + OkHttp, autolinked at prebuild):

- request({url, method, headers, bodyText?, timeoutMs?, pinSha256?}) →
  {status, headers, bodyText}
- openSse({url, method?, headers, bodyText?, pinSha256?, timeoutMs?}) →
  {eventId, close()} — the body is parsed as SSE server-side
  (data:/event:/\n\n) and emitted through the module's event emitter;
  the JS side subscribes by eventId.

**TLS discipline:** pinSha256 (64 hex, no colons) installs a PER-CALL
X509TrustManager + HostnameVerifier accepting exactly the leaf cert whose
DER SHA-256 equals the pin (mismatch = hard failure — hostname checking
is subsumed by the pin, since the desktop's cert carries IP SANs). No pin
→ OkHttp's DEFAULT verification (standard CAs — the Cloudflare tunnel
path per R3 §4). Never a global trust-all; the pin overrides are
constructed per call. Reconnect logic does NOT live in Kotlin — the JS
manager owns it.

## §3 The connection manager (../../../mobile/src/link/connection.ts)

One source of truth, a four-state machine with a bounded probe ladder:

```
unpaired → probing → connected → offline ─(backoff 5s→10s→30s)→ probing…
   ↑__________ store empty at start · api() answered 401 (revoked) __________↑
```

- **Probe order** = the stored address list, in order (LAN first, tunnel
  later — the tunnel-ready addresses[] contract): GET /health per
  address, 3s timeout, pin applied when the address is LAN (a full https
  URL probes with standard verification).
- **Triggers:** app foreground (AppState), network change (NetInfo),
  manual retry (retryNow()), and the backoff timer while offline.
- **Exposes:** api() (a fetch-like over acute-net with Bearer + base URL
  + pin), sse() (the stream handle), adoptPairedHost() (pair-flow hands
  over a fresh pairing), unpair().
- **lastSeen** updates on every successful call — the host card's
  "seen 2h ago" and the desktop's device list stay honest.

**The auto-reconnect guarantee (the owner's zero-rerule):** the phone
stores token + certFP + addresses; the desktop persists its certificate
(device-link-cert.json, generated once) and its device tokens (SQLite
mobile_devices). A rebooted PC changes NOTHING the phone pinned or
stored — the next probe reconnects. Re-pairing is only ever for a
REVOKED token or a regenerated certificate.

## §4 The pairing flow (app/pairing.tsx + ../../../mobile/src/link/pair-flow.ts)

1. Scan the desktop's QR (the Devices tab's pair/start payload:
   {v:1, addrs[], port, certFP, machineId, pin, ttl, expiresAt}) — or
   type a manual entry: https://host:port (tunnel — pin-less, standard
   CA), host:port (LAN — TOFU at claim), or a bare PIN (re-pair against
   the stored host).
2. Confirm card: the address, the fingerprint ABOUT TO BE PINNED, the
   PIN. Pair → probe over TLS (pin from the QR) → POST
   /api/v1/mobile/pair/claim {pin, label: device model} → the response
   carries {deviceToken, deviceId, machine, certFP, addrs, port}.
3. Persist: token → SecureStore (Android Keystore); identity →
   AsyncStorage. NOTHING else is ever stored (test-asserted).
4. The failure ladder is typed and honest: unreachable (retry), tls
   (re-pair territory), wrong-pin (+ attemptsRemaining), window-closed
   (410), wrong-host (machineId mismatch), bad-response.

## §5 The feature layer (src/features/)

Pure-TS clients over the manager's api()/sse(), all unit-tested with
mocked transports:

- **approvals.ts** — the pending inbox + POST
  /approvals/:id/decision {decision: "approved"|"denied"} (the route's
  exact spellings). The destructive-never-always rule is honored
  client-side: v1 sends decision only, never remember.
- **sessions.ts** — list + transcript rehydrate (GET /sessions/:id's
  persisted event log) + the live stream state machine (POST
  /sessions/:id/messages/stream, frames rendered incrementally;
  backgrounding drops the stream and rehydrates on return — the R42
  guarantee that turns survive).
- **outbox.ts** — the offline queue: messages composed while offline land
  in AsyncStorage with per-session ordering, render as pending chips in
  the transcript, and flush in order the moment the link returns.

## §6 The design system ("quiet instrument")

The desktop's five themes (Nova Cream, Bento Blue, Midnight Lab, Sunset
Pop, Mono Stone) port 1:1 into tokens.ts — light + dark, system-follow +
manual. 8-pt grid; 15/13/11pt grotesque ladder + monospace for
commands/tool output; hairline borders; 12px-radius cards; NO shadows.
Motion: Reanimated springs (stiffness 180 / damping 22) everywhere —
press = 8% tint + 0.98 scale (no ripple), list entrances stagger 30ms,
streaming text fades in-up. Zero Material components anywhere (the custom
TabBar is presentational; navigation chrome is 100% ours).

## §7 The build (APK = GitHub Actions, never the sandbox)

.github/workflows/mobile.yml: every main push builds the DEBUG APK
(npm ci → expo prebuild -p android --clean → gradlew
:app:assembleDebug) as a workflow artifact; every v* tag also attaches
it to the release (the bounded/retrying upload-apk-asset.sh, which
polls for release.yml's parallel-run draft). applicationId
com.acutecode.companion is STABLE — side-by-side debug installs update
in place. minSdk 29 (Android 10 — the owner's preferred floor; nothing
in v1 needs 31). APK versionName == repo VERSION, versionCode ==
derived (major*10000+minor*100+patch) — both asserted by version:check
across the repo's 7 version files before any gradle minutes are spent.

## §8 What is deliberately NOT here

Read-write file access, diff editing, on-device processing of any kind —
removed from every tier by the owner's R106 ruling ("the mobile device is
only going to be a medium for visual feedback and getting input
feedback"). Push (FCM) rides the remote-access round with the owner's
Firebase credentials — the desktop-side publisher skeleton already ships
as a graceful no-op. The file browser, session search, and multi-host are
documented "Next" tiers in LINKING-PROTOCOL.md §4.
