<!-- last-reviewed: 2026-09-20 round-115 -->

# Patterns — Onboarding & First-Run (the Wizard DNA)

The wizard is three screens + a post-wizard connect screen. It is the product's first
impression and the purest expression of the design language: **minimal, animated,
honest.**

## Screen 1 — Welcome

```
[animated hero: logo tile (idle float + entrance scale) + "ACUTE" + tagline]
   three option rows (icon chip + ONE-LINE title + ONE-LINE description)
[gap — breathing room, nothing here]
   "Get started" (flat primary)
```

- Tagline: **"The companion for your desktop agent."**
- The three cards keep their titles; descriptions become one-liners:
  - "Work from anywhere" — "Every project and session, live from your pocket."
  - "Approve from your pocket" — "Permission asks land here, one tap to answer."
  - "Know the moment it matters" — "Finished tasks and failures arrive live."
- **Deleted forever:** the "YOUR DESKTOP DOES ALL THE WORK…" kicker, any footer essay,
  any glow/sheen on the CTA.
- The hero icon idles with the ONE sanctioned continuous float; cards stagger in.

## Screen 2 — Camera access (Minimal-Center archetype, nothing else)

```
        spacer
   camera icon tile          ← above center
   "Camera access"
   one line: "Scan your desktop's pairing code."
        spacer
   "Allow camera access"     ← below middle
   ["Skip" — hidden once granted]
```

- **No 1-2-3 steps. No "open your desktop" instructions. No denied-mode essay.**
- Denied state: the one-line caption swaps to warning tone ("Camera blocked — you can
  type the code instead."), the button stays (re-request). Nothing else appears.
- Granted: tile springs to success green, icon morphs to Check, Skip slides out,
  "Continue" enters. (Full sequence in `motion.md` §4.2.)

## Screen 3 — Link your desktop

```
   "Link your desktop"
   two options (icon + label + ≤1-line description):
      [Scan QR code]      [Type it in instead]
   footer: "Scan" (primary) + "Do it later" (quiet)
```

- **Deleted forever:** the TLS trust card, the "one link, one time…" paragraph, the
  third redundant scan CTA.
- Option descriptions, one line each: Scan — "From the desktop's Link a device screen."
  Type — "Address and PIN, no camera needed."

## Post-wizard Connect screen (unpaired)

Minimal-Center: "Connect to PC" + the animated desktop↔phone SVG moment (infinite calm
pulse) + the two options (Scan QR code / Enter values manually). **No back chevron, no
notification bell, no header.** Paired state: the host identity card + manage row +
"pair a different desktop" (with confirm guard).

## Manual entry (the anti-pattern, fixed)

Archetype 3 form, generous spacing:

```
[chevron header: "Manual entry"]
   hero card: "Enter the pairing values" (one line)
   [Paste] smart action — parses address + PIN (+cert) from clipboard pairing text
   Address input (mono)     + one-line shape hint
   Pairing PIN input (mono, 4+4 grouped as typed)
   [Certificate fingerprint — collapsed "optional" disclosure]
   "Continue" (primary; disabled until address+PIN valid; busy state while pairing)
```

- The desktop side pairs with this: its dialog exposes **"Copy pairing text"**
  (`addr:port · PIN`), so paste is the primary path, typing the fallback.
- No paragraphs about tunnels/LAN/TOFU — the shape hint carries ONE clause ("LAN —
  same network as the desktop").

## QR scanner

```
[chevron header: "Scan QR code"]
   SQUARE viewfinder (fills width, 1:1) — corner brackets + traveling scan line
   [pinch to zoom — gestures only]
   "Choose a photo instead" (quiet, below the frame)  ← the torch is BANNED
```

- Square scan window, brackets pulse, scan line actually travels.
- **No zoom +/- buttons. No flashlight/torch.** Pinch only.
- "Choose a photo instead" → document picker → downscale → decode (jsQR) → same
  validation path as live scan. Unsupported format = one honest line.
- Parse errors: one quiet line + haptic, auto-clears — no red cards.

## Confirm the host

Archetype 3 with highlight discipline:

```
[chevron header: "Confirm the host"]
   address block (mono, own tier)
   PAIRING PIN block (big 4+4 mono, own tier)
   [valid-for chip — prominent, warning tint under 30s]
   [certificate line — one micro line]
   "Pair with this host" (primary)   "Not this one" (quiet)
```

- Countdown hits 0 → the actions area is REPLACED by a warning/danger "The window
  closed — rescan the QR code" state (no dead Pair button).
- On Pair: **full-screen pairing moment** (content crossfades out; desktop + phone
  chips merge; the desktop's word-pair name types in) — then home.
- **Deleted forever:** the "PIN window is 120 seconds" footnote.

## Wizard navigation rules

- Screens fade (root stack); no step indicators, ever.
- Completion of onboarding state happens on the FIRST action of screen 3 (as today).
- "Do it later" lands on the post-wizard connect screen — never back into the wizard.
