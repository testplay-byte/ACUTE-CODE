<!-- last-reviewed: 2026-09-19 round-109 -->
<!-- status: THE architecture guide for the owner's multi-program ask
     (R109: "I want the ability to be able to handle multiple programs at a
     single time using this system... If I have a total of 10 programs
     running on 10 different devices, then the Cloudflare one can most
     probably handle all 10 of those properly and can link them to the
     appropriate Android ones and such") + the right-sidebar web-publishing
     reuse ("This exact same system is going to be used for the right
     sidebar web browser pages too... to show the projects built and...
     publish temporarily so that I can see the projects from anywhere").
     This is the DESIGN the next sessions build against — the phone today
     is single-host by honest scope, with every seam already shaped for
     what's written here. -->

# MULTI-PROGRAM-ARCHITECTURE.md — ten desktops, ten links, one pocket

**The goal, in the owner's words:** ten ACUTE programs running on ten
different machines (home PC, office PC, laptop, a lab box…), each linked
to the appropriate Android device(s) — reachable from anywhere, managed
from the same app, never confused with each other.

**The good news the architecture already carries:** Cloudflare Tunnel is
per-account and practically free at this scale — ten tunnels on one
Cloudflare account, ten hostnames, ten desktops. The phone's link layer
already stores an ordered ADDRESS LADDER per host and probes them
independently; the wall authenticates tokens, never source addresses;
and the pairing QR already carries an address LIST. The single deliberate
gap: the phone's host STORE and UI are single-host today (R106's scope).
This document is the contract for closing it.

---

## §1 The shape (one Cloudflare account, many machines)

```
                     ONE Cloudflare account (free)
                     ├─ acute.home.yourname.com    ──► tunnel: acute-home
                     ├─ acute.office.yourname.com  ──► tunnel: acute-office
                     ├─ acute.lab.yourname.com     ──► tunnel: acute-lab
                     └─ ... (ten of them, one per machine)

  each desktop: agent-core sidecar + cloudflared service (outbound-only)
                + its OWN machine certificate + its OWN device tokens

  the phone:   ONE app, a HOST LIST (host registry), each entry =
               { label, machineId, certFP, LAN addrs, tunnel URL, token }
               — today's StoredHost, pluralized.
```

**Why this is safe at ten:** every credential stays per-machine. A
revoked phone on the office desktop cannot touch the home desktop's
token. A compromised tunnel hostname exposes exactly one sidecar's
`/health` and its 401 wall. No shared secret exists anywhere in the
system — there is nothing to "cross-link" by mistake; linking is a
per-machine act (pairing), and unlinking is a per-machine act (revoke).

## §2 The desktop side (nothing new to build — only to run)

Per machine, repeat CLOUDFLARE-SETUP.md Mode B with a distinct tunnel
name and hostname:

```powershell
cloudflared tunnel login            # once per MACHINE (account-level)
cloudflared tunnel create acute-office
cloudflared tunnel route dns acute-office acute.office.yourname.com
# config.yml: tunnel: <office-id>, hostname: acute.office.yourname.com,
#             service: https://localhost:<that machine's sidecar port>
cloudflared service install         # starts on boot
```

Cloudflare's free tier allows more tunnels than this guide will ever
need; the edge doesn't care that all ten terminate at different machines
in different houses.

## §3 The phone side (THE next mobile round — the multi-host registry)

The work, honestly scoped:

1. **The host registry (the store):** `host-store.ts` grows from ONE
   `StoredHost` to a keyed list (`machineId → StoredHost`), with the
   active host pointer. The SecureStore token becomes per-host
   (`acute.device.token.<machineId>`). Migration: the existing single
   host migrates into the list on first boot of the new version —
   nothing re-pairs.
2. **The ConnectionManager stays single-live-link** (one active host at
   a time, exactly as today) — ten concurrent live SSE links is battery
   hostility, not a feature. Switching hosts is one tap in the new
   **Hosts** page (the connect hub grows a host list: label, machine,
   live state, last seen, "connect", "manage", "disconnect").
3. **The per-host notifications stream**: the activity controller
   follows the active host (the stream + unread reset on switch). Push
   (once Firebase lands) solves the "watch all ten while backgrounded"
   problem properly: each desktop pushes its own pings; the
   notification's tap opens THAT host's context (the payload carries
   the machineId — ping-only, ids only, still no content).
4. **The pairing flow gains an "add another desktop" framing** (the QR
   of desktop #2 pairs desktop #2; the registry just gains a row — the
   current "scan a new pairing code replaces this link" behavior
   becomes "adds to the list" with an explicit replace choice when the
   machineId already exists).
5. **The gate/routing**: the connect hub becomes the host picker when
   more than one host exists; the header pill shows the ACTIVE host's
   short label so ten hosts never blur together.

**What deliberately does NOT change:** the transcript, approvals,
dashboard, settings screens — they render whatever the ACTIVE link
serves. Zero new API surface; the desktop's device-token blocklist and
per-machine tokens carry the whole trust story.

## §4 The right-sidebar web pages (the SAME system, second life)

The owner's ruling: the built projects get temporarily published —
viewable from anywhere — through the same tunnel infrastructure, in the
desktop's right-sidebar browser.

**The shape (the design the next round builds):**

- Each project's dev server (or a static export of it) binds a loopback
  port on ITS desktop — exactly like the sidecar does today.
- The desktop's tunnel config gains an ingress rule per published
  project: `app1.home.yourname.com → http://localhost:<project-port>`
  (cloudflared's config is a LIST; the "Publish temporarily" toggle in
  the project page writes/removes one rule + one DNS route and reloads
  cloudflared — seconds, no rebuild).
- The right-sidebar browser navigates to that URL like any site — from
  the desktop itself, or from anywhere (it's a public hostname with
  optional Cloudflare Access in front).
- The PHONE's browser (or the companion's project page) reaches the
  same URL — the owner sees the projects built from anywhere, on any
  device, per the ask.
