<!-- last-reviewed: 2026-09-18 round-106 -->
<!-- status: DESIGN LOCKED (the owner's R106 directive: anywhere-access is
     the goal; v1 ships LAN and THIS design is the immediate-next task's
     contract — built tunnel-ready now, guided-setup later) -->

# CLOUDFLARE-REMOTE-ACCESS.md — ACUTE-CODE from anywhere

The owner's ruling (R106): *"I am hoping for the link functionality to
work from anywhere. The user can work on it from anywhere, from any
device he wants. For example his PC is at home and he goes out
somewhere. He can access it from out somewhere too… maybe we can
utilize some services from Cloudflare… I would like you to make the
overall Cloudflare system quite good and easy to set up."*

This is the design for that. v1 (R106) ships the LAN link; the
anywhere-access round that follows builds exactly what is specified
here — nothing in v1's protocol shapes will need rework (the
ANDROID-R3-OWNER-RULINGS.md §4 checklist is the guarantee).

## §1 The one-sentence version

The desktop keeps ONE outbound connection to Cloudflare's edge — no
open ports, no public IP, no VPN app on the phone — and the phone
reaches the exact same sidecar through it from any network on earth,
authenticating with the same device token it already holds.

## §2 Why Cloudflare Tunnel (and not the alternatives)

| Option | Verdict | Why |
|---|---|---|
| **Cloudflare Tunnel** | ✅ THE pick | Free; outbound-only from the desktop (no ports, no router changes, works behind CGNAT/carrier NAT); the phone needs NO app/VPN/account — plain HTTPS to a hostname; survives restrictive networks (everything speaks 443 to Cloudflare); the owner already named it. |
| Router port-forward + own domain | ❌ | Exposes the home network, dynamic-DNS churn, ISP CGNAT often makes it impossible. |
| Tailscale/WireGuard on the phone | ❌ (as the answer) | Works, but demands a second app + an always-on VPN profile on the phone and an account — the owner's R106 message explicitly moved past the R2 "run Tailscale" stance. (Still a valid personal choice; documented as an alternative, never the built path.) |
| A relay we host | ❌ | Operating cost + a trust anchor we would rather not own. The tunnel's edge is transport-only — the device TOKEN is still the only credential that matters. |

## §3 The architecture

```
      HOME (no open ports)                      ANYWHERE
┌───────────────────────────────┐   ┌───────────────────────────┐
│ desktop                       │   │ phone                     │
│ ┌──────────────┐              │   │                           │
│ │ agent-core   │  https*      │   │  acute-net (OkHttp)       │
│ │ sidecar      │◄─────────────┼───┼─► https://acute.example…  │
│ │ (token wall) │  loopback    │   │  (standard CA verification│
│ └──────▲───────┘              │   │   + Bearer device token)  │
│        │ same routes          │   └───────────────────────────┘
│ ┌──────┴───────┐  outbound-   │
│ │ cloudflared  │──only──────► │───► Cloudflare edge (TLS term,
│ │ (free daemon)│   443        │    global anycast, optional
│ └──────────────┘              │    Access policy in front)
└───────────────────────────────┘

  * cloudflared's origin is the sidecar's own TLS listener with the
    self-signed cert (noTLSVerify — the connection never leaves the
    machine; the edge re-encrypts toward the phone with a public cert)
```

Two transports, ONE sidecar, ONE token wall:

- **LAN direct** (v1): phone → `https://<lan-ip>:<port>` — self-signed
  cert, TOFU-pinned by fingerprint (the QR carries the SHA-256).
- **Tunnel** (next round): phone → `https://<tunnel-hostname>` — a
  standard publicly-CA-signed certificate (the phone verifies it
  normally; no pin applies), and behind the edge the SAME routes, the
  SAME bearer wall. The device token is transport-agnostic by design
  (the wall hashes the token, never the source address — R3 §4).

**Pairing works from anywhere too:** the manual pairing path accepts a
URL — so a phone that is NOT on the home LAN can pair by typing the
tunnel hostname + the current PIN. (The QR remains the LAN luxury; the
URL + PIN is the anywhere equivalent.)

## §4 The trust model over the tunnel, stated plainly

