<!-- last-reviewed: 2026-09-18 round-106 -->
<!-- status: LOCKED (the owner's R106 review of the R105 planning corpus —
     every ruling below is the owner's own words resolved into decisions;
     implementation follows THIS round) -->
<!-- planning-round: 3 of N (R1 architecture · R2 decisions · R3 owner rulings) -->

# The Android Companion — Round 3: the Owner's Rulings (R106)

The owner reviewed the R105 planning corpus (R1 architecture, R2
decisions, LINKING-PROTOCOL.md) and ruled on every open thread. This
document is the binding record: where R2 said one thing and the owner's
R106 message says another, THE OWNER WINS, and the affected sections of
R2/LINKING-PROTOCOL.md are amended here (LINKING-PROTOCOL.md is updated
in place to match — it is the owner-facing contract and must never
disagree with this file).

## §1 The ten rulings

1. **Anywhere-access is THE goal — LAN is the v1 stepping stone, not the
   destination.** The owner rejected the R2 "no relay, run Tailscale"
   stance outright: *"I don't need a local-only network option. I want
   one that can be used from anywhere… my PC is at home and he goes out
   somewhere. He can access it from out somewhere too."* The end-state
   is a **Cloudflare Tunnel**-based remote path (the owner named
   Cloudflare) with an **easy, guided setup**. Sequencing per the owner:
   **v1 ships with the LAN link**; **the anywhere-access round is the
   immediate next task**. The full design — trust model over the
   tunnel, dual-transport pairing, the guided setup flow — lives in
   CLOUDFLARE-REMOTE-ACCESS.md, and the v1 protocol shapes are built
   TUNNEL-READY now (§1.4) so the next round is additive, not a rework.
2. **Auto-reconnect is mandatory, zero re-setup.** *"If my PC has been
   turned off, turned on again, and opened up again… I don't need to
   set up the things again. It will automatically be set up."* The phone
   keeps its link across host restarts: the per-machine TLS certificate
   is generated ONCE and persisted (the TOFU pin survives restarts),
   device tokens live in the host's SQLite (they survive restarts), and
   the phone retries its stored address list with backoff (LAN first,
   tunnel later) whenever the app is foregrounded or the network
   changes. Re-pairing is only ever needed for a REVOKED token or a
   genuinely changed certificate.
3. **The paired link is long-lived — "usable for at least a month or
   so."** The owner confirmed the 120-second PIN window (single-use,
   short TTL is right for the pairing HANDSHAKE) and raised the SESSION
   horizon: the device token must not nag for re-pairing. Decision:
   **device tokens carry NO expiry by default** — `lastSeenAt` is
   tracked and shown (stale = dimmed in the device list), revocation is
   the owner's manual act, and a configurable "expire after N days
   unused" guard ships OFF (v1: display-only staleness). The phone
   stores exactly what R2 said — token + cert fingerprint + addresses —
   nothing more.
4. **Revoke and delete tokens: confirmed.** The Linked-devices list
   (label, last seen, revoke) ships in v1; revocation deletes the row
   and the phone's next request falls back to the pairing screen.
