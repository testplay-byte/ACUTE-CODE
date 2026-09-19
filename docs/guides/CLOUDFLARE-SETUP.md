<!-- last-reviewed: 2026-09-19 round-109 -->
<!-- status: THE OWNER-FOLLOWABLE SETUP GUIDE for anywhere-access (the
     R109 ask: "I would also like you to give me guides on setting up the
     Cloudflare system... giving me proper highly detailed guides which I
     can follow and use to perform the actions exactly like how they are
     meant to be"). The design contract itself lives in
     docs/planning/CLOUDFLARE-REMOTE-ACCESS.md; this is the hands-on path.
     Do everything here BEFORE the next session and tell the orchestrator
     what you chose — the guided-UI round then automates all of it. -->

# CLOUDFLARE-SETUP.md — ACUTE-CODE from anywhere, step by step

**What this gives you:** your desktop stays at home (no open ports, no
router changes, no public IP needed, works even behind carrier-grade NAT)
and your phone reaches the exact same ACUTE sidecar from any network on
earth — mobile data, a friend's Wi-Fi, a hotel — using the same device
token and the same app. Free for personal use.

**Time:** Mode A (quick tunnel) ≈ 5 minutes. Mode B (named tunnel, the
recommended permanent setup) ≈ 20–30 minutes once, plus a ~$10/year domain
if you don't already have one on Cloudflare.

**You need:** the desktop app (v0.105.0+) with device links working on
your LAN (pair once at home first — the QR also carries the tunnel URL
once it exists).

---

## Mode A — the quick tunnel (try it TODAY, no account)

A random public URL that forwards to your sidecar. **Honest limitation:**
the URL changes every time you restart the tunnel or reboot the PC —
Cloudflare designed it as a demo-grade path. Perfect for trying
anywhere-access right now; switch to Mode B for the permanent setup.

### A1. Install cloudflared on the desktop

**Windows (the installer):**
1. Download `cloudflared-windows-amd64.msi` from
   https://github.com/cloudflare/cloudflared/releases/latest
2. Run it (Next → Next → Install). It adds `cloudflared` to your PATH.
3. Open a NEW PowerShell (so PATH loads) and verify:
   ```powershell
   cloudflared --version
   ```

**Linux (the package):**
```bash
# Debian/Ubuntu (x64) — add Cloudflare's apt repo:
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
cloudflared --version
```

### A2. Find your sidecar's TLS port

In the desktop app: **Settings → Devices** (device links must be ON —
the toggle you already use for QR pairing). The page shows the sidecar's
address list and port, e.g. `https://192.168.1.20:43124`. **The port
number is what you need** (yours will differ — it's ephemeral and
per-machine).

### A3. Start the quick tunnel

On the desktop (PowerShell or a terminal):

```powershell
cloudflared tunnel --url https://localhost:43124
```
(replace `43124` with YOUR port from A2)

Watch the output for a line like:

```
https://random-words-here.trycloudflare.com
```

That URL is now your desktop's public address. **Keep this terminal
window open** — closing it closes the tunnel.

### A4. Pair the phone from anywhere

On the phone: **Connect → Enter the values manually**:

- **Address or tunnel URL:** `https://random-words-here.trycloudflare.com`
  (paste it — the field has a paste button)
- **Pairing PIN:** the 8-digit PIN from the desktop's Settings → Link a
  device
- Leave the fingerprint empty (tunnel URLs use normal certificate
  verification — the phone knows how)

Continue → confirm the host → **Pair with this host**. You are now
linked over the internet. Turn off your phone's Wi-Fi (use mobile data)
and watch it stay connected.

### A5. What to expect from Mode A

- The URL dies when the terminal closes or the PC reboots. When that
  happens: rerun A3, get the new URL, and on the phone re-pair with the
  new URL + a fresh PIN (Settings → Connect → Scan a new pairing code →
  type it in instead). Your old token gets replaced by the new pairing.
- Everything else (chat, approvals, dashboard, settings) works exactly
  as on LAN, just with ~10–40ms more latency.

---

## Mode B — the named tunnel (the permanent setup, recommended)

A stable hostname that survives reboots, starts automatically with the
PC, and joins your pairing QR automatically in the guided round. This is
the "overall Cloudflare system... quite good and easy to set up" done
properly.

### B0. Prerequisites

- A free Cloudflare account: https://dash.cloudflare.com/sign-up (email +
  password; no card needed).
- **A domain on that account.** Options:
  - Buy one anywhere (~$10/yr for a `.com` at Cloudflare Registrar itself
    — at-cost pricing, no markup) and it's already "on" the account.
  - Or transfer/add an existing domain you own (Dashboard → Add a site,
    follow the nameserver flow).
  - Any domain works: `yourname.com`, `smol.dev`, `.xyz` — the hostname
    you'll use is a subdomain YOU invent, e.g. `acute.yourname.com`.

### B1. Authenticate cloudflared with your account (once)

On the desktop:

```powershell
cloudflared tunnel login
```

