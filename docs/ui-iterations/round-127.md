<!-- last-reviewed: 2026-09-25 round-127 -->
# Round 127 — the improvement pass on v0.119.0

**Owner directive:** his walkthrough of v0.119.0 — the UI "quite good looking…
quite simple and clean" overall, with named areas to improve (the usage
layout, the chart hovers/tooltips/density, the dashboard boldness, the
context meter's fixed 26K lie, the scrollbars, the auto-scroll +
expand/collapse behaviors, the file icons, the agent's one-command-at-a-time
habit + three-part file reads + edit failures, the feedback ledger's missing
context details, and the mobile tool-visibility gap) + "make sure to follow
the exact same workflow which you had followed while improving the UI" —
the R126 wave method, per the AI-AGENT-PLAYBOOK.

**Method:** the playbook's session arc verbatim — backup branch FIRST
(`backup/pre-r127-improvements`, pushed at ae79472), the complaint inventory
extracted to a live todo, the constitution amended BEFORE any wave
(COMPONENTS §6's four chart-interaction laws + the gauge law; SCREENS §3's
usage page order + dashboard boldness law; TOKENS §6's overlay-scrollbar law
+ the file-type palette exception #5; MOTION §4's tool auto-lifecycle + the
scrollbar fade), foundations inline (the global scroll-fade mechanism + the
shared chart helpers + the backend `granularity=hour` seam), two research
agents (the mobile comms root cause — empirically proven healthy
bus/consumer with the pref path + the missing reconnect as the real defects;
the hourly-bucket design — one seam, zero migration), then EIGHT waves
(W1 usage layout, W2 usage charts, W3 dashboard, W4 context honesty, W5 chat
behaviors, W6 agent-smarter, W7 feedback telemetry, W8 mobile), each
review-gated with the orchestrator reading the diffs + re-running the gates.

## 1. The wave ledger

| Wave | Surface | The owner's complaint it killed |
|---|---|---|
| F1 (inline) | The constitution + shared chart primitives | the spec every wave implements (clampTooltipX, hour labels, sparse ticks) |
| F2 (inline) | The global overlay scrollbars | "completely hide those scroll bars… only appear when the user tries to scroll" |
| F3 (inline) | The `granularity=hour` backend seam | "instead of seven days… hourly based" (the data layer) |
| W1 | Usage page layout | the leaderboard's wrong position; the model list's placement; the danger zone mid-page |
| W2 | Usage charts | hover only at the top area; tooltips off-screen; the 7-bar empty view; no scroll-to-latest; the thin donut |
| W3 | Dashboard | the boldness ask (big headings, timeline); the chart hover defects |
| W4 | Context meter honesty | "fixed at 26K of 1 million" while the provider said 50-70K |
| W5 | Chat behaviors | no auto-scroll; no auto-expand/collapse with a delay; no colored file icons |
| W6 | Agent-smarter | one command at a time; the three-part file read; re-reads; edit failures with no recovery |
| W7 | Feedback ledger | "include the proper details… the context of it, the total expected tokens, what was roughly available" |
| W8 | Mobile | "none of the tool calls are shown… ever" + the deaf stream |

## 2. The root causes found (the survey's verdicts, all confirmed in-tree)

- **The chart hover defect** — the painted `motion.rect` bars render ABOVE
  the transparent `data-bar-idx` column and carry no idx themselves, so the
  pointer over a bar's BODY resolved nothing; only the empty column above
  the bar hit. Fixed by the full-column law (painted rects
  `pointer-events: none`).
- **The tooltip overflow** — `translateX(-50%)` centering with no edge
  clamping; the right-most bars pushed their tooltips outside the card.
- **The context meter lie** — `GET /sessions/:id/context` computed the PURE
  local estimate while the R125-C `providerUsageAnchor` law already existed
  for the runtime; the meter ignored it.
- **The auto-scroll gap** — the follow-effect's deps watched settled steps +
  the answer tail, but NOT the live thinking text or the streaming tool
  args: content grew, no dep fired, the pinned transcript sat still.
- **The mobile tool-visibility** — the bus → route → phone-consumer chain is
  healthy (proven empirically by the research agent with a live sidecar +
  the phone's pure chain); the real defects were the `toolActivity="hidden"`
  pref path (the only code that renders "text yes, tools never") and the
  phone's events stream having NO self-reconnect (one error = deaf until an
  unrelated poke). The mobile auto-scroll law already existed and is pinned.
- **The three-part file read** — the 48KB whole-file budget sat right at the
  owner's file class edge and the description didn't forbid pre-splitting;
  the budget is now 128KB with the prohibition explicit.

## 3. The evidence

