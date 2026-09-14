<!-- last-reviewed: 2026-09-12 round-97 -->
# COMPUTER-USE v2 — the Element Map & Learning Layer (R93)

**Status:** design truth for the R93 computer-use rework (the owner's
"full-fledged computer use functionality" directive, informed by the
ClickScope reference project the owner uploaded — `UPLOADED/computer-use-refrence.7z`).

**One-line summary:** ACUTE keeps everything it already owns — semantic
actuation, receipts, refusals, safety postures, the frame-hash intelligence,
the consent gate, the audit journal — and GAINS the layer it completely
lacked: **element discovery with identity, hierarchy, and learning**. Every
observation builds a persistent, per-app picture of the UI; the agent can
navigate the tree, address elements across scans, and rely on learned
reliability.

---

## 1. What was missing before R93 (the gap analysis)

| # | Missing capability | What it means for the agent |
|---|---|---|
| 1 | No hierarchy | `get_app_state` returned a FLAT list — the agent could not ask "what's inside this group?" |
| 2 | No stable identity | `stateId + index` was ephemeral (120s TTL, consumed after writes); nothing survived a re-observe |
| 3 | No cross-scan relocation | A UI that shifted by 30px orphaned every element the agent knew |
| 4 | No learning | The audit journal recorded ACTIONS; nothing recorded what was SEEN. No new/lost deltas, no per-app UI memory, no reliability counters |
| 5 | No ghost-box verification | Stale/hidden elements passed through as real (their rects were never checked against pixels) |
| 6 | No tree navigation tools | No `get_tree` / `get_children` / `get_parent` / windows overview / `element_at` |
| 7 | No window placement | No `move_window` / `window_state` / `focus_window` |
| 8 | Pattern-probe-only clickability | Text/Pane/Group nodes with real interactions failed closed with no flags |

## 2. The v2 contract (what each layer now does)

### 2.1 The Element schema (additive — walk order preserved)

`Element` gains OPTIONAL fields (old snapshots without them remain valid):

```ts
interface Element {
  // ...the existing fields unchanged (index, kind, name, value, flags,
  // bounds, actions)...
  /** Hierarchy (v2): stable node key within the snapshot, e.g. "w7-412". */
  key?: string;
  /** The window's key this element lives under. */
  windowKey?: string;
  /** The parent node's key (null on roots). */
  parentKey?: string | null;
  /** ClickScope-style breadcrumb: "Settings › Advanced › Enable logging". */
  path?: string;
  /** Depth in the tree (roots = 0). */
  treeDepth?: number;
  /** False = structural container (never click it, but walk its children). */
  interactive?: boolean;
  /** The 11 ClickScope categories (button/link/input/menu/tab/list/check/
      slider/text/custom/vision) — coarser than kind, better for filtering. */
  category?: ElementCategory;
  /** WHICH clickability layer fired (see §2.2) — "type" | "pattern" |
      "action" | "msaa" | "focusable" | "vision". */
  via?: string;
}
```

**Walk-order preservation is a HARD contract**: `index` numbers are the
flat traversal order the backends already produce; the actuation layer
re-walks and verifies by `kind + name` at an index. The new fields are
purely additional — the walkers emit them alongside, never reordering.

### 2.2 Layered clickability (ported from ClickScope's engine)

A node is `interactive` when ANY layer fires (first match wins, recorded in `via`):

1. **TYPE** — the control type inherently implies interaction (Button, MenuItem, CheckBox…).
2. **PATTERN** — Invoke / Toggle / ExpandCollapse / Value UIA patterns, probed on TYPE kinds **and on named non-type elements** (catches interactive controls hiding in generic panes).
3. **FOCUSABLE** — `IsKeyboardFocusable` (read directly off the managed `Current` view) + named + not a known container — the heuristic net.

ClickScope's ACTION (`LegacyIAccessible.DefaultAction`) and MSAA
(`AccessibleRole`) layers are **honestly absent on Windows**: those
properties live on the COM `IUIAutomation` face that
`System.Windows.Automation` (the managed bridge the walker rides) never
exposes. The first draft carried a by-id `GetPropertyValue` reader that
could not bind an int to `AutomationProperty` — the layers were inert
scaffolding; the C5 pre-release review deleted them rather than shipping
dead code. Porting them requires the COM bridge (a future, separately
tested change). On Linux (AT-SPI): the action-interface verbs + the
`STATE_FOCUSABLE` flag. On macOS (System Events): the role mapping +
`AXFocused`/focusable attribute.

### 2.3 The element map store (`computer/element-map.ts` + migration 0034)

Three SQLite tables (better-sqlite3, the same WAL database):

```sql
computer_scan      -- one row per observation (get_app_state / find_elements)
  id, ts, session_id, app_name, app_pid, window_title, window_id,
  duration_ms, total, by_category (JSON), new_count, lost_count

computer_element   -- the per-app element REGISTRY (the learning state)
  identity_hash PRIMARY KEY (app_name + window_title + kind + name + quantized rect)
  first_seen, last_seen, seen_count,
  path, category, via, interactive,
  rect_json, flags_json,
  click_count, verify_success_count   -- fed from dispatch receipts

computer_app_profile  -- per-app learned structure
  app_name PRIMARY KEY, first_seen, last_seen,
  window_titles (JSON array, most recent first), element_count,
  stable_element_count, last_scan_json (the last map's deltas)
```

