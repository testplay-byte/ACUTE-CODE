<!-- last-reviewed: 2026-09-19 round-110 -->
# CLOUDFLARE-SETUP.md — remote access: already set up (one paste remains)

The complex part is DONE and will never repeat. ACUTE-CODE's cloud relay —
the piece that lets the Android companion reach your desktop from any
network — is a single Cloudflare Worker deployed **once** from the browser:

- **Live at** `https://acute-relay.anikuta.workers.dev` (production-verified
  end to end: tunnel, pairing traffic, SSE streaming, connection
  management).
- **Free plan, no domain, no card.** The address is permanent.
- **Self-updating**: the relay's code lives in the private
  `testplay-byte/acute-relay` GitHub repo; every improvement is a `git
  push` and Cloudflare redeploys it automatically. You never deploy
  anything again.
- **Scales**: one hibernating room per desktop — comfortably ~100
  connections today, ~1,000 later with a dashboard click, zero migration.

The old tunnel instructions (cloudflared Modes A/B) are retired — the relay
replaces them entirely. The full design story lives in
`docs/ui-iterations/round-110.md`.

## Enabling remote access on a desktop program (once per program, ~1 minute)

1. Open the program → **Settings → Devices**. You'll see two cards:
   **Device link** (local network — the existing one) and **Remote access
   (internet)** — the new one. They are independent; **both can be ON at
   the same time**.
2. In **Remote access (internet)**:
   - Toggle it on.
   - **Relay URL**: `https://acute-relay.anikuta.workers.dev`
   - **Host key**: the key you received during the one-time setup (handed
     over in the private assistant chat — ask for a re-share if lost; it
     is also NOT in any file you need to hunt for).
   - **Save**. The status line settles on **Connected to
     acute-relay.anikuta.workers.dev** within a few seconds and refreshes
     while the page is open.
3. That's it. While connected, the pairing QR automatically carries the
   relay address — a phone paired after this moment can reach the program
   from anywhere. Phones paired BEFORE this (v0.105.0 era) need one
   re-pair, or the relay URL can be typed once into the manual pairing
   page (it accepts cloud-relay URLs).

## What the phone does (nothing to configure)

The companion probes its address ladder automatically: **local network
first** (fast, when you're home), **the relay last** (works from anywhere).
If the desktop is unreachable over the internet, the phone reports
"offline" — the same honest status as on LAN. A relay that answers
"desktop not connected" is a retryable state, never a reason to re-pair.

## Managing connections (delete old ones)

- **Phones**: Settings → Devices on the desktop lists every paired device
  with a revoke button (kills its token instantly, works for
  internet-paired phones too). The phone's own unpair lives under Settings
  → Connection.
- **The relay's rooms**: with the ADMIN_KEY (also from the one-time setup):
  - List: `curl -H "Authorization: Bearer <ADMIN_KEY>" https://acute-relay.anikuta.workers.dev/admin/rooms`
  - Evict one now: `POST /admin/rooms/<machineId>/evict`
  - Delete stale ones (offline > 7 days by default): `POST /admin/rooms/prune`

## The 60-second check

1. `https://acute-relay.anikuta.workers.dev/health` in any browser →
   `{"ok":true,"name":"acute-relay",...}` means the relay itself is alive.
2. The desktop's Remote access status line says **Connected**.
3. Pair (or re-pair) the phone, then turn off Wi-Fi on the phone (mobile
   data on) and watch it stay connected through the relay.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| Status line stuck on "Error: unauthorized" | Host key typo | Re-paste the host key; Save |
| Status line cycles "Connecting…" forever | Relay URL typo or Cloudflare incident | Check the URL; check `https://dash.cloudflare.com` → Workers → acute-relay → logs/metrics |
| Phone says the desktop is offline (but the PC is on) | The program's Remote access is off, or the tunnel dropped | Toggle/verify on the desktop; the connector self-heals with backoff — a minute of patience is normal after sleep/network changes |
| Everything worked, then the PC slept | The tunnel closed with the machine | Wake the PC; the connector reconnects automatically |

Nothing here requires the command line, a domain, or a Cloudflare config
file — by design. If a step ever feels like the old guide's complexity,
that's a bug in this document: report it.
