<!-- last-reviewed: 2026-09-18 round-105 -->
<!-- status: planning ROUND 2 of 2 (decisions locked; the SSE-on-RN spike is
     the one implementation gate before code lands) -->
<!-- planning-round: 2 of N (Round 1: ANDROID-R1-ARCHITECTURE.md) -->

# The Android Companion — Round 2: the Decisions + the Linking Protocol

Round 105's SECOND planning round (the owner's multi-round directive).
Round 1 (ANDROID-R1-ARCHITECTURE.md) left ten explicit open questions;
this round resolves nine of them by reasoning over the codebase (the
tenth is a code spike — the one thing planning cannot settle). The
owner-facing communication documentation lives in
LINKING-PROTOCOL.md (the owner's "document the Android application
properly and thoroughly" ask).

## §1 The ten questions, resolved

1. **SSE on React Native — SPIKE FIRST (the one gated decision).**
   Order of attack: `react-native-sse` (XHR incremental reads — the
   maintained, dependency-light option) → a custom XHR reader if its
   event-shape fights us → a tiny OkHttp native module as the floor. The
   spike is a half-day against the sidecar's real SSE route with a
   keystore-paired token. **If all three legs fail**, the fallback
   architecture is already sound: SYNC send + transcript rehydrate
   (`GET /sessions/:id` events, the R42 persistence) with a 1–2 s poll
   while foregrounded — the phone loses per-delta streaming, keeps
   everything else (the desktop keeps its SSE either way). The stack
   decision does NOT flip on this: RN's win is the React/TS knowledge
   reuse + custom design system, not streaming alone.
2. **Push transport: FCM, ping-only payloads.** Decided on the
   round-105 evidence: the owner already runs ntfy for TASK notifications
   (the sandbox's notify.sh discipline), but an Android APP on ntfy means
   a foreground service (battery cost + a second thing to keep alive)
   while FCM gives OS-level wake for free. Payloads carry NO content
   (privacy + the 4KB limit): `{"type":"ping","host":machineId}` — the
   app fetches the real approval/notification over the LAN link. ntfy
   stays the documented self-hosted ALTERNATIVE for a no-Google device
   (the Settings page offers both; FCM is default).
3. **Workspace: standalone `mobile/`** (own lockfile, NOT in
   pnpm-workspace.yaml). Confirmed by the repo's own CI shape: the
   desktop pipeline runs `--frozen-lockfile` on the pnpm workspace; a
   second ecosystem (Expo's) inside it is churn risk for zero benefit.
   Types cross the boundary via a snapshot script + drift test (the
   TOOL_CATALOG pattern).
4. **TLS: mandatory self-signed + fingerprint pinning (TOFU).** The
   pairing QR carries the cert's SHA-256; the app pins it on first link
   and rejects any later mismatch (re-pair required — the honest
   response to a cert change). A plaintext-LAN opt-out is REFUSED: the
   device token would ride readable on any hostile LAN (coffee-shop
   class of risk), and the owner's Tailscale note covers the
   outside-LAN case without weakening the LAN case.
5. **Send: STREAM when the app is foregrounded, SYNC + rehydrate when
   it is not.** Foreground = the SSE stream (live deltas, the desktop
   chat experience); backgrounded/reconnect = POST the message, let the
   R42 persistence own the turn, rehydrate on next open. The composer
   optimistically renders its own message either way (the desktop's
   echo rule).
6. **Approval detail: widen the payload, don't widen the protocol.**
   The phone needs `toolCall` + `category` + the risk line + the
   session/project names — all of which the approval row already
   carries; the DIFF preview (for edit-class approvals) is the one gap
   and it ships in the "Next" tier (the diff renders from the payload,
   never by reading the file over the wire — the permission engine stays
   the single source of truth).
7. **Single-host in v1.** The linking model is ONE paired desktop per
   app install (the QR pairs the HOST, not an account). Multi-host is a
   Tier-2 list ("Home rig", "Laptop") — the storage shape (device rows
   keyed by machineId) already permits it; v1 just renders one.
8. **Keystore: generate + commit a DEBUG keystore now, wire the RELEASE
   keystore as base64 secrets** (`ANDROID_KEYSTORE_BASE64`,
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEYSTORE_ALIAS` +
   `ANDROID_KEYSTORE_ALIAS_PASSWORD`). The debug keystore in-repo lets
   every main-push APK be installable side-by-side immediately; the
   release signing lands with the first tagged build (the workflow
   refuses gracefully — debug artifact only — until the secrets exist,
   exactly how the desktop release workflow behaves before its first
   tag).
9. **Min API 31 (Android 12).** Justification: Android 12 is the
   Compose-era runtime floor the RN/Reanimated ecosystem tests against
   (Keystore attestations + the modern notification permissions are
   baseline), it covers ~85%+ of active devices in 2026, and the
   companion app has no legacy constraint. APK `versionName` MUST equal
   the repo VERSION (the workflow asserts it — the `pnpm version:check`
   pattern extended to the APK).
10. **Docs order: THIS document + LINKING-PROTOCOL.md now; the
    MOBILE-ARCHITECTURE.md deep-dive lands WITH the SSE spike results**
    (the spike's outcome shapes the stream-layer chapter — everything
    else in the architecture is already decided).

## §2 The implementation gate list (what must exist before `mobile/` code)

1. The SSE-on-RN spike (§1.1) — half a day, three-legged, with the sync
   fallback pre-designed.
2. Sidecar round (the roadmap's list): `ACUTE_HOST` opt-in bind,
   self-signed TLS + fingerprint endpoint, the multi-token bearer wall,
   `routes/mobile.ts` (`POST /pair/start`, `POST /pair/claim`),
   migration `mobile_devices`, the notification-bus FCM publisher — each
   behind its own agent-core tests, additive to the loopback-only
   default.
3. The `android-apk` GitHub Actions job (the Round 1 §7 outline):
   debug APK on every main push (artifact only), signed release APK on
   `v*` tags, both under `timeout-minutes: 30`, feeding the existing
   resumable release publisher. NEVER built in the sandbox — the
   owner's explicit rule.
4. The `mobile/` scaffold (Expo, the 5-theme token table ported 1:1,
   the "quiet instrument" design system: 8-pt grid, grotesque ladder,
   spring physics 180/22, press = 8% tint + 0.98 scale, no ripple, no
   Material anywhere).

## §3 What ships in the MVP (re-confirmed against the decisions)

Pairing (QR + manual fallback) · host card + connection status ·
projects · sessions + transcript + live stream (or sync rehydrate per
§1.5) · send/stop/queue · the approvals inbox + approve/deny (the killer
feature — works on open without push) · notification history · the 5
themes + dark/light. Push (FCM ping-only) and the read-only file
browser are "Next", not MVP — the MVP is fully useful against a LAN host
without any Google-services dependency.
