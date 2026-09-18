<!-- last-reviewed: 2026-09-18 round-105 -->
<!-- status: the owner-facing LINKING + COMMUNICATION contract for the
     Android companion (the owner's "document the Android application
     properly and thoroughly" ask). Planning-stage: the sidecar endpoints
     named here land in the mobile-link round; the protocol itself is the
     stable contract both ends build against. -->

# LINKING-PROTOCOL.md — how the Android app talks to ACUTE-CODE

The owner-facing documentation of the linking, communication, and
functionality contract between the Android companion app and the
desktop projects. Written in plain terms first, precise terms second —
this is the document to read BEFORE reading any mobile code.

## §1 The one-sentence version

The phone is a REMOTE CONTROL for the desktop agent, not a copy of it:
it links to ONE desktop machine over your LAN (or your VPN), speaks the
exact same API the desktop window speaks, and every permission the
agent asks for can be approved or denied from your pocket.

## §2 Linking — how a phone and a desktop become paired

**The desktop owns the relationship; the phone proves itself once.**

1. On the desktop: Settings → "Link a device". The sidecar (the agent's
   local server) generates a one-time pairing PIN valid for 120 seconds
   and shows a QR code containing: the desktop's LAN address(es) + port,
   the machine's identity fingerprint (the SHA-256 of its per-machine
   TLS certificate), and the PIN.
2. On the phone: scan the QR (or type the address + PIN by hand — the
   fallback). The phone calls the desktop's `pair/claim` endpoint OVER
   THAT CERTIFICATE and receives a **device token** — a long random
   secret stored in the Android Keystore, never written to a file.
3. From then on the phone authenticates every request with that token
   (the same bearer-token pattern the desktop window uses — but per
   device, revocable individually).
4. The desktop's Settings → "Linked devices" lists every paired phone
   (label, last seen) with a REVOKE button — revocation deletes the
   token row; the phone's next request is rejected and it falls back to
   the pairing screen. Nothing else on the phone needs cleanup.

**What linking is NOT:** there is no account, no cloud, no relay
service. The link is your LAN. Outside your LAN, run Tailscale or
WireGuard — the phone links to the VPN address exactly the same way
(the QR just carries that address instead). The app never phones home.

**Transport security:** every request rides TLS on the desktop's
self-signed certificate. The phone PINNED the certificate's fingerprint
at pairing time (trust-on-first-use); if the certificate ever changes,
the phone refuses to connect and asks you to re-pair — the honest
response to a machine swap or an interception attempt.

## §3 Communication — the wire protocol

The phone speaks the desktop's existing `/api/v1` HTTP API — the SAME
routes, the SAME shapes, the SAME streaming protocol the desktop window
uses. Nothing about the desktop changes shape for the phone.

| What the phone does | How |
|---|---|
| List projects & sessions | `GET /api/v1/projects`, `GET /api/v1/sessions?projectId=…` |
| Open a session's transcript | `GET /api/v1/sessions/:id` (the persisted event log — complete even if the phone was offline all day) |
| Send a message | `POST /api/v1/sessions/:id/messages` (or the stream variant below) |
| Watch the agent work LIVE | `POST /api/v1/sessions/:id/messages/stream` — the same SSE event stream the desktop renders (text deltas, tool calls, thinking, retry heartbeats — including the R105-C `rateLimitReason` field) |
| Stop a running turn | `POST /api/v1/sessions/:id/stop` |
| Queue a message behind the running turn | `POST /api/v1/sessions/:id/queue` |
| See pending approvals | `GET /api/v1/approvals?status=pending` |
| **Approve / deny from the pocket** | `POST /api/v1/approvals/:id/decision` `{decision: "approve"\|"deny", remember: …}` |
| Notification history | the notification rows the sidecar already persists |

**The streaming rule:** while the app is open it holds the live SSE
stream (same as the desktop). When it reconnects or was backgrounded,
it does not miss anything — the sidecar persists every event as it
happens (the turn SURVIVES a closed window by design), so the phone
rehydrates the full transcript and continues from the truth. Messages
composed offline sit in the phone's outbox and post on reconnect.

**Push notifications (the "Next" tier):** a push carries NO content —
just a ping ("something needs you; ask your desktop"). The app then
fetches the real approval/notification over the LAN link. The desktop's
existing notification bus (which already powers Task notifications and
web-push) gains one more destination.

## §4 Functionality — what the phone can do, tier by tier

**MVP (the remote brake pedal + the monitor):**
- Projects & sessions list, full transcripts, LIVE streaming chat.
- Send / stop / queue messages.
- The approvals inbox: every permission the agent requests (command
  runs, file edits, destructive ops) appears with its tool, category,
  and risk line — Approve or Deny wakes the waiting agent on the
  desktop immediately. A turn that finished while you were away is
  readable in full; one that is waiting on you is one tap from
  proceeding. (Destructive operations can never be pinned "always" —
  the desktop enforces it; the phone honors the same rule client-side.)
- Notification history, host status, the five desktop themes +
  dark/light.

**Next tier:** push (FCM ping-only, ntfy as the no-Google option), a
read-only file browser (project tree + file reads through the agent's
permission-checked routes), session search, offline outbox sync, auto-
reconnect via mDNS, multiple linked hosts.

**Deliberately later:** read-WRITE file access (edits should flow
THROUGH the agent as messages — the permission engine stays the single
source of truth; the phone never writes the FS directly), diff
previews on edit approvals, remote agent/session creation, terminal
tail, scoped approve-only tokens, the computer-use monitor.

## §5 The trust model, stated plainly

- The desktop's server binds to `127.0.0.1` by default and STAYS that
  way until you flip "Allow device links" — then it binds the LAN with
  TLS and every route (except health + the one-time pairing endpoint)
  requires a valid token: the desktop window's own token, or one of
  your paired phones'.
- The pairing endpoint is single-use, PIN-gated, 120-second-TTL, and
  rate-limited — a LAN attacker who misses the window gets nothing.
- A revoked phone knows nothing that still works: its token is gone
  from the table; its Keystore secret is dead weight.
- The phone stores: its device token (Keystore), the host's address +
  cert fingerprint, cached project/session snapshots for offline
  reading. It never stores provider API keys — those live ONLY in the
  desktop's OS keyring, exactly as today. The phone cannot spend your
  model credits directly; it can only ask the desktop's agent to.

## §6 Where the APK comes from

GitHub Actions, per the owner's rule — never built on a local machine.
Every push to main produces a debug APK (installable side-by-side,
debug-signed) as a workflow artifact; every `v*` tag produces the
signed release APK attached to the same GitHub Release that carries
the desktop bundles — one release page, every platform, the same
version number asserted against the repo's VERSION.