5. **The mobile app is a VIEW + INPUT medium. Nothing else.** The owner
   overruled the R2 §6 "widen the approval payload" lean and the
   "Deliberately later" tier's read-write/diff ideas: *"the mobile
   device is only going to be a medium for visual feedback and getting
   input feedback. Nothing will be processed on the mobile. No files
   will be changed on the mobile or anything like that. Everything will
   be processed on the PC."* Concretely: (a) the approval inbox renders
   the EXISTING approval row shape (`toolCall`, `category`, risk line,
   session/project names) — no payload widening, no diff preview tier;
   (b) read-write file access and diff editing are REMOVED from every
   future tier (they were never the phone's job); (c) the phone's
   feature ceiling is: see results, see progress, approve/deny, send
   messages, stop/queue. The "future flexibility" the owner wants
   (below) grows WITHIN that ceiling — more surfaces to observe and
   more knobs to steer, never processing on the device.
6. **The 8 screens are the v1 surface; the capability model must grow.**
   *"You showed a total of eight options, which are good, but I want
   much more flexibility, much more capabilities and such in the
   future."* The phone's navigation and the device-token `scopes` field
   are designed as a capability REGISTRY (v1 grants one implicit
   all-view scope; later tokens can be scoped — approve-only, specific
   projects) so new capabilities are additive rows, not protocol
   surgery. The wire protocol stays versioned (`v:1` in the QR payload).
7. **Debug APK only — no release signing yet.** The owner: *"For now,
   we are going to work on the debug APK, so there is no need to do a
   release signed APK."* The android-apk workflow builds the debug APK
   on every main push (artifact) and attaches THE DEBUG APK to `v*`
   release pages; the R2 §1.8 release-keystore secret wiring stays
   designed-but-dormant (the job refuses gracefully exactly as the
   desktop release did before its first secrets — no signing happens
   until the owner asks).
8. **minSdk: Android 10 (API 29).** The owner preferred Android 10 if
   nothing is lost. Checked against the v1 feature set — nothing is:
   Android Keystore ≥ API 23 ✓, custom TLS pinning ≥ 24 ✓, RN +
   Reanimated floor 24 ✓, `POST_NOTIFICATIONS` is 33+ (a runtime ask
   there; auto-granted legacy below — the push tier degrades, v1 MVP
   needs no push) ✓. **minSdkVersion 29, targetSdk/compileSdk latest.**
   If CI surfaces an ecosystem floor above 29, the fallback is 31 —
   assert in the workflow, not in prose.
9. **SSE-on-RN: proceed as planned** (react-native-sse leg first, OkHttp
   floor as the pinning carrier), per the owner's *"that's okay if
   everything is handled properly, correct, well managed, well
   considered, and well planned."* The R106 implementation resolves the
   gate directly: because v1 mandates TOFU pinning on a self-signed
   cert, the networking floor lands as ONE local Expo module
   (`acute-net`, OkHttp) that carries BOTH the pinned-TLS fetch and the
   SSE stream — the R2 spike question is answered by building the floor
   that was already named, not by gambling on XHR behavior we cannot
   pin.
10. **FCM: approved, credentials owner-provided when needed.** The owner
    accepts Firebase Cloud Messaging as the push transport and will
    supply the Firebase (+ Cloudflare) credentials for setup. v1 lands
    the desktop-side publisher skeleton (notification-bus fan-out, ping-
    only payload, `fcm.json` config shape) as a graceful NO-OP until
    the credentials arrive; the phone-side FCM wiring rides the
    anywhere-access round with them. ntfy stays the documented
    self-hosted alternative.

## §2 Confirmed unchanged from R2 (the owner's explicit OK)

- **Monorepo shape:** a standalone `mobile/` workspace inside THIS
  repository (own lockfile, outside pnpm-workspace.yaml) — *"that seems
  like a good option."*
- **TLS + certificate pinning (TOFU):** *"seems proper too… no issues
  there either."*
- **SSE transport for RN** (per §1.9 above), **single-host v1** (*"for
  the current time being… only a single-host system"*, multi-host is a
  documented future), **stream-foreground / sync-rehydrate-background
  send semantics** (the owner delegated the details: *"you can handle
  those things properly… by yourself"* — the R2 §1.5 design stands).
- **The GitHub Actions APK pipeline** — *"seems proper and well
  handled."* Never built in the sandbox; `timeout-minutes: 30`; debug
  artifacts on main; APK attached to the tagged release.
- **The linking flow itself** — QR + PIN + TLS + Keystore token — the
  owner's own words: *"The linking flow was proper… the token is in the
  key store and everything like that. That seems like a very good
  option."*

## §3 What this round builds (R106 — the implementation wave)

1. **Sidecar mobile-link round** (agent-core): `ACUTE_HOST` opt-in bind,
   per-machine self-signed cert (generated once, persisted next to
   `vapid.json`, fingerprint endpoint), the multi-token bearer wall,
   `routes/mobile.ts` (`pair/start` · `pair/claim` · device list ·
   revoke), migration `0040_mobile_devices`, the notification-bus FCM
   no-op publisher, the auto-reconnect substrate (stable cert + token
   persistence). Loopback-only default untouched.
2. **Desktop linking UI** (frontend): Settings → Devices tab — the
   allow-links toggle, "Link a device" (QR + PIN + live 120s countdown
   + manual fallback text), the linked-devices list with revoke.
3. **The `acute` CLI** (`cli/`, per CLI-DESIGN.md M1+M2): attach-or-
   spawn, one-shot `-p`, REPL, sessions/models/status, `--mode json`,
   zero runtime deps, its own tests.
4. **The mobile app v1** (`mobile/`, per R1 §6 + these rulings): Expo
   RN, minSdk 29, the `acute-net` OkHttp pinning/SSE module, the
   connection manager with auto-reconnect, pairing (QR + manual),
   host card, projects, sessions + transcript + live stream, composer
   (send/stop/queue + outbox), approvals inbox + decide, notification
   history, the five themes + dark/light, the "quiet instrument" motion
   language. No Material anywhere.
5. **CI:** the `android-apk` job (debug APK on main; APK on the tagged
   release), version alignment (APK `versionName` == repo VERSION).
6. **Docs:** LINKING-PROTOCOL.md updated to THIS file's rulings;
   MOBILE-ARCHITECTURE.md (the implementation deep-dive);
   CLOUDFLARE-REMOTE-ACCESS.md (the anywhere-access design — the NEXT
   task's contract); the CLI user doc.

## §4 Tunnel-ready-now checklist (what v1 MUST NOT break for §1.1)

- The pairing payload carries `addresses[]` (an ordered list: LAN
  first, a tunnel URL later) — never a single `host` field.
- The phone's transport layer accepts BOTH pinned-self-signed https
  (LAN) and standard-CA https (the tunnel hostname) — pinning applies
  only where a fingerprint was TOFU'd.
- Manual pairing accepts a full URL (not just `ip:port`) so a
  quick-tunnel URL can be typed TODAY — the anywhere path is usable
  manually before the guided round lands.
- Device tokens are transport-agnostic: the same token authenticates
  over LAN and over the tunnel (the wall hashes the token, not the
  source address).
