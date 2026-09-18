<!-- last-reviewed: 2026-09-18 round-106 -->
<!-- status: the owner-facing LINKING + COMMUNICATION contract for the
     Android companion (the owner's "document the Android application
     properly and thoroughly" ask). R106: updated to the owner's R3
     rulings (ANDROID-R3-OWNER-RULINGS.md) — anywhere-access is the
     goal, the phone is a view+input medium, tokens are long-lived,
     auto-reconnect is mandatory. The sidecar endpoints named here land
     in the R106 mobile-link round; the protocol itself is the stable
     contract both ends build against. -->

# LINKING-PROTOCOL.md — how the Android app talks to ACUTE-CODE

The owner-facing documentation of the linking, communication, and
functionality contract between the Android companion app and the
desktop projects. Written in plain terms first, precise terms second —
this is the document to read BEFORE reading any mobile code.

## §1 The one-sentence version

The phone is a REMOTE CONTROL for the desktop agent, not a copy of it:
it links to ONE desktop machine — over your LAN today, over the
internet (Cloudflare Tunnel) as the very next step — speaks the exact
same API the desktop window speaks, and every permission the agent
asks for can be approved or denied from your pocket.

## §2 Linking — how a phone and a desktop become paired

**The desktop owns the relationship; the phone proves itself once.**

1. On the desktop: Settings → "Link a device". The sidecar (the agent's
   local server) generates a one-time pairing PIN valid for 120 seconds
   and shows a QR code containing: the desktop's address list (LAN
   address + port today; a Cloudflare-tunnel URL joins the same list in
   the remote-access round), the machine's identity fingerprint (the
   SHA-256 of its per-machine TLS certificate), and the PIN.
2. On the phone: scan the QR (or type the address + PIN by hand — the
   fallback that ALSO works from anywhere, for a tunnel URL). The phone
   calls the desktop's `pair/claim` endpoint OVER THAT CERTIFICATE and
   receives a **device token** — a long random secret stored in the
   Android Keystore, never written to a file.
3. From then on the phone authenticates every request with that token
   (the same bearer-token pattern the desktop window uses — but per
   device, revocable individually).
4. The desktop's Settings → "Linked devices" lists every paired phone
   (label, last seen) with a REVOKE button — revocation deletes the
   token row; the phone's next request is rejected and it falls back to
   the pairing screen. Nothing else on the phone needs cleanup.

