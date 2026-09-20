<!-- round: 115 -->

# Foundations — Typography & the Copy-Length Law

Type ladder lives in `tokens.ts` (`TypeDisplay/Title/Heading/Body/BodyStrong/Caption/
Micro/Mono`). This file pins how much text each tier is ALLOWED to carry.

## The weight law

- 400 body everywhere by default.
- 600 for row titles and active labels (`TypeBodyStrong`).
- 700 card titles, 800 display — one 800 per screen.
- ALL-CAPS only via `textTransform` on `TypeMicro` kickers — never hardcoded
  uppercase strings.

## The copy-length law (round-115's core verdict)

| Surface | Max copy |
|---|---|
| Card/option description | **ONE line** (≤ ~48 chars). No second sentence. No exception. |
| Wizard tagline | One line, ≤ ~48 chars |
| Button label | 1–3 words ("Get started", "Scan", "Allow camera access", "Pair with this host") |
| Empty-state message | One line title + one line caption |
| Field hint | One line; only when the input is genuinely ambiguous |
| Footnote/kicker under content | **Deleted as a pattern.** If it explains the screen, the screen is wrong. |

Rules that follow:

1. **Descriptions are optional.** "Scan the QR code" needs no description. If a label
   is honest, ship it bare.
2. **Never stack explanation blocks.** One hint per screen region maximum.
3. **Trust chips ("TLS", "certificate pinned") don't get paragraphs.** They get an icon
   + 3–5 word micro line at most — or nothing.
4. Multi-line descriptions anywhere in chrome (headers, cards, sheets, footers) are a
   **rejection** in review.

## Hierarchy usage

- `TypeDisplay` — the wizard only (Welcome / Camera / Link your desktop / Connect to PC).
- `TypeTitle` — in-app pushed-screen heroes and full-screen moments.
- `TypeBodyStrong` — row labels, option labels.
- `TypeCaption` — the one-line description tier (tertiary color).
- `TypeMono` — paths, addresses, PINs, commands, model ids. The pairing PIN renders
  4+4 grouped (`"1234 5678"`) at 26px mono semibold — the ONE place mono goes big.

## Numbers

- Countdowns, counts, token totals: `tabular-nums` discipline (RN: fixed-width via
  JetBrains Mono).
- Relative time: the existing `timeAgo` vocabulary ("just now"…"3d ago") — never
  raw timestamps in lists.
