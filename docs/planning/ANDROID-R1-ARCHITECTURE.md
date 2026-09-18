<!-- status: planning (PLAN-ANDROID-R1, R105) — Round 2 resolves the open questions before any implementation -->
<!-- planning-round: 1 of N (the owner's multi-round directive; Round 2 pending) -->

# The Android Companion — Round 1 Architecture (PLAN-ANDROID-R1)

Round 105's first planning artifact for the owner's Android directive:
"a clean user interface… I don't want a bad ugly-looking user interface
or for you to rely on Material 3 expressive or such kinds of UI designs
at all. I want you to go with a modern-looking, minimalistic, clean,
animation-filled user interface… document the Android application
properly and thoroughly too, so that we know how the communication
between the Android app and the projects will work, how the linking will
work… Building the APK is the task for GitHub Actions."

Grounded read-only in the real code (verified, not assumed): the sidecar
is Fastify, binds `127.0.0.1` only, ephemeral port, bearer wall on every
route except `GET /health` with constant-time compare against a
per-spawn `ACUTE_TOKEN`; all routes under `/api/v1`; the SSE turn route
is `POST /sessions/:id/messages/stream` (R42 semantics — client
disconnect never aborts a turn, events persist to SQLite); approvals:
`GET /approvals?status=pending` + `POST /approvals/:id/decision`
`{decision, remember}` (destructive ops can never be "always"; only
interactive streamed turns wait); the notification bus publishes
`task_complete | task_failed | permission_request | subagent_*` →
SQLite + SSE + Web Push (VAPID, migration 0012); the frontend is React
18 + TS with a 5-theme token table (`themes.ts`: Nova Cream, Bento Blue,
Midnight Lab, Sunset Pop, Mono Stone); CI/release: bounded jobs
(`timeout-minutes: 30`), artifacts + resumable draft-release publisher
(`publish-github-release.sh`, `secrets.GITHUB_TOKEN`), tag-verified
versions.

## 1. Stack decision: React Native + Expo (custom design system, no component library)

- **(a) RN + Expo — RECOMMENDED.** The deciding facts: the frontend is
  React 18 + TS and the whole build system/agent skillset is
  React-shaped; the owner's directive is a *custom* minimal design
  language — RN imposes no Material anything (nothing to fight, unlike
  Compose), and Reanimated + gesture-handler is best-in-class for
  "animation-filled" custom UI. The `shared/` TS types
  (`StreamTurnEvent`'s union, `PermissionMode`, `ThinkingLevel`) are
  reusable nearly verbatim, and the desktop's fetch+`getReader`+
  `\n\n`-split SSE client pattern ports directly. Expo adds OTA updates
  (EAS Update on top of GH-Actions-built APKs — hotfix UI without
  rebuilds) and a sane dev-client workflow. **Known risk (spike for
  Round 2):** RN's fetch doesn't stream; SSE needs `react-native-sse`
  (XHR incremental reads) or a small OkHttp native module.
- **(b) Flutter** — rejected: clean minimal UIs are easy, but zero
  knowledge/type reuse and a second language/ecosystem for a solo-owner
  closed-source project.
- **(c) Kotlin + Compose** — rejected for v1: best native ceiling, but
  "NOT Material 3" in Compose means building a design system on bare
  foundations — the heaviest possible lift, with no TS reuse. Revisit
  only if RN's SSE/perf spikes fail.

## 2. Communication architecture (the owner's core doc ask)

**Phase 1 (MVP): direct LAN, phone → desktop sidecar. The same API the
desktop webview uses — `/api/v1` REST + SSE, unchanged in shape.**

- **Discovery:** desktop Settings → "Link a device" shows a QR
  containing `{host IPs, port, machineId (SHA-256 of TLS cert),
  one-time pairing PIN, ttl:120s}`. QR *is* the MVP discovery;
  mDNS/zeroconf (`_acute-code._tcp`) is a Tier-2 convenience for
  auto-reconnect. Manual IP entry as fallback.
- **Pairing/auth (the sidecar has NO multi-device story today — this is
  the mandatory addition):** phone scans QR → `POST /pair/claim {pin}`
  over the pinned cert → receives `{deviceToken, deviceId,
  machine {name, version}}`. New SQLite table `mobile_devices` (label,
  tokenHash, scopes, createdAt, lastSeenAt, revokedAt) managed from
  desktop Settings. The preHandler bearer wall extends: loopback shell
  token unchanged; device tokens compared via hash-lookup +
  constant-time compare. Revocation = delete row. Tokens stored in
  Android Keystore.
- **Transport security:** mobile-link mode binds `0.0.0.0` (opt-in
  setting, default OFF — loopback default preserved), self-signed TLS
  cert generated per machine next to `vapid.json`, fingerprint pinned by
  the app at pairing (TOFU). Token never rides plaintext. **No relay
  service is built.** Outside-LAN access = the owner runs
  Tailscale/WireGuard — same architecture, zero relay code (documented
  explicitly).
- **Session protocol:** while the app is open, it holds the *same* SSE
  stream the desktop does for live text-deltas/tool-calls; on reconnect
  it rehydrates from SQLite-persisted events (`GET /sessions/:id`
  events) — the R42 disconnect-safe design means this needs no new
  server machinery. Stop/queue via the existing `POST
  /sessions/:id/stop` and `/queue` routes.
- **Offline queueing:** outbound messages compose offline into a local
  outbox; delivered on reconnect (client-side only — the server's queue
  routes are for the *running* turn).
- **Push (Tier 2):** hook point already exists —
  `notification-bus.publish()` fans out to web-push today; add a mobile
  publisher. **Recommendation: FCM** (content-less "ping" payloads; app
  fetches details over LAN), with **ntfy as the no-Google alternative**
  (the owner already runs ntfy). Round 2 decides; FCM's requirement of a
  Firebase project + Play Services on device vs ntfy's
  foreground-service battery cost is the trade.

## 3. Linking model (what "linked" means concretely)

A link = **one paired desktop host**. Over that link: project list sync
(snapshot cached locally for offline browsing via `GET /projects`),
session mirroring (list + full transcript rehydrate + live SSE), agent
control (send message, stop, queue), **remote approvals** (below),
notification history. File access: **read-only in Tier 2**
(`GET /projects/:id/tree`, `/file`); read-write deliberately deferred —
and when it comes, edits should flow *through the agent* (as messages),
never direct FS writes, so the file-ledger/permission engine stays the
single source of truth.

## 4. Remote approvals — the killer feature

The desktop agent hits a permission gate → approval row +
`permission_request` notification already fire → Tier-2 push wakes the
phone → Approvals inbox shows the row (`toolCall`, `category`, reason,
session/project) → **Approve / Deny** posts `POST
/approvals/:id/decision` → `resolvePendingApproval` wakes the waiting
tool call on the still-open desktop stream. Because R42 means turns
survive closed desktop windows, the phone becomes a genuine remote brake
pedal, not a mirror. `expiresAt` drives stale-card UI; the
destructive-never-"always" hard rule is honored client-side too. **This
ships in MVP** (works on-demand without push — the inbox badge +
notification history surface it whenever the app opens).

## 5. Feature tiers

- **MVP:** pairing (QR), host card + connection status, projects,
  sessions + transcript + live SSE, send/stop/queue, approvals inbox +
  decide, notification history, 5 themes + dark/light, Tailscale note in
  docs.
- **Next:** push (FCM or ntfy), read-only file browser, session search,
  outbound offline outbox, mDNS auto-reconnect, multi-host.
- **Future:** diff view on edit-approvals, remote agent/session
  creation, terminal tail, scoped device permissions (approve-only
  tokens), computer-use monitor.

## 6. Screen inventory + UI direction

**Screens (8):** Pairing (camera + manual fallback) · Home (host status,
pending-approvals hero, active sessions, projects) · Projects · Project
detail · Session (transcript + composer, streaming) · Approvals inbox +
detail · Notifications · Settings/Linking.

**Design language — "quiet instrument":** 8-pt grid; 15/13/11pt grotesque
type ladder (Inter-class) + JetBrains Mono for commands/tool output;
hairline 1px borders, 12px-radius soft cards, no shadows — matching the
desktop's flat token aesthetic. **The 5 desktop themes port 1:1** — the
`ThemeColors` hex tokens (Nova Cream `#FF6B2C`/`#FFFBF0`/`#242426` etc.)
become the app's single theme table, light+dark, system-follow +
manual. **Motion, named:** shared-element transition Project→Session
(Reanimated layout animations); per-delta fade-in-up on streaming text
(mirrors desktop chat); 30ms list stagger; spring physics ~stiffness
180/damping 22 everywhere (no linear easing); approval card slide-up +
haptic on decision; press state = 8% bg tint + 0.98 scale (no ripple).
Zero Material components visible.

## 7. Repo + GitHub Actions (APK build is CI's job, never the sandbox)

**Layout: `mobile/` in the monorepo, standalone package (own lockfile,
NOT in pnpm-workspace.yaml)** — keeps desktop `--frozen-lockfile` CI
untouched. Types shared via a snapshot script + **drift test** (the
established TOOL_CATALOG pattern). Docs:
`docs/architecture/mobile/` (MOBILE-ARCHITECTURE.md,
LINKING-PROTOCOL.md — the owner's thorough-documentation ask, authored
in Round 2).

**Workflow:** extend `release.yml` with an `android-apk` job —
`ubuntu-latest`, `timeout-minutes: 30`, `setup-java` (temurin) + gradle
cache, build debug APK on every main push/PR (artifact only) and signed
release APK on `v*` tags (keystore from base64 secrets:
`ANDROID_KEYSTORE_BASE64` + passwords), `upload-artifact@v4`, then add
the APK to the existing resumable `publish-github-release.sh` asset list
+ tag-verify glob — the draft-release/publish pattern stays identical.
Extend `pnpm version:check` to assert APK `versionName` == repo VERSION.

## 8. Sidecar change list (minimal, one future round)

1. `ACUTE_HOST`/mobile-link setting: opt-in `0.0.0.0` bind + per-machine
   self-signed TLS (+ fingerprint endpoint).
2. Multi-token bearer wall (device tokens, constant-time, revocable).
3. `routes/mobile.ts`: `POST /pair/start` (PIN+QR payload, TTL) +
   `POST /pair/claim` (unauthenticated, single-use, rate-limited);
   optional aggregate `GET /mobile/summary`.
4. Notification-bus mobile fan-out (Tier 2).
5. Migration 0039 `mobile_devices`. All following the routes/ module
   pattern + RouteContext, with agent-core tests.

## 9. OPEN QUESTIONS for Round 2 (explicit — the multi-round directive)

1. **SSE on RN:** spike `react-native-sse` vs custom XHR reader vs tiny
   OkHttp module — gate on this before committing to RN.
2. **Push transport:** FCM (+ Firebase project, google-services.json in
   closed repo, Play-Services dependency) vs ntfy (self-hosted topic +
   foreground service) vs MVP-without-push. Lean: FCM ping-only.
3. **Workspace:** standalone `mobile/` (recommended) vs pnpm workspace
   member (node-linker=hoisted churn risk)?
4. **TLS UX:** mandatory self-signed + pinning (recommended) vs
   plaintext-LAN opt-out?
5. **Sync send vs stream send** on mobile (stream gives live deltas but
   holds a connection; sync + rehydrate is simpler offline).
6. **Approval detail richness:** does the phone need command
   args/risk/diff context beyond today's `ApprovalRow.toolCall`? (May
   need a small payload widening.)
7. **Multi-host in v1** or single-host first?
8. **Keystore generation + secret storage now** vs debug-signed releases
   initially?
9. **Min Android API** (lean 31+), and APK versionName alignment with
   repo VERSION.
10. **Docs authoring order** in Round 2: LINKING-PROTOCOL.md
    (owner-facing) before or after the SSE spike resolves Q1?

**Round 2 should:** resolve Q1 (spike), lock the push decision, turn
§2–§4 into the owner-facing LINKING-PROTOCOL.md draft, and produce the
full workflow YAML outline + screen-by-screen spec.