- **Gates (final, all fresh this session):** root tsc CLEAN · FULL vitest
  **288 files / 4,961 tests** GREEN (baseline 274/4,840 — every delta a
  new pin suite: the foundations 20, W1 ~25, W2 20, W4 8, W5 25, W6 25, W7
  30, W8 mobile +17 on the jest side) · eslint CLEAN · design-audit CLEAN
  (R1 74→100/101 — the 26 file-type palette hexes, the SANCTIONED TOKENS §1
  exception #5; R2 1519→1526, R4 12→15, R3 0/0, R5 13/21 — the
  constitution-mandated display-tier spellings, documented re-pins per the
  R125 precedent) · `pnpm build` SUCCESS (mermaid chunk ok) · e2e 12/12 ·
  license CLEAN (299) · docs:check 274/0/0 at the code commit (the final
docs commit's local re-run carries the known transient: 3 servo.org URLs in
  the R100 research doc unreachable from THIS sandbox's egress — CI's own
  docs:check was GREEN on the same commit from GitHub's network; the URLs
  live in a pre-existing doc untouched by this round) · mobile jest **48
  suites / 1,066 tests** (baseline 48/1,049) · mobile tsc CLEAN.
- **Live verification (agent-browser, 1600×1000, a real sidecar on a seeded
  temp DB — 33 hourly usage buckets + a provider-anchored session):** the
  usage page's section order (stat row → insights rail BESIDE the chart →
  leaderboard full-width BELOW → stats panel → donut → … → danger zone
  LAST); the donut ring 160×160 at stroke 14; the 7-day hourly view (160
  hour buckets, `HH:00` ticks, day-boundary labels, the scroller mounted at
  the newest end — scrollLeft 509/1278); the 90-day view mounted at the
  newest end (scrollLeft 1565 + clientWidth 769 = scrollWidth 2334); the
  newest-bar tooltip CLAMPED inside the card (tooltip right 1094 ≤ card
  right 1123) with the hover resolving at MID-BAR height (the full-column
  law); the dashboard's h1 "Workspace" at 32px/800 + the stat values
  26px/700 + the timeline spine/day-groups/nodes; the overlay scrollbars
  (transparent at rest, the 18% tint under `.is-scrolling`); zero console
  errors. Screenshots: `shots/r127/` (dashboard + usage, both modes).
- **VLM verdicts (the model, against the owner's specific complaints):** the
  dashboard — "a polished, well-structured dashboard that successfully
  executes the requested design language"; the 7-day hourly usage — "the UI
  accurately implements a dense 7-day hourly activity chart with correct
  labeling, proper adjacent insights, and a logically structured leaderboard
  below… no dead zones."

## 4. Honest caveats

- **Verified-at-pin-level-only:** the mobile reconnect ladder + the pref
  recovery (jest pins; no phone in the sandbox — the device pass is the
  live confirmation, and if live tools still fail with pref=detailed + a
  healthy ladder, the out-of-repo acute-relay Worker's guest SSE leg is the
  next suspect); the agent-smarter behaviors (the pins prove the tool +
  prompt contracts; the owner's next device session proves the model's
  behavior actually changes — the model may still choose to split reads,
  though the description now forbids it and the 128KB budget removes the
  excuse).
- **The R1 audit re-pin:** 74→100 — the file-type palette's 26 hex lines,
  registered as TOKENS §1 exception #5 BEFORE the wave (the model-palette
  precedent; extension identity is data encoding). R4 12→15 + R2 1519→1526:
  the constitution-mandated display tiers (the 26px/700 stat values, the
  32px/800 lead, the 30px donut share). All documented, all under the audit's
  hard caps.
- **The interrupt pattern hit THREE times this round** (W1, W5+W6, W7 —
  transient sub-agent infra timeouts after the work landed but before the
  reports returned): the §4.4 successor protocol handled each — audit
  item-by-item, complete the gates, append the record crediting the
  interrupted run. One real defect was caught this way (a stray test-literal
  type error in W5's run).
- **The environment incidents:** a full-disk ENOSPC (~5.8GB of stale test
  temp dirs from prior sessions in /tmp — cleaned, 5.7GB freed; the failures
  were never code) + the Bash display pipeline eats `[h` sequences (a false
  "corruption" alarm on `[hoveredIdx` — resolved by byte-level verification;
  tsc/vitest were right all along). Both documented for future agents.
- **Kept by design:** the hour view is UI-selected only at 7 days (the
  backend serves ≤14 — a one-line extension if the owner asks); the
  model-mix chart stays daily (the stats series' own range picker); the
  mobile clay alignment is verified as ancestry-true (the PC clay CAME from
  the mobile) with a 3-item stale list recorded for a future round (the
  mobile file-type palette, the thinking-well timed close, the status-chip
  class legs).

## 5. The close-out

- Version 0.119.0 → **0.120.0** across all 7 manifests (`version:check`
  agrees); CHANGELOG entry written; this round file complete.
- The commit lands the full round on `main` + the tag `v0.120.0` AFTER CI
  shows green (the R125 law); the release publishes with 7/7 assets.
- The rollback door: `backup/pre-r127-improvements` (pushed at ae79472).