- **Publishing is a first-class, temporary, reversible act**: the
  toggle, an honest expiry (auto-unpublish after N hours, the owner
  picks), and the project list showing what's currently public.

**Why this rides the SAME system:** one Cloudflare account, one
cloudflared daemon per desktop, one trust model (the edge is transport;
the project servers get their own honest auth or a scoped Access
policy). Nothing about the sidecar link changes; the tunnels just carry
one more hostname family.

## §5 The sequence (what the next sessions build, in order)

1. **The anywhere-access round** (Cloudflare guided UI — Mode A/B behind
   the "Turn on remote access" button; the tunnel URL auto-joins the
   pairing QR + the phone's stored ladder). Prerequisite: you run
   CLOUDFLARE-SETUP.md and report back.
2. **The Firebase push round** (the dormant publisher wakes with your
   service-account JSON; the phone registers its FCM token — see
   FIREBASE-SETUP.md).
3. **The multi-host round** (§3 — the host registry, the host picker,
   per-host push topics; ten desktops, one pocket).
4. **The web-publishing round** (§4 — the project ingress rules, the
   publish toggle + expiry, the sidebar/phone viewing).

Each round is independently shippable and independently useful — the
order above is dependency-honest (push needs the tunnel round's
reachability story for background pings to matter; multi-host's
background story needs push).

## §6 What to provide the orchestrator, per round

| Round | You provide | Never provide |
|---|---|---|
| Anywhere-access | Which mode you run; the hostname; Access on/off; boot-to-connected timing; any error text | cert.pem, tunnel credentials JSON |
| Firebase push | "Ready" + the Project ID; your ntfy-vs-Firebase choice | The service-account JSON contents or the google-services.json contents — you place the FILES (F4) |
| Multi-host | How many desktops you actually run today; the labels you want | Any token, any cert |
| Web publishing | Which projects you want publishable; the expiry default you prefer | — |

## §7 The honest risks

1. **Ten hostnames is ten things to keep DNS for** — Cloudflare makes it
   painless, but the guided UI (not you) should own the naming; the
   multi-host round automates ingress/DNS edits entirely.
2. **The phone's single-live-link** (§3.2) means "watch all ten
   simultaneously" is PUSH's job, not the live stream's — by design
   (battery). If you want true concurrent live transcripts for two
   hosts, say so; it's a bounded addition (a second manager instance)
   but it should be an explicit ruling, not a default.
3. **Project publishing exposes dev servers** — the round ships an
   honest warning per project ("this is a dev server, not a hardened
   site") + Access-on-by-default recommendation for anything non-toy.
4. **The port-stability seam** (CLOUDFLARE-SETUP.md B4's note) — the
   guided round pins the sidecar to a STABLE configured port when
   remote access is on, retiring the ephemeral-port footgun entirely.
