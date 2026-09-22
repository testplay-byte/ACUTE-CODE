<!-- last-reviewed: 2026-09-22 round-117 -->

# Foundations — Typography & the Copy-Length Law

Type ladder lives in `tokens.ts` (`TypeDisplay/Stat/Title/Heading/Body/BodyStrong/Caption/
Micro/Mono`). This file pins how much text each tier is ALLOWED to carry.

## The weight law

- 400 body everywhere by default.
- 600 for row titles and active labels (`TypeBodyStrong`).
- 700 card titles, 800 display — one 800 per screen.
- ALL-CAPS only via `textTransform` on `TypeMicro` kickers — never hardcoded
  uppercase strings.

**Round-117 amendment (AMENDMENT 4 — the ladder's additions):**

- Stat/data numbers may render at **28 mono-medium** (`TYPE_STAT` / `TypeStat`,
  letterSpacing −0.5) — the display size on the mono face. A named slot, not a new
  size: the dashboard's headline figures are the screen's point and finally get a
  scale. (The spec's amendment line says "mono-semibold"; the bundled JetBrains Mono
  faces are 400/500, so the slot pins to mono-medium — §2.1 is the operative value.)
- The **tab-label floor is 11.5 px** (`TYPE_TAB_LABEL`): unselected tab labels were
  10.5 px (`TYPE_MICRO − 0.5`), below the ladder's own 11 px floor. The label and its
  measurement row must switch TOGETHER (byte-identical recipes or the morph
  mis-measures).
- `TypeCaption` lineHeight 17 → **18** (Manrope's tall ascenders); `TypeMicro` gains
  lineHeight 15 + tracking 0.6. No size changes; the weight law and copy-length law
  are untouched.

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
- `TypeStat` (round-117) — the dashboard's stat/data numbers (28 mono-medium).
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
