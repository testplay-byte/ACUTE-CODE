<!-- last-reviewed: 2026-09-22 round-118 -->
# R118-F — The PC-side plan (QR modal + PIN panel + manual pairing + restart + test status)

All five items diagnosed with code-line evidence; item 51's root cause was **proven empirically in real Chromium** (a faithful repro at `/home/z/my-project/qr-repro` using the repo's exact `@radix-ui/react-dialog@1.1.23` + React 18.3, driven via agent-browser).

## §1 Diagnosis

### Item 51 — the QR modal

**ROOT CAUSE (proven): Radix's modal scroll-lock sets `document.body { pointer-events: none }`, and the fullscreen QR overlay — portaled to `document.body` — INHERITS it. Every pointer interaction falls through to the Radix dialog underneath.**

The overlay (`src/components/settings/DevicesTab.tsx:688-734`): `fixed inset-0 z-[60] … bg-black/90` with `onClick={onClose}` — but no `pointer-events` set. Computed styles in the live repro: `overlay: none | body: none | dialog-content: auto`.

- **Click on the big QR** → falls through to the small QR tile inside the dialog (`setQrFullscreen(true)` — already true) → **nothing happens**.
- **Click on the top-right X** → the overlay's X (top-4 right-4) and the dialog's Radix Close X (top-3.5 right-3.5) are co-located — the click falls through to the dialog's X → **the whole modal closes**.
- Esc works (keyboard is not a pointer event) — which is why the code looked correct. The jsdom test (`fireEvent.click`) never models hit-testing, so it lies.

### Item 52 — the PIN cutoff

**ROOT CAUSE: a flexbox shrink trap.** The manual panel's wrapper has `overflow-hidden` → its automatic minimum size is ZERO (CSS Flexbox §4.5) → it absorbs the ENTIRE height deficit created by the rigid QR tile (`min(60vh, 420px)`) inside the capped `max-h-[86vh]` flex column → the wrapper collapses below its content and clips it with its own overflow-hidden. The inner `max-h-[240px] overflow-y-auto` can't help — its own box is what's clipped; the dialog body has no overflow left to scroll.

### Item 53 — manual pairing "Unreachable"

**THE FULL TRACE:**
1. **The PC composes the text from ONE address**: `DevicesTab.tsx:885-888` — `pairingText = addrs[0]:port · PIN … · cert …`. The QR payload is the ENTIRE pair/start response (the full `addrs` ladder).
2. **What's in `addrs`, in what order**: `agent-core/src/lib/device-cert.ts:64-83` — `lanIPv4Addresses()` sorts by FIRST OCTET ascending. On a Windows dev box the non-internal IPv4 set includes virtual adapters (WSL/Hyper-V 172.2x, Docker 172.17, VPN 10.x, APIPA 169.254.x) — first-octet ascending puts ALL of them before the real 192.168.x NIC. The TLS listener binds 0.0.0.0 — the desktop IS reachable on 192.168.x; the phone just never gets told to try it.
3. **The phone parses the text fine** (the v0.110.0 fingerprint leg verified landed in both carriers — hypothesis (a) disproven).
4. **The manual candidate is a ONE-rung ladder**: `pair-flow.ts:165-174` — `case "lan": addrs: [target.host]`.
5. **The probe fails on that single rung** → the catch continues → no next rung → the exact verbatim error at **pair-flow.ts:294**. The QR path carries `payload.addrs` (the whole ladder + relay last) → eats the 5s timeout on 172.x → climbs to 192.168.x → pairs. **The only variable is the number of rungs.**

### Item 50 — the update restart

The pre-exit feedback exists (RestartingSplash + `update-installing`). The real dark: `schedule_exit` closes the window ~1.5s after the silent NSIS installer launches (the R96-I contract — off-limits), the install runs UI-less 10-40s, and the relaunch shows only the generic "Connecting to agent-core…" splash — `updateInFlight` is deliberately not persisted. The middle gap + the anonymous relaunch = "in the dark."

