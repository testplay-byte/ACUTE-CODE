# R118-C — The dashboard spec (the mobile-first layout rethink)

**STATUS: W1 foundations LANDED (de5ccc7)** — DISCLOSURE_SPRING {180,24} / COLLAPSE 200ms / FADE 150ms in motion.ts; Hairline strong; SectionHeader large; the R118 constants. The remaining work is this spec's screen implementation.

The data the screen actually has (verified in `features/config.ts` — the wire is the contract):

| Endpoint | Fields |
|---|---|
| `GET /usage/summary?days=14\|30` | `days[] {date, inputTokens, outputTokens, requests, costUsd}` (zero-filled, ends today), `totals`, `generatedAt` |
| `GET /usage/stats?months=1\|3` | `totals`, `peak {date, tokens}`, `series[]`, `models[] {model, tokens, costUsd, calls, requests, providers[]}` |
| `GET /usage/detailed?days=14\|30\|90` | whole-history `totals {projects, sessions, toolCalls, tokens, costUsd}`, `tools[]`, `keys[]`, `projects[] {id, name, color, sessionCount, totals, models[], sessions[]}` |
| per session | `id, title, status (queued/running/completed/failed/cancelled — raw string), model, startedAt, endedAt, durationMs, tokens{input,output,cached}, costUsd, requests, toolCalls[], subagentCount, isSubagent, role` |

No endpoint changes. No new fetches. The load orchestration is untouched.

## §1 Diagnosis

**Current structure:** scaffold → window-chip row → soft-notice strip → **horizontal snap FlatList of 8 stat cards** → "Daily tokens" chart card → "Activity" grid card (duplicating the same day buckets) → "Models" donut card → **second horizontal FlatList of per-model cards** → Tools leaderboard → Keys → Projects all-time (inline sessions accordion) → footer.

- **#1 expanded projects dirty**: every row shows "open" (`sessionStatusWord` maps `queued → "open"` — a badge with zero variance is noise); `projectWell` has no background/inset/separators; tokens+cost ride one run-on TypeMicro line; titles single-line-clamped with `Session ${id.slice(0,12)}` fallbacks. The model chip is liked — KEEP.
- **#2 bounce**: `UsageAccordion` uses the same underdamped 180/22 (ζ 0.82, ~1.1% overshoot, 2–3-cycle settle ≈ 1.2s) BOTH ways; the chevron rotates on the same spring.
- **#3 period selector**: three full-word `Chip`es in a wrapping row — three buttons, not one control.
- **#4 the carousel**: 8 cards mixing scopes ("last 14 days" beside "all time") behind a swipe — mandated by screen-archetypes.md L116-119 (the R116 amendment) — the doc itself must be superseded.
- **#5 chart**: bars fill their column (14-day bars ≈ 18-19px — chunky); axis = endpoints only; the Activity grid duplicates the day buckets.
- **#6 models**: a second horizontal carousel below the donut — two surfaces for one section.
- **#7 layout**: nine stacked sections + two horizontal scrollers; no tablet treatment.

## §2 The design

**One vertical scroll. Zero horizontal FlatLists.** Rhythm rides the existing carriers (scaffold gap 12 + SectionHeader marginTop 20 = the 32px break).

### 2.0 The section stack

**§2.1 The period selector** — `PeriodSegmentedControl` (in usage-cards.tsx): ONE self-sized 3-segment control, leading (`alignSelf: "flex-start"`), track 52/r26/p4 (the shared SegmentedControl grammar — use the LANDED primitive where the label sizes fit, or the local recipe with the same geometry). Labels **"14d" / "30d" / "3mo"**; selected 12.5/700 `accentDeep` (the tab-pill's label class), unselected 12.5/600 textSecondary; indicator = accentTint fill + 2px accentDeep border, radius 22, TAB_SPRING slide (the tab-pill recipe — this control's labels are pinned at the chrome tier). testIDs stay `dashboard-window-14d/30d/3mo`. First element of the scroll body, NOT sticky (the R114-c law killed fixed chrome on tab roots).