**The diff loop** (runs on every registered snapshot):
1. Hash every element → compare against `computer_element` rows for this app.
2. New rows → `new_count`, with the first N names surfaced in the scan delta.
3. Rows not seen this scan → `lost_count` (rows are KEPT — `last_seen` just stops advancing; a reappearing element keeps its history and its click statistics).
4. The snapshot's tool result gains `mapDelta: { newCount, lostCount, newNames: string[] }` — the agent SEES UI churn like ClickScope's panel subtitle ("544 elements · +3/−1").

**The reliability model**: every mutating action's receipt already carries
`targetVerificationStatus` (matched/changed/unchanged) — the element-map
hooks the same signal: on a verified element action, `click_count += 1` and
`verify_success_count += 1` when the receipt confirms. The agent-facing
element rows expose `reliability: seen 12 times, 11 verified actions`.

**Cross-scan relocation** (`relocate()` port): when an element target goes
stale, the store scores candidates from the CURRENT snapshot:
name equality 4.0 / substring 2.0 · same kind 1.5 · same category 0.5 ·
position within 120px up to 2.0. Threshold 3.0. The dispatcher's
STALE_ELEMENT path offers the best candidate as `relocatedIndex` — the
model can re-target with one call instead of re-observing.

### 2.4 Ghost-box verification (`computer/verify-rects.ts`)

Before a snapshot's `detail:"full"` bounds reach the agent, every element
rect is checked against the live capture (pngjs, the framehash.ts
dependency): grayscale stddev < 5 AND Otsu minority-mask ink < 30 → the
rect is EMPTY (a ghost) → the element is flagged
`flags: [...existing, "ghost"]`... actually no: ghost elements are DROPPED
from the map (they waste the model's attention) and counted in
`mapDelta.droppedGhostCount`. Cheap (one capture per scan, N sub-rect
decodes), fail-open on decode errors (a rect that cannot be verified
passes — verification never HIDES a real element on a false positive).

### 2.5 The new tool surface (computer-use.ts)

Navigation (read-only, posture "observe" allows):
- `get_tree {appRef, maxDepth}` — the window→group→element tree (paths + categories, compact).
- `get_children {stateId, key}` / `get_parent {stateId, key}` / `get_subtree {stateId, key, maxDepth}`.
- `windows_overview {}` — every window (title, app, bounds, focused) — the "what's on screen" map.
- `element_at {x, y, frameId?}` — what is under this point (the hit-test, exposed).
- `app_profile {appName}` — the LEARNED state: stable elements, window titles, reliability leaders.

Placement (act posture):
- `move_window {windowId, x, y}` · `window_state {windowId, state: maximize|restore|minimize}` · `focus_window {windowId}`.

### 2.6 The skill rewrite (storage/skills.ts, seeded built-in)

The seeded computer-use skill body is rewritten to teach:
1. The element-first loop (find_elements / get_tree → verify with the map delta → act on {stateId, index}).
2. The mapDelta reading (+N new / −N lost tells you the app changed — re-read before acting).
3. The relocation shortcut on stale targets.
4. The reliability signal (prefer elements with verify history).
5. The tree descent for dense UIs (windows_overview → get_tree → get_children beats flat find_elements on 2000-element apps).

### 2.7 Platform compatibility

- **Windows** (primary): the PowerShell walker gains the clickability layers + hierarchy keys; window placement via SetWindowPos P/Invoke.
- **Linux**: the pyatspi walker gains role→category mapping + tree keys; placement via wmctrl.
- **macOS**: osascript System Events role mapping; placement via `set bounds`/`set miniaturized` (best-effort, the existing fail-closed posture).

## 3. Module layout (the "separate module" requirement)

```
agent-core/src/computer/
├── types.ts            # + the v2 schema fields (this doc §2.1)
├── element-map.ts      # NEW: the store + diff + relocation + app profiles (§2.3)
├── verify-rects.ts    # NEW: ghost-box pixel verification (§2.4)
├── dispatch.ts        # the integration seam (registration feeds the map)
├── session.ts         # unchanged (snapshots/frames lifecycle)
├── framehash.ts       # unchanged (already the pngjs seam)
├── backends/…         # walker upgrades per platform (§2.2)
└── …                  # audit/errors/raster-cache unchanged
```

Nothing outside `computer/` changes its behavior: the tools file
(`tools/plugins/computer-use.ts`) grows the new tools; the routes are
untouched; the frontend only reads the new `mapDelta` fields.

## 4. Testing strategy

- `element-map.test.ts` — pure store unit tests: identity hashing, diff counts, relocation scoring, reliability counters, app-profile upserts.
- `verify-rects.test.ts` — synthetic PNG fixtures: a blank rect = ghost, a text rect = real, decode failure = fail-open.
- Walker tests — command-construction pins for the new PowerShell/pyatspi properties (the established pattern).
- Tool tests — the new tools' schemas + dispatch paths + the mapDelta passthrough.