### Item 26 — test model on PC

The machinery exists (`useModelTest` idle/testing/pass/fail + the spinning TestIconButton + the R89-C6 result band) but: (1) the busy cue is a 12px spinner buried in a 32px icon-only button; (2) **the result auto-collapses after 5 seconds** — look away and the row snaps back. Mobile does both right (the label becomes "testing…" + the verdict is a persistent NoteLine).

## §2 The fixes

### 51 — one class
`DevicesTab.tsx:697` — the fullscreen overlay root's className gains **`pointer-events-auto`**. The big QR receives the click → bubbles → `onClick={onClose}` → back to the popup (the toggle); the overlay's own X now intercepts its clicks (closes only the fullscreen); the dialog's X still closes the whole modal when the fullscreen is closed. Esc, swallowPointer, the z-order portal stay.

### 52 — one class
`DevicesTab.tsx:1050` — the manual wrapper gains **`shrink-0`**. The dialog body (`overflow-y-auto`) becomes the scroll owner for the whole stack — the panel including the PIN is reachable by scrolling; the inner max-h-240 keeps long lists bounded.

### 53 — three additive legs
**Leg 1 — the PC text carries the full ladder** (`DevicesTab.tsx:885-888`):
```ts
const pairingText = payload !== null && payload.addrs.length > 0
  ? `${payload.addrs.map((a) => `${a}:${payload.port}`).join(" · ")} · PIN ${payload.pin} · cert ${certFpColonHex(payload.certFP)}`
  : null;
```
**Leg 2 — the phone parses and probes ALL of them:**
- `pairing.ts`: `PairingTextValues` gains `addresses: string[]` (all validated host:port, first = primary; `address` stays `addresses[0]`); the parse's address step collects ALL matches (each removed from the work string so the PIN scan stays clean).
- `ManualEntryInput` gains `altHosts?: string[]`; `parseManualEntry`'s lan branch validates/dedupes them onto the target.
- `pair-flow.ts:165-174`: `case "lan": addrs: [target.host, ...(target.altHosts ?? [])]`. The probe loop, pinFor, claim, storage: zero changes.
- `manual.tsx`: `onSmartPaste` stashes `addresses.slice(1)`; `onEditAddress` clears them (a hand edit drops the paste's extras — honest); `onSubmit` passes them.

**Leg 3 (agent-core) — the sidecar puts the REAL NIC first** (`device-cert.ts` + `device-link.ts`):
- NEW async `detectPreferredLanIp()`: a dgram udp4 socket `connect(53, "8.8.8.8")` (no packet sent) → `sock.address().address` = the default-route interface's IPv4; ~500ms budget; cached; failure → null. Awaited ONCE in `device-link.ts start()` beside ensureDeviceCertificate.
- `lanIPv4Addresses()`: after the numeric sort, (a) move the cached preferred IP to index 0; (b) sort `169.254.*` (APIPA) last.
- Effect: the QR probes the working address FIRST (today it burns 5s on the virtual adapter), the displayed list leads with the real NIC, the copied text's first entry is the best one, the stored reconnect ladder improves. Ordering was never contractual; `v` stays 1.

### 50 — bridge the dark
1. `AboutTab.launchInstaller`: beside `setUpdateInFlight({version})`, write `localStorage.setItem("acute-code.update-restart", JSON.stringify({version, at: Date.now()}))`; remove it in the reject path.
2. `ConnectionGate.tsx`: at mount, read + validate the marker (version string; `at` within 10 minutes; `marker.version === APP_VERSION` — a stale marker means the install failed). While connecting + marker live: the splash variant — line 1 **"Setting up v{VERSION}…"**, line 2 "finishing the update — your data is kept" (same AcuteLogo + spinner + layout). Clear the key on connect (one-shot).
3. `RestartingSplash` subline: "the window will close for a moment while v{VERSION} installs — it reopens by itself" (generic when unknown).

### 26 — mirror the mobile's information
`ModelsProvidersTab.tsx`:
- The R89-C6 band renders ALSO while `state.kind === "testing"`: a one-line row — spinning RefreshCw + `Testing {model.displayName || model.modelId}…` in textSecondary (at the card + in the config-dialog footer variant).
- **The FAIL band no longer auto-collapses** (drop its showResult timer); the PASS band auto-folds at **10s** instead of 5. The useTestTint 5s tint stays.

## §3 Migration map

| File | Change |
|---|---|
| `src/components/settings/DevicesTab.tsx` | :697 `pointer-events-auto`; :1050 `shrink-0`; :885-888 multi-address pairingText |
| `src/components/shell/ConnectionGate.tsx` | marker read/validate/consume; the settingUpVersion splash variant; the RestartingSplash copy; clear-on-connect |
| `src/components/settings/AboutTab.tsx` | the marker write/removal (~6 lines) |
| `src/components/settings/ModelsProvidersTab.tsx` | the testing band ×2; FAIL persists; PASS 10s |
| `mobile/src/link/pairing.ts` | `PairingTextValues.addresses`; the collect-all scan; ManualEntryInput.altHosts |
| `mobile/src/link/pair-flow.ts` | the lan ladder (1 line) |
| `mobile/app/connect/manual.tsx` | altHosts state (~10 lines) |
| `agent-core/src/lib/device-cert.ts` ⚑ | detectPreferredLanIp (dgram, cached); preferred-first + APIPA-last |
| `agent-core/src/lib/device-link.ts` ⚑ | start() awaits it once |

No routes/claim/QR-payload/cert changes (only `addrs` order).

## §4 Verification

- `DevicesTab.test.tsx`: the copy-text test asserts the multi-address format; NEW pins: the overlay root carries `pointer-events-auto` (with the why-comment — jsdom cannot model hit-testing); the manual wrapper carries `shrink-0`; the existing fullscreen behavior test keeps passing.
- `ConnectionGate.test.tsx`: marker cases (matching → "Setting up v…"; mismatched/aged → normal + key removed; existing cases unchanged).
- `pairing.test.ts`: the owner-scenario pin — `parsePairingText("172.20.16.1:45999 · 192.168.1.42:45999 · PIN … · cert …")` → `{address: "172.20.16.1:45999", addresses: [both], …}`; altHosts pass-through/dedupe/validation; the exact-format table updated.
- `pair-flow.test.ts`: **THE item-53 regression test** — a manual lan candidate with `addrs: ["172.20.16.1", "192.168.1.4"]`, the net faking a network error for the first and health for the second → pairWithHost resolves ok with `activeAddr === "192.168.1.4"`; plus the single-dead-address manual still returns the exact :294 message; the candidateFromManual ladder shape.
- `agent-core/tests/r106-mobile-link.test.ts`: extend the lanIPv4Addresses block — preferred-first when the cache is set (a test setter), APIPA last, fallback order preserved.
- The repro harness stays (`/home/z/my-project/qr-repro`) for a real-Chromium re-proof before the app-level change.

**Cannot be verified in this sandbox** (the owner's device needed): the real Windows multi-adapter LAN pairing end-to-end; the packaged NSIS relaunch timing + the marker surviving the WebView2 restart; the real dgram default-route probe. These get release-verification checklist entries.

## §5 Do-not-touch

The updater's download/verify mechanics + the R96-I kill order + schedule_exit's 1.5s + the /S /R flags; the pairing crypto (cert generation, claim gating, PIN minting, pinFor's TOFU); the events stream; Radix's own dismissal plumbing (we add pointer-events-auto to OUR overlay only); the QR payload contract (v:1 fields — only addrs ORDER changes); the R116-e fullscreen structure; the mobile test-status treatment.