**§2.2 The headline stat block** — `StatGrid`: ONE ClayCard (r20, clayShadow1, clayRim, padding md) with a **composed 2×2 grid** (4-across ≥768dp). Cells split by **1px inset dividers at borderStrong** (the shared strong-divider spelling). Cell = TypeMicro kicker (11/600 uppercase 0.8 tertiary) → TypeStat value (28 mono-medium, ink) → optional one-line TypeMicro caption. The four cells, all from the selected window: **Tokens** (formatTokens(totalTokens), caption in/out), **Cost** (formatUsd, caption avg/day), **Turns** (formatCount(requests)), **Peak day** (formatTokens(peak.tokens), caption shortDate · busiest). Cell minHeight 88. The all-time counters leave the headline.

**§2.3 The daily chart** — the ClayCard + chartPad + scale row + dashed gridlines + baseline + rx 2 bars + 350/12 capped grow + tap-to-detail + DayDetailLine (peak default) all unchanged. Changes: `barWidth = max(1, min(columnWidth × 0.62, 10))`, centered (`x = index*columnWidth + (columnWidth-barWidth)/2`); **weekday tick row only in the 14-day window** (labels every 2nd column, TypeMicro 10 tertiary); **today anchored** (last bucket: label "today" in accentDeep 10/700, bar emphasis 1); the Activity grid section is REMOVED (tombstone ActivityGrid).

**§2.4 Models** — one ClayCard: the R117 donut untouched (stroke 8, dim 0.35, center shortModelName + share, mutual highlight) + below it the ranked list (ModelLegendRow grammar: name-hash dot 12 + TypeMono name + share % + tokens right-aligned + cost · calls caption), rows carry 1px borderStrong dividers, minHeight 44; the cap moves 6 → 8 with the honest "+N more models" line. The per-model carousel is DELETED (ModelCarouselCard dies). Header stays `Models · last month` / `· last 3 months`.

**§2.5 Tools/Keys** — unchanged data/grammar; gain the same 1px row dividers.

**§2.6 Projects all-time** — collapsed rows KEEP (the owner likes them). The expansion:

**The session row anatomy:**
```
Session title — TypeBodyStrong 15/600, 2 lines, tail         [status badge]
● glm-5.2  (name-hash dot 10 + TypeMono 11)          3d ago
                    1.2M · $0.42 (TypeMono 13, right-aligned pair)
────── 1px borderStrong divider (not after the last row) ──────
```
- Title: 2-line, tail; the `Session {id}` fallback stays.
- **The honest status tag**: a Badge renders ONLY when `status !== "queued"` — running → "running" (warning), completed → "done" (success), failed → "failed" / cancelled → "stopped" (danger), unknown raw → neutral. **`queued` shows NOTHING — the absence of a badge is the information.** New pure helper `sessionStatusBadge(status)` → `{label, tone} | null`.
- Last activity: `timeAgoFromIso(endedAt ?? startedAt)` TypeMicro tertiary.
- Numbers: `formatTokens(input+output)` TypeMono 13 textSecondary + " · " + `formatUsd(costUsd)` TypeMono 13 text — right-aligned pair.
- Model chip: name-hash dot 10 + TypeMono 11 (KEPT — the owner liked it).
- Row minHeight 56, paddingVertical sm.
- **The well**: the sessions render inside a recessed container — `surfaceWell` fill + hairline clayRim + RADIUS_INPUT + marginHorizontal sm + padding sm + overflow hidden; a 1px borderStrong divider separates the project header from the well.
- Caps stay: PROJECT_SESSIONS_PREVIEW = 5 + "+N more sessions" + the sub-agent line.

**§2.7 The disclosure motion** — Expand: `withSpring(target, DISCLOSURE_SPRING)` (LANDED: {180,24} — ζ 0.894, one soft settle). Collapse: height `withTiming(0, 200ms ease-out)` + opacity `withTiming(0, 150ms)` — a timing curve cannot overshoot. The chevron: expand on DISCLOSURE_SPRING, collapse on the timing. Reduced motion snaps. The onLayout re-measure rides DISCLOSURE_SPRING.

