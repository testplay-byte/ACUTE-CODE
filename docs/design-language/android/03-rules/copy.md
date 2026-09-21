<!-- last-reviewed: 2026-09-21 round-116 -->

# Rules — The Copy Voice

The phone speaks like a calm, honest colleague. Short. Warm. Never cute, never
corporate, never lecturing.

## Word choices (pinned)

| Banned | Use instead | Why |
|---|---|---|
| "remote" (as the product's role) | **"companion"** | The owner banned "remote"; the app is `acute-companion` |
| "Auto" (as a model state) | the real model's name | "Auto" invents a concept the desktop doesn't have; round-116 also retired the picker's "Agent default" ROW — the picker shows real models only, highlighted by the PC's actual selection |
| "Pairing window is 120 seconds" | "Valid for {n}s" | Never explain the mechanism when the state shows it |
| "Your desktop does all the work…" | (delete) | Wizard essays are banned |
| "Tap a project to expand…" | (delete) | The affordance teaches itself |
| Multi-sentence descriptions | One line | The Copy-Length Law (`typography.md`) — round-116: also a CODE law (`numberOfLines={1}`), wrapping is a defect |
| "Manual Entry" / screen-title casing drift | Sentence case titles, truly centered | Round-116: titles center over the whole row, not the leftover space |

## The one-liner discipline

- If a description needs a conjunction ("…and…"), split the concept or delete the line.
- If it needs a comma-clause ("— works from anywhere, camera never needed"), cut to the
  first clause.
- Field hints exist ONLY for genuinely ambiguous inputs (a PIN that could be confused
  with a password). "Name" needs no hint. "Folder" needs no hint.

## State copy vocabulary (reuse, never re-roll)

| State | Copy |
|---|---|
| Connecting | "Looking for the host…" |
| Offline | "Offline — messages will queue" |
| Paired + live | "Live · {friendly name}" |
| Expired pairing window | "The window closed — rescan the QR code" |
| Empty approvals | "Nothing needs your approval" |
| Empty projects | "No projects yet" |
| Session running | "Running" (badge) — never "processing…" prose |
| Upload failed | "{file} couldn't upload — it rides as a mention" |

## Names

- Desktops get **word-pair names** ("Confused Coconut", "Brave Otter"): adjective +
  noun, title case, minted once, stable. The lists live in agent-core; the phone never
  mints its own desktop name.
- Sessions keep their honest titles; untitled = "Session {id12}".

## Numbers & units

- Tokens: 999 / 1.2k / 3.4M (the existing `formatTokens`).
- Relative time: "just now", "5m ago", "3d ago" — the existing vocabulary.
- Countdown: "Valid for 24s" — numerals, never "about half a minute".
