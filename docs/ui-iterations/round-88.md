<!-- last-reviewed: 2026-09-11 round-90 -->
# Round 88 — The floating to-do widget: the owner's spec, manual edits included

Date: 2026-09-11 · Version: 0.85.0 → 0.86.0 · Scope: UX + capability (the
R87 follow-through the owner re-specified)

## 0. The owner's directive (verbatim spec → implementation map)

> "How I want the to-do list to be implemented is that it will show at the
> top-right corner of the chat window, and it will be a floating view. The
> user will be shown only the current task at hand, which is being performed
> in the to-do list. When the user clicks on it, the to-do list will expand
> and show all the other to-do list entries and such. It will properly show
> the ones which have been completed as marked as done, the ones which are
> currently being done as being processed, and the ones which are yet to be
> done as normal. When the user expands the to-do list, it will not show all
> the ones at the same time. It will show only the top 10 to-do list
> entries, and the user will be able to scroll and see the other ones too.
> I am also thinking about adding the functionality to manually edit the
> to-do list and make some changes so that the agent can properly and
> easily work with them. If I feel something is off in the to-do list, then
> I can modify it and handle it properly. Make sure to give that
> flexibility and options too."

| Spec clause | Where it lives |
|---|---|
| Top-right corner, floating | `TodoFloat` — absolutely positioned in the chat card's scroll-body container (top-3 right-4, z-20 above the fade); the transcript scrolls UNDER it |
| Only the current task at hand | The collapsed pill: first `in_progress`, else next `pending`, else "All tasks done" — plus the N/M counter. Never the other rows |
| Click to expand | One click toggles the panel |
| done / being processed / yet to be done | The TodoCard visual language: green filled check (struck through) / pulsing accent dot (bold) / empty checkbox (dimmed) |
| Only the top 10, scroll for more | The rows container: `maxHeight 393px` (exactly ten 39px rows) + `overflow-y-auto`; ALL rows render; a "scroll for N more" hint appears past ten |
| Manual edit, agent works with the changes | The pencil opens the editor (content inputs, status cycling, delete, add, move up/down); Save POSTs the FULL snapshot to the NEW route — which stamps it `source:"user"` and the NEXT turn's system prompt renders the "## CURRENT TODO LIST" section with the owner-edit emphasis |

## 1. Backend

- **`routes/todo.ts` (NEW)**: `POST /sessions/:id/todo` — the owner's write
  path. Reuses `writeTodo`'s exact validation ladder (max 30, 200-char
  content, status normalize) with ONE deliberate widening: the EMPTY array
  is accepted (the widget's clear — the tool keeps its ≥1 rule because the
  MODEL has no business deleting its plan; the owner does). Persists a
  `todo.update` event with `source:"user"`; fans a `todo-updated` frame to
  any live turn's SSE via the turn registry (the R78 `user.queued` pattern)
  so second views update instantly. 404 unknown session, 409 agent-less,
  400 malformed.
- **`storage/sessions.ts`**: `latestTodoSnapshot(db, sessionId)` — the
  backward walk returning `{todos, source}` (an empty array is the CLEARED
  state, not a malformed one to skip past — the clear takes effect).
- **`tools/todo.ts`**: `writeTodo` gains `deps.source` ("agent" default —
  every pre-R88 event reads as agent; "user" from the route) riding the
  payload + the frame.
- **`agents/prompts.ts` + `prompt-registry.ts` + `runtime.ts`**: the
  "## CURRENT TODO LIST" section (registry id `todo-list`, directly after
  `background-tasks`, 24 → 25 sections — the versioned pins moved with it).
  `prepareTurn` reads `latestTodoSnapshot` fresh every turn and passes the
  non-empty snapshot into the prompt: the agent now ALWAYS knows its plan
  state — and when the owner edited the list the section says so
  ("The OWNER edited this list … their changes are the plan now"). Empty or
  absent → no section, byte-identical composition (the golden fixture's md5
  never moved — the strict-gating proof).

## 2. Frontend

- **`TodoFloat.tsx` (NEW)**: the widget (the spec table above). Data:
  `useTodoFloatState` — the LIVE turn's todo entry wins while streaming,
  the refetched fold (`toLatestTodo`) after; hidden entirely when no list
  exists (or after the owner's clear). The "EDITED BY YOU" badge on
  user-source snapshots; the LIVE pill while a turn streams; the honest
  save error keeps the draft. Save → `saveSessionTodo` → invalidate the
  session query → the fold re-reads the `source:"user"` event.
- **`api.ts`**: `saveSessionTodo`; `todo-updated` frame + `WorkingEntry`
  todo member + `toLatestTodo` all carry `source`.
- **`stream-store.ts`**: the `todo-updated` handler threads `source`.
- **`AgentChatPanel.tsx`**: the mount (top-right of the scroll body, above
  the fade). The R87 stream `TodoCard` stays — the per-turn record inside
  the working section; the widget is the always-visible current-state
  surface.

## 3. Verification

| Gate | Result |
|---|---|
| agent-core suite | **95 files / 1,882 tests GREEN** (was 94/1,877; +r88-todo-edit ×5) |
| Frontend suite | **62 files / 960 tests GREEN** (was 157 files / 2,839 root-wide; +TodoFloat ×10) |
| Lint (eslint .) | CLEAN |
| Typecheck (tsc) | CLEAN |
| Build (shared + agent-core + vite) | SUCCESS |
| e2e (vs built dist) | 12/12 GREEN |
| CI (windows-latest) | **run 34588692731 SUCCESS** on the R88 push 3864f7b — the full verify pipeline green |
| Release workflow | **run 34588694409 SUCCESS** — v0.86.0 installer (36.6 MB) + kit (96 KB) built, PUBLISHED at close-out (both assets verified, zero drafts remain) |
| Registry pins | prompt-registry + r73-modes-backend updated 24 → 25 (versioned-by-design); MODES_CTX completeness gate opened for todo-list; the BYTE-IDENTITY golden unchanged (strict gating proof) |

New tests: the route contract (200 + normalization + source event, 404/409/
400 ladder, the empty-clear), the prompt section (user-emphasis, agent-plain,
empty-absent), the widget (collapsed shows ONLY the current task, the
12-rows-in-a-10-row-box scroll contract, EDITED BY YOU, the full editor flow
— content/status/delete/add/reorder → the saved snapshot, honest save
errors, the live/folded merge).

## 4. Known residuals

- A live turn does NOT see a mid-stream edit in its ALREADY-ASSEMBLED
  context (the section rides the NEXT turn's prompt — the widget's footer
  note says exactly this). Mid-turn injection would need a queued-context
  mechanism that does not exist yet.
- The stream `TodoCard` and the floating widget render the same snapshot
  in two places by design (the card is the per-turn history record, the
  widget the current state); if the owner wants the card gone, it is a
  one-line removal in `WorkingSection`.
- The R86-era modularity queue (Wave 2-b, the remaining 51 routes) is
  unchanged.