**The link is long-lived (the owner's ruling):** the 120-second window
belongs to the PIN alone. Once paired, the device token does NOT
expire — it stays valid for months, across desktop restarts, updates,
and network changes, until you revoke it. "Last seen" is shown next to
each device; staleness is information, not a lockout.

**Auto-reconnect — zero re-setup (the owner's ruling):** the phone
keeps its token, the pinned fingerprint, and the address list. If the
desktop is off, the phone simply says "host offline — retrying" and
keeps probing (fast at first, then calmly). The desktop coming back
changes nothing that matters: the certificate is the SAME (generated
once, persisted), the token is the SAME (stored in the desktop's
database), so the link resumes on its own. You only ever re-pair after
revoking a device or regenerating the certificate.

**What linking is NOT:** there is no account and no cloud of OURS. v1
ships the LAN link; internet-from-anywhere arrives as the immediate
next step via Cloudflare Tunnel (§7 — the design is locked in
docs/planning/CLOUDFLARE-REMOTE-ACCESS.md, and every v1 protocol shape
is already tunnel-shaped so nothing gets reworked). The app never
phones home.

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
fetches the real approval/notification over the link. The desktop's
existing notification bus (which already powers Task notifications and
web-push) gains one more destination: FCM (the owner has approved it;
credentials arrive with the remote-access round — the desktop-side
publisher ships in v1 as a dormant no-op until then).

## §4 Functionality — the phone is a VIEW + INPUT medium (the owner's ruling)

**The ceiling, stated once:** nothing is processed on the phone and no
file is ever changed by the phone. The desktop agent does ALL the work;
the phone shows results and progress, and gives the agent input. Every
future capability grows INSIDE that ceiling — more to observe, more to
steer, never processing on the device.

**MVP (the remote brake pedal + the monitor):**
- Projects & sessions list, full transcripts, LIVE streaming chat.
- Send / stop / queue messages.
- The approvals inbox: every permission the agent requests (command
  runs, file edits, destructive ops) appears with its tool, category,
  and risk line — exactly the approval row the desktop already carries,
  no wider — Approve or Deny wakes the waiting agent on the desktop
  immediately. A turn that finished while you were away is readable in
  full; one that is waiting on you is one tap from proceeding.
  (Destructive operations can never be pinned "always" — the desktop
  enforces it; the phone honors the same rule client-side.)
- Notification history, host status, the five desktop themes +
  dark/light.

**Next tier:** push (FCM ping-only, ntfy as the no-Google option), a
read-only file browser (project tree + file reads through the agent's
permission-checked routes), session search, offline outbox sync,
multi-host, remote access via Cloudflare Tunnel (§7).

**Future, within the ceiling:** remote agent/session creation, terminal
tail (watch, not type), scoped approve-only tokens, the computer-use
monitor, richer capability scopes on device tokens.

**Deliberately never:** writing or editing files or diffs from the
phone — edits flow THROUGH the agent as messages on the desktop, where
the permission engine stays the single source of truth. The phone never
touches the filesystem; it is the remote's screen and its two buttons.

## §5 The trust model, stated plainly

- The desktop's server binds to `127.0.0.1` by default and STAYS that
  way until you flip "Allow device links" — then it binds the LAN with
  TLS and every route (except health + the one-time pairing endpoint)
  requires a valid token: the desktop window's own token, or one of
  your paired phones'.
- The pairing endpoint is single-use, PIN-gated, 120-second-TTL, and
  rate-limited — an attacker who misses the window gets nothing. The
  PAIRED token, by contrast, is long-lived (months; §2) — it is a
  member of the household, not a visitor's badge.
- A revoked phone knows nothing that still works: its token is gone
  from the table; its Keystore secret is dead weight.
- The phone stores: its device token (Keystore), the host's addresses +
  cert fingerprint, cached project/session snapshots for offline
  reading. It never stores provider API keys — those live ONLY in the
  desktop's OS keyring, exactly as today. The phone cannot spend your
  model credits directly; it can only ask the desktop's agent to.
- Tokens are transport-agnostic: the same token authenticates over the
  LAN, over a VPN, and over the Cloudflare tunnel (§7) — the wall
  verifies the secret, never the source address.

## §6 Where the APK comes from

GitHub Actions, per the owner's rule — never built on a local machine.
Every push to main produces a DEBUG APK (installable side-by-side,
debug-signed — the owner's R106 ruling: debug is the artifact for now,
no release signing) as a workflow artifact; every `v*` tag attaches the
same debug APK to the GitHub Release that carries the desktop bundles —
one release page, every platform, the same version number asserted
against the repo's VERSION. Release signing stays designed-but-dormant
until the owner asks for it.

## §7 Remote access — anywhere, not just the LAN (the roadmap)

The v1 link rides your LAN. The next round adds **Cloudflare Tunnel**:
the desktop keeps one outbound connection to Cloudflare's free edge —
no open ports, no public IP, no VPN app on the phone — and the phone
reaches the SAME sidecar, with the SAME device token, from any network
on earth. The full design (trust model over the tunnel, auto-reconnect
across both transports, the guided setup) is locked in
`docs/planning/CLOUDFLARE-REMOTE-ACCESS.md`.

**Want a taste TODAY, manually?** The v1 phone already accepts a full
URL in manual pairing, so the quick-tunnel recipe works against the v1
sidecar (on the desktop, once `cloudflared` is installed):

```
cloudflared tunnel --url https://localhost:<sidecar-port>
# → prints https://<random>.trycloudflare.com
```

Type that URL + the current pairing PIN into the phone's manual
pairing screen — you are linked from anywhere. The random URL changes
when the daemon restarts (Cloudflare's design — the guided round's
named-tunnel mode makes it stable); the phone's manual field accepts
the new one, and your token never changes.