- **Transport:** Cloudflare's edge presents a real publicly-trusted
  certificate — the phone's standard verification applies. The
  edge→desktop leg is inside cloudflared's own encrypted connection.
  The self-signed pin does NOT apply on this path (there is nothing to
  pin — the desktop's cert is not the one presented); the phone pins
  only what it TOFU'd on the LAN path, and uses normal verification on
  `*.cfargotunnel.com` / the owner's hostname.
- **Authentication:** the device-token Bearer wall — identical on both
  transports. An attacker who reaches the tunnel hostname without a
  token gets exactly what an attacker on the LAN gets: `/health`
  metadata and a 401.
- **Optional belt-and-suspenders:** a Cloudflare **Access** policy
  (email OTP / identity provider) can sit in front of the hostname so
  even token-less scanners never see the sidecar. Off by default; one
  toggle in Cloudflare's dashboard, documented in the setup guide.
- **What Cloudflare can see:** transport metadata (that the phone and
  the desktop are talking) — never the token wall's verdicts… no:
  Cloudflare proxies the bytes, so treat the edge as the carrier it is.
  The design keeps the SAME guarantee as the LAN: everything already
  rides TLS end-to-end from the phone's perspective, and the secrets
  (device token, provider keys) never leave the two ends that matter.
  For hostile-network comfort this is the same trust the owner already
  extends to every https site they use.

## §5 Auto-reconnect across transports (the owner's zero-rerule)

The phone stores an ORDERED address list — `[lan, tunnel]` — plus the
token + the pinned LAN fingerprint. On every app-foreground, network
change (NetInfo), or a backoff timer while open:

1. Probe each address (`GET /health`, 3s timeout) in order — LAN first
   (fast, free), tunnel second (works anywhere).
2. First healthy address wins; the live link rides it.
3. All down → show "Host offline — retrying", keep the backoff loop
   (5s → 10s → 30s ceiling, reset on success).

The PC rebooting changes NOTHING: the certificate is persisted (same
fingerprint), the tokens are in SQLite (same hashes), the tunnel daemon
is a system service (same hostname). The phone re-probes, finds the
tunnel or the LAN alive again, and continues — **no re-setup, ever**
(the owner's literal ask). Only a REVOKED token or a regenerated
certificate forces re-pairing.

## §6 The setup (the owner's "quite good and easy to set up")

Two modes, both guided from Settings → Devices → "Remote access":

### Mode A — Quick tunnel (zero account, zero domain, ~60 seconds)
`cloudflared tunnel --url https://localhost:<port>` → prints a random
`https://<something>.trycloudflare.com` URL. The desktop app detects it
and offers it in the pairing payload. **Honest limitation, documented
in the UI itself:** the quick-tunnel URL is NOT stable — it changes
when the daemon restarts (reboot). Good for trying remote access
today; the phone's manual-pairing URL field accepts the new one.

### Mode B — Named tunnel (recommended; stable across reboots)
1. One-time: `cloudflared tunnel login` (a browser OAuth to the
   owner's Cloudflare account — free).
2. The desktop creates the tunnel (`cloudflared tunnel create
   acute-code`), routes the hostname (`cloudflared tunnel route dns
   acute-code acute.example.com` — needs a domain on the owner's
   Cloudflare account; a ~$10/yr domain is the only cost in the
   system), writes the config, and installs cloudflared as a SYSTEM
   SERVICE (survives reboots — this is what makes §5 true).
3. From then on the tunnel URL is a CONSTANT: it joins the pairing QR
   automatically (the `addresses[]` list gains it), and the phone never
   asks again.

The guided UI wraps all of mode B into: **"Turn on remote access" →
login → (domain pick or quick-tunnel offer) → done"** — the commands
above are what it runs under the hood, never what the owner types.

### What the desktop app ships for the guided round
- cloudflared detection (PATH, or the launcher-kit downloads it — the
  same asset pattern as the Python runtime, never the sandbox).
- Service install/uninstall + status (Windows service / systemd user
  unit / launchd agent).
- The tunnel URL surfaced in the pairing QR + the devices page.
- Health monitoring (edge reachable, tunnel connected, sidecar up).

## §7 What lands WHEN

| Piece | Round |
|---|---|
| Protocol shapes: `addresses[]`, URL-based manual pairing, transport-agnostic tokens, standard-CA verification path in `acute-net` | **R106 (v1 — now)** |
| THIS design document | **R106 (now)** |
| The quick-tunnel RECIPE as owner-followable docs (run cloudflared by hand against the v1 sidecar — anywhere access works TODAY, manually) | **R106 (now, in LINKING-PROTOCOL.md §7)** |
| Guided setup UI (modes A+B), service management, tunnel URL auto-join, FCM push wiring with the owner's Firebase credentials | **R107+ (the immediate-next task)** |
| Cloudflare Access policy wizard | later, optional |

## §8 Risks, honestly

1. **Quick-tunnel instability** — by Cloudflare's design (it's a
   demo-grade path). Mitigated by mode B + the phone's manual URL
   field; never hidden from the owner.
2. **cloudflared as a dependency** — a second daemon on the desktop.
   Mitigation: it's the same class of dependency as the sidecar itself
   (outbound-only, auto-restarting, tiny), installed via the
   launcher-kit pattern, and the LAN path never depends on it.
3. **Edge latency** — one extra hop on the remote path (~10–40ms
   regional). The LAN path is unaffected; SSE deltas tolerate it
   trivially.
4. **Trust sprawl** — the design keeps the credential surface at
   exactly ONE secret (the device token) + optionally one Access
   policy. No Cloudflare account data ever touches the phone.