A browser window opens → log in to your Cloudflare account → pick your
domain → **Authorize**. cloudflared saves a certificate file
(`~/.cloudflared/cert.pem` on Linux,
`C:\Windows\System32\config\systemprofile\.cloudflared\cert.pem` or your
user profile's on Windows). This is account-level authorization to create
tunnels — do it once per machine.

### B2. Create the tunnel (once per desktop)

```powershell
cloudflared tunnel create acute-code
```

Output includes the tunnel's ID and writes a credentials file, e.g.
`<tunnel-id>.json`. **Note the tunnel ID** — you'll need it for the
config file.

> **Multiple desktops later?** Create one tunnel PER desktop with a
> distinct name — `acute-code-office`, `acute-code-lab` — each gets its
> own hostname. See MULTI-PROGRAM-ARCHITECTURE.md.

### B3. Route your hostname to the tunnel (once per desktop)

```powershell
cloudflared tunnel route dns acute-code acute.yourname.com
```

This creates the DNS CNAME `acute.yourname.com → <tunnel-id>.cfargotunnel.com`
automatically. Replace `acute.yourname.com` with the subdomain you want.

### B4. Write the tunnel's config file

Create `~/.cloudflared/config.yml` (Windows: `%USERPROFILE%\.cloudflared\config.yml`
— if `cloudflared tunnel login` put cert.pem in the system profile path,
put config.yml next to cert.pem):

```yaml
tunnel: <your-tunnel-id-from-B2>
credentials-file: <absolute path to the <tunnel-id>.json from B2>

ingress:
  # THE sidecar rule — hostname match first:
  - hostname: acute.yourname.com
    service: https://localhost:43124
    originRequest:
      noTLSVerify: true   # the sidecar's cert is self-signed; the
                          # connection never leaves THIS machine —
                          # Cloudflare re-encrypts to the phone with a
                          # real public certificate
  # Required catch-all:
  - service: http_status:404
```

Replace `<your-tunnel-id>`, the credentials path, the hostname, and the
port (yours from A2).

**The port stability note:** the sidecar's TLS port is currently
ephemeral per machine directory — it is stable across restarts for the
same data directory, but if you ever see the tunnel 502, re-check
Settings → Devices for the current port and update `config.yml`.

### B5. Test it (before making it a service)

```powershell
cloudflared tunnel run acute-code
```

From ANY network (phone on mobile data): open
`https://acute.yourname.com/health` in the phone's browser — you should
see `{"ok":true,...}` JSON. That's your sidecar, live, from the internet.

Then pair exactly as in A4 (using `https://acute.yourname.com` as the
address). From now on **this URL never changes** — reboots included
(once B6 installs the service).

### B6. Make it a system service (starts on boot)

**Windows (Administrator PowerShell):**
```powershell
cloudflared service install
```
(then start it: `Start-Service Cloudflared` — Services panel shows
"Cloudflared Tunnel"). Uninstall later with `cloudflared service uninstall`.

**Linux:**
```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared
```

cloudflared runs the tunnel named in `config.yml` as a service. Reboot
the PC to prove the whole chain to yourself: phone on mobile data →
still connected.

### B7. (Optional, recommended) Cloudflare Access in front

Belt-and-suspenders: require an email OTP before Cloudflare will even
proxy your hostname (token-less scanners see nothing but the Access
login):

1. Dashboard → Zero Trust → Get started (free plan, up to 50 users).
2. Access → Applications → Add an application → Self-hosted.
3. Application domain: `acute.yourname.com`. Policy: Allow → Emails →
   your email. Save.
4. First phone visit gets a one-time code by email; after that the
   session cookie lasts (the app's requests ride the same session via
   the browser component only for the initial check — if you hit any
   trouble with the native app through Access, delete the application
   rule and tell the orchestrator; the token wall is the primary
   security either way).

---

## Verifying the whole thing (the 60-second check)

1. Phone on **Wi-Fi at home** → status pill says `connected` (LAN path).
2. Phone on **mobile data** → pill stays `connected` (tunnel path — the
   phone probes its address ladder: LAN first, tunnel second).
3. Send a message in a session from mobile data → watch it stream.
4. Reboot the desktop → phone shows `offline — retrying` → reconnects on
   its own within ~30s of the PC returning. **No re-pairing, ever.**
5. Desktop's Settings → Devices shows your phone with a recent
   "last seen".

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `trycloudflare.com` URL dead | Mode A is running in a terminal you closed, or the PC rebooted → rerun A3 (or graduate to Mode B). |
| Tunnel returns **502 Bad Gateway** | cloudflared is up but the origin is wrong: the port in `config.yml` no longer matches Settings → Devices → update it and restart the service. |
| Phone says "a different machine answered" | The hostname routes to a tunnel whose desktop regenerated its machine identity (rare — fresh install). Re-pair. |
| `cloudflared: command not found` after install | New terminal needed (PATH), or install per A1 again. |
| Pairing over the tunnel fails with "the 120-second window closed" | The PIN expired (they live 120s) — generate a fresh one and retry within two minutes. |
| Everything was working, now `offline` on both paths | The sidecar isn't listening: is the desktop app running? Is "Allow device links" still ON in Settings → Devices? |

## What to tell the orchestrator in the next session

- Which mode you run (A/B) and the hostname (B) — never any secret.
- Whether you enabled Cloudflare Access (B7).
- The rough boot-to-connected time after a reboot (service health).
- Anything that fought back (exact error text) — the guided-UI round
  (the "Turn on remote access" button in Settings → Devices that runs
  B1–B6 for you) fixes exactly what you report.