**§2.8 Tablet (≥768dp)** — the body stack gains `maxWidth: 840, alignSelf: "center"`; stats 4-across; chart + models side-by-side (row, gap lg, each flex 1); tools + keys pair when keys exist; projects full width; the selector stays self-sized leading.

## §3 Migration map

1. **dashboard.tsx** — the render-stack rewrite (selector → StatGrid → chart → models → tools/keys → projects → footer); delete the carousels + Activity section + CAROUSEL_* + FlatList + the eight icon imports; reshape DashboardSkeleton; `load()`/`selectWindow`/memos survive.
2. **usage-cards.tsx** — NEW PeriodSegmentedControl, NEW StatGrid; rewrite UsageSessionRow + the well; UsageAccordion + chevron motion split; ModelLegendRow dividers + cap 8. DELETE StatCarouselCard, ModelCarouselCard, CAROUSEL_GUTTER; tombstone ActivityGrid.
3. **NEW `usage-format.ts`** — pure: formatTokens/formatUsd/formatCount/shortDate/formatClock/timeAgoFromIso, sessionStatusBadge, sessionLastActivityIso, PERIOD_OPTIONS, localDateString — zero RN imports; usage-cards re-exports.
4. **disclosure.tsx** — the motion split.
5. **motion.ts / tokens.ts / primitives.tsx** — DONE in W1.

## §4 Doc amendments (drafted — land with W11)

**screen-archetypes.md** — replace the round-116 dashboard bullet: the dashboard is a VERTICAL instrument; horizontal snap carousels are BANNED; the five-section stack; every horizontal FlatList on this screen is a defect.

**components.md** — Segmented control (the window/scope selector grammar); The stat grid (one ClayCard, TypeMicro kicker → TypeStat → caption, 1px dividers, no icon chips); The disclosure motion (expand {180,24}, collapse 200ms timing — closing NEVER bounces); Session rows inside expansions (the honest status law — queued shows NO badge; the anatomy; the recessed well).

## §5 Verification

1. NEW `usage-format.test.ts` (pure): formatTokens table (999→"999", 1234→"1.2k", 3.4M, 15.4M, 2.1B, NaN→"—"); formatUsd (0→"$0.00", 0.03→"$0.030", 0.5→"$0.500", 1.2→"$1.20", 12.345→"$12.35"); formatCount; shortDate; **sessionStatusBadge** (queued→null, running→warning, completed→success, failed→danger, cancelled→stopped, raw→neutral); sessionLastActivityIso; PERIOD_OPTIONS (keys/labels ≤4 chars).
2. NEW `disclosure-motion.test.ts`: DISCLOSURE_SPRING = {180,24}; ζ = damping/(2√stiffness) in (0.85, 1); COLLAPSE 200 / FADE 150; SPRING/SHEET_SPRING/TAB_SPRING unchanged.
3. Existing suites stay green (chart-donut, contrast, rhythm).
4. Manual: squint test (the biggest number first, no carousel affordance); dark pairs; reduced motion; ≥768dp screenshot; tap-through of every `dashboard-window-*` testID.

## §6 Do-not-touch

TYPE_STAT + the type ladder; the R117-g chart/donut materials (DONUT_STROKE 8, DIM 0.35, monoBg track, gridlines 14%, rx 2, CHART_HUES, grow/sweep timings, mutual highlight); the contrast pins; SPRING/SHEET_SPRING/TAB_SPRING; the 12/32 rhythm; the clay surfaces; LetterAvatar; modelColor; sessionStatusLabel/Tone spellings; the formatters' existing call sites' shapes; the "all time" honesty law; PROJECT_SESSIONS_PREVIEW = 5; pull-to-refresh; the load orchestration + endpoint contracts.
