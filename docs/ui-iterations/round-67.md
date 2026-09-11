<!-- last-reviewed: 2026-09-11 round-90 -->
# Round 67 — The bridge round: the embedded browser actually works on Windows, sessions own their tabs, chat images become files, the key tool presses keys, and screenshots show live

**Date:** 2026-09-05 · **Branch:** `main` · **Version:** 0.67.0 · **Owner
directive (verbatim, the 0.66.0 live Windows field report — via
`agent-ctx/R67-plan.md`):** 13 failure clusters. The browser: the agent
navigated and "the panel stayed blank until I pressed Enter in the address
bar" ("no native webview for tab"), every page action failed with "the page
rejected the script", and a NEW chat session drove the PREVIOUS session's
still-open tab ("the embedded browser window of the OTHER session was shown
/ driven"); the panel resize felt like an "overlay kind of vibe" (should
feel "native… part of the right sidebar itself"). Attachments: "I uploaded
an image directly in chat and the agent said the image doesn't exist. It
does not actually upload the image, it just shows the path." Computer use:
list_apps empty twice ("the PowerShell session died before emitting JSON"),
get_app_state on a WebView2 pid → "no running application matches", the
mini window disappearing during thinking gaps, and `key "tab"` typing the
letters t-a-b. Debug reports: "make sure the debug report will properly show
the details, like which model was being used… when I copy it directly" — a
proper Copy button at the very bottom + auto-minimize (expanded while the
analyst types, collapses by itself when done), and a SECOND copy option
exporting the whole turn, visible ONLY when debug mode is on. Visibility:
"if the agent takes screenshots or does some image work, then the images
should be shown during its thinking in the agent's chat window itself, in a
small view (like what screenshot was taken and such)."

R66 shipped the live-fire patch; the owner then ran 0.66.0 LIVE on Windows
and this round is that field report's fix set — every complaint below has a
confirmed root cause in the code (four parallel Explore agents located them
all before a line was written), not a guess.

| ID | Workstream | Files owned |
|---|---|---|
| R67-0 | Orchestrator kickoff: the 4 explorations + this plan | `agent-ctx/R67-plan.md` |
| R67-E (inline) | Browser core: the navigate frame + create-on-adopt (E1), the WebView2 eval double-parse (E2), the chat-session binding + scoped get_state (E3), the per-project cookie profile wire-up (E4), the instant sidebar width in Tauri (E5) | `agent-core/src/tools/plugins/browser.ts`, `agent-core/src/browser-proxy.ts`, `src/lib/native-browser.ts`, `src/lib/browser-store.ts`, `src/lib/right-sidebar-store.ts`, `src/lib/stream-store.ts`, `src/components/right-sidebar/BrowserPanel.tsx`, `src/components/right-sidebar/RightSidebar.tsx`, `src/components/project-chat/AgentChatPanel.tsx` (the bind call) |
| R67-A | Attachment ingestion: `POST /attachments/upload`, the composer drop/paste/picker pipeline, renderAttachments teaching analyze_image | `agent-core/src/server.ts` (route), `agent-core/src/agents/runtime.ts`, `src/lib/api.ts`, `src/components/project-chat/composer/composer-utils.ts`, `src/components/project-chat/composer/Composer.tsx` |
| R67-B | Chat UX: the debug card's Copy button + auto-collapse, the debug-gated full-turn copy | `src/components/project-chat/DebugReportCard.tsx`, NEW `src/lib/turn-copy.ts`, `src/components/project-chat/AgentChatPanel.tsx` (TurnFooter/AssistantTurn) |
| R67-C | Computer-use robustness: -EncodedCommand capsules, the U32 guard + Get-Process fallback, resolveAppRef retry + probeNote + the helper-process refusal, the SendKeys key table + the focused readback, the monitor turn-holds | `agent-core/src/computer/backends/windows.ts`, `agent-core/src/computer/backends/interface.ts`, `agent-core/src/computer/dispatch.ts`, `src/lib/computer-monitor-store.ts`, `src/components/ComputerMiniWindow.tsx` |
| R67-D | Live screenshot thumbnails: the raster cache + the raster route + the `screenshot` SSE frame + the strip | NEW `agent-core/src/computer/raster-cache.ts`, `agent-core/src/server.ts` (route), `agent-core/src/tools/plugins/computer-use.ts`, `agent-core/src/tools/plugins/browser.ts` (screenshot action), `src/lib/api.ts`, `src/lib/stream-store.ts`, NEW `src/components/project-chat/ScreenshotStrip.tsx` |
| R67-E (sub) | Prompts + skills + tool descriptions teaching the R67 truth; the golden fixture regenerated | `agent-core/src/agents/prompts.ts`, `agent-core/src/storage/skills.ts`, `agent-core/src/tools/plugins/browser.ts` + `vision.ts` (description strings), `agent-core/tests/fixtures/prompt-golden-r61.txt` |
| R67-F | The docs round (this file + the runbooks + CHANGELOG + HANDOFF + IMPLEMENTED-API + indexes) | `docs/**`, `CHANGELOG.md`, `HANDOFF.md` |

## E1 — navigate is transported (the blank-panel fix)

**Root cause (confirmed in code):** `navigate` only mutated the sidecar's
history. The panel learned about agent navigation solely through its 4 s
poll — and on a freshly auto-opened tab the poll's adopt path set the tab's
`currentUrl` WITHOUT ever creating the native WebView2 child, so the panel
stayed blank until the user pressed Enter in the address bar (the owner's
exact reproduction; the engine log's "no native webview for tab" line).

**Fix (three legs):**
- `navigate` / `back` / `forward` / `reload` now emit the
  **`browser-navigate`** SSE frame `{tabId, url}` the instant the sidecar
  history changes (turn-independent on the frontend — the stream-store
  handles it BEFORE the live-turn guard, mirroring R66's
  `browser-viewport`);
- the stream-store routes it to `browser-store.applyAgentNavigation(tabId,
  url)` — patches `currentUrl` and bumps `agentNavSeq` (creating the tab
  slice when unknown), and the mounted BrowserPanel's effect navigates —
  or CREATES — the native webview on any seq bump;
- the poll's adopt path is fixed as the backstop: an unknown commanded URL
  with `!nativeReadyRef` now CREATES the webview (`nativeCreate(serverUrl)`)
  instead of silently adopting the URL — covering frames missed while the
  panel was unmounted.

**Tests:** browser-tool (frame emission + emit-throws-never-breaks),
BrowserPanel 36 → **38** (the agentNavSeq navigate-or-CREATE effect + the
poll create-on-adopt backstop), stream-store (the navigate frame intercept).

## E2 — the WebView2 eval double-encoding (the "page rejected the script" fix)

**Root cause (confirmed in code):** on Windows, wry's `eval_with_callback`
rides WebView2's `ExecuteScriptAsync`, which returns the script's result
value **JSON-encoded**. The eval scripts end with
`return JSON.stringify(...)`, so the callback string arrived DOUBLE-encoded
(a string that is itself JSON) — one `JSON.parse` yields a STRING,
`data.ok` is undefined, and every `click`/`type`/`press_key`/`eval`/
`read_dom`/`source`/scroll-probe action failed with "the page rejected the
script". The sandbox's mocks (and Linux webkitgtk) single-encode, which is
exactly why every test stayed green while the owner's real machine failed.

**Fix:** `parseWebViewEvalJson` in `src/lib/native-browser.ts` — the
tolerant DOUBLE-parse (parse once; if the result is still a string, parse
again; a non-JSON string survives as the raw string — honest, the caller
validates the shape). Applied to `nativeTabEval` (with honest
unexpected-payload errors that quote the raw payload) and
`nativeTabScrollState` (the pop-out gutter scrollbar was dead on Windows for
the same reason).

**Tests:** native-browser 12 → **21** (the double-encoding matrix —
single-encoded, double-encoded, non-JSON — plus the eval/scroll shape
probes on both transports).

## E3 — chat-session → browser-tab binding (the leak fix)

**Root cause (confirmed in code):** the tool's default target was the
process-global LRU tail — whichever tab ANY session touched last — plus a
shared `"agent"` fallback and a shared `_default` cookie profile. A new
chat session inherited (and navigated) the previous session's still-alive
tab, and `get_state` listed EVERY session's tabs globally, inviting the
model to drive them.

**Fix:**
- `browser-proxy.ts` carries a module-level `chatSessionBindings` Map
  (chatSessionId → browserSessionId; it survives the session store's LRU
  eviction). **`POST /browser/bind`** `{chatSessionId, sessionId|null}`
  declares it: AgentChatPanel posts the chat session's ACTIVE right-sidebar
  browser tab (or null) just before every turn starts — fire-and-forget,
  a failed bind just means the tool mints.
- The tool's default target resolution is now: explicit `sessionId` param >
  the chat session's binding > MINT a deterministic `ag-<chatSession>` tab
  (bind it, and announce it with the **`browser-open`** SSE frame
  `{tabId, chatSessionId, url:null}` so the sidebar opens a REAL tab whose
  id IS the sidecar session id — panel, bridge and history all align on one
  id). The global-LRU/"agent" fallback survives only for no-chat-session
  contexts (catalog/test), with an honest note in the tool output.
- The stream-store's `browser-open` handler lands the tab via
  `right-sidebar-store.openBrowserForChatSession(projectId, chatSessionId,
  tabId, url)`: the tab lands in the CHAT session's slice even when it is
  not the active one (a background turn browses into its own session's
  sidebar, never the visible one); the slice auto-opens only when it IS the
  active session's; idempotent re-fires patch the URL.
- `get_state`'s tab list is SCOPED to the addressed tab (plus the explicit
  param) — the agent always sees exactly its own tab.

**Tests:** browser-tool 43 → **49** (the 3 old default-target pins
rewritten to the binding semantics, the bind route validation + null-clear,
the mint/isolation test, the frames tests), stream-store (open frame
active + background), right-sidebar-store 8 → **11**
(openBrowserForChatSession active/background/idempotent), AgentChatPanel
(the bind POST before the stream).

## E4 — per-project cookie profiles

The R46 wire-up is real now: `POST /browser/session` accepts `body.projectId`
(validated like every id) and `store.create(sessionId, projectId)` binds the
session's cookie profile on creation — sticky, re-bindable on an explicit
re-mint. The frontend's mount mint passes the PROJECT id, so two projects'
tabs no longer share the `_default` jar. (The R46 migration + per-profile
jar store were already in place; the missing piece was the id actually
riding the mint.)

**Tests:** BrowserPanel's mint `projectId` pin (part of the 38).

## E5 — the sidebar width snaps in Tauri (the "overlay vibe" fix)

**Root cause:** in the desktop shell the embedded page is an OS-level
WebView2 CHILD floating above all app HTML, glued to the panel placeholder
by a bounds-sync loop. During the 200 ms animated width change the webview
LAGGED behind the shrinking/growing placeholder and visually floated over
the chat.

**Fix:** `RightSidebar`'s width transition is `duration: isTauri() ? 0 :
0.2` — instant snap in the desktop shell so the rAF-debounced sync keeps
the webview pixel-glued; the smooth animation stays for the web build (pure
DOM, no floating layer). (The auto-open bump also no longer mints a
null-URL tab — the `browser-open` frame owns tab creation, killing the
duplicate blank tab.)

**Tests:** RightSidebar **15** (the 4 auto-open tests rewritten to the
two-step bump+frame flow).

## A — attachment ingestion (the "image doesn't exist" fix)

**Root cause (confirmed in code):** dropped/pasted image BYTES were
discarded client-side (a NUL-sniff read kept only a text head), the wire
`MessageAttachment` has no byte field, the sidecar's send validator drops
unknown fields, and `renderAttachments` rendered `a.name` ONLY — so the
model invented paths (`C:\Users\...`) and `analyze_image` ENOENT'd.

**Fix:**
- **`POST /attachments/upload`** (server.ts, same bearer scope as
  `/attachments/read`): body `{projectId, name, dataBase64?|absolutePath?}`
  — EXACTLY ONE source. Name is sanitized to a plain filename (no
  separators, no `..` anywhere, no control chars, ≤200 chars; the extension
  survives). `dataBase64` is strict-validated (regex + length%4 +
  round-trip decoded length) and capped at **8 MB decoded** (the
  analyze_image ceiling); `absolutePath` must be absolute and readable
  (honest 400s). Persists INSIDE the project at `<root>/attachments/<name>`
  with a **per-route 12 MB bodyLimit** (fastify's 1 MB default would 413 the
  ~10.7 MB base64 body before the handler ran). **Dedupe, never overwrite:**
  identical content (size AND bytes) reuses the incumbent; different content
  mints `-2`/`-3`… before the extension (cap 100 → 409). Reply
  `200 {path: "attachments/<final-name>", name, size}` (project-relative).
- **Composer:** every staged chip with `dataBase64` and no path is uploaded
  first (the chip's path becomes the returned project-relative path and
  rides the send; a failed upload keeps the old honest behavior + a
  per-file toast; an `uploadingRef` guards the async window); the OS-picker
  BINARY read (text:null, ≤8 MB, absolute) is INGESTED by absolute path
  (the sidecar copies it in); NEW `onPaste` on the textarea routes clipboard
  image files into the same pipeline (text-only pastes stay native).
- **renderAttachments (runtime.ts):** an image attachment with a path now
  renders `\n--- attached image: <name> (saved in the project at <path>)
  ---\nUse analyze_image with path "<path>" to view it.` — the exact call
  the model should make; non-image path-bearing files keep their render
  plus the path line; path-less attachments render byte-for-byte the R50
  shapes.
- `shared/src/index.ts` comment-only: `MessageAttachment.path` is documented
  as RELIABLE for uploaded copies (bytes never ride the wire or the event
  log — they go straight to the upload route).

**Tests:** composer-attachments 33 → **58** (both modes, bytes-on-disk,
dedupe reuse/-2/-3, the 8 MB cap, invalid base64, unsafe names, unknown
project, both/neither sources, absolutePath honest 400s, bearer 401; the
renderAttachments image contract incl. the exact string), Composer 65 →
**71** (dropped binary → upload + path on the wire; failed upload → old
behavior + toast, send never blocked; pasted image; picker binary →
ingest), api.test 90 → **93** (the upload/ingest POST bodies + the
ApiError mapping).

## B — the debug card's copy + auto-collapse, and the full-turn copy

**Root cause / directive:** the R66 card had no copy affordance and stayed
expanded forever; the owner wanted a Copy button at the very bottom that
carries the model + full report, auto-minimize on completion, folded cards
minimized — and a second, debug-gated copy exporting the whole turn.

**Fix:**
- `DebugReportCard.tsx`: the header row is now the collapse toggle
  (aria-expanded, rotating chevron, userTouched on tap); open defaults to
  `state === "streaming"`; a `useEffect` collapses on the streaming→done
  flip unless the user touched it (ThoughtRow's exact contract — folded
  cards mount with state "done" → collapsed); the body rides
  AnimatePresence (height/opacity, the ThoughtRow transition). The NEW
  footer (done + non-empty text) sits OUTSIDE the collapse — a "Copy
  report" pill writing `buildDebugReportCopyText(report)` =
  `Debug report — model: <model|unknown>\n\n<text>` — so the minimized card
  still offers the copy and the payload always answers "which model was
  being used".
- NEW `src/lib/turn-copy.ts`: `buildFullTurnText({working, finalText,
  model?, ms?})` — pure, no store imports. The export format:
  `=== ACUTE-CODE turn export (debug) ===` + `Model: X | Duration: Yms`
  header, the USER NARRATION / THINKING banner, `[THINKING]`/`[TEXT]`
  lines in order, `--- TOOL n: name ---` blocks (args +
  `result: ok — <outputSummary>` / `FAILED — …` / `pending (call in
  flight)`), APPROVAL blocks, `--- FINAL ANSWER ---` tail; empty entries
  skipped; ~100 KB cap keeping the TAIL with the honest truncation marker.
  Docblock pins the honesty limit: tool outputs ride the persisted
  `outputSummary` (runtime-capped at 4 000 chars at emit time) — the raw
  output never crosses the wire.
- `AgentChatPanel.tsx`: `TurnFooter` gained a SECOND CopyButton ("Copy full
  conversation (debug)", Braces glyph) next to the plain one, rendered only
  when `fullCopyText !== undefined`; the panel queries the shared
  `["debug-settings"]` key (the SettingsPage cache — no second fetch
  pattern) and threads `fullCopyText` through `MessageRenderer` →
  `AssistantTurn` (folded turns: the persisted working entries + model +
  ms; the live-completed footer: working + streamText + the panel's
  effectiveModel + wall-clock duration).

**Tests:** DebugReportCard 8 → **17** (collapsed-by-default-when-done,
expanded-while-streaming, the auto-collapse flip, manual-tap-wins, the Copy
report payload + Copied flash, no-copy-while-streaming/error/empty, the
collapsed-mount copy), turn-copy **9** (NEW — the format, ordering, FAILED
shapes, unknown-model fallback, approvals, skipping, pending, truncation),
AgentChatPanel 20 → **22** (hidden when debug is off; visible + clipboard
payload with the model header, TOOL block and FINAL ANSWER when on).

## C — computer-use robustness (capsules, the key table, the monitor hold)

**Root causes (confirmed in code):** list_apps rode PowerShell **stdin**
under `-Command -` (PS 5.1's exit-0-on-abort quirk + an EPIPE-swallowed
stdin write → "the PowerShell session died before emitting JSON" while
tasklist worked); the unguarded Add-Type compile aborted the whole script
whenever csc was cold; `get_app_state` on a WebView2 renderer pid emitted
the generic "no running application matches"; the `key` tool mapped key
names to LITERAL TEXT (key "tab" typed t-a-b; chords never composed); and
the monitor's 6 s liveActivity decay closed the mini window while the agent
THOUGHT between tool calls.

**Fix:**
- **`-EncodedCommand` capsules:** the script rides ARGV as the base64 of
  its UTF-16LE text (PowerShell's contract) — no stdin, killing both
  failure modes. The biggest capsule (~8 K chars → ~22 K base64) stays
  under the 32 767-char CreateProcess ceiling (documented in the file).
- **The U32 guard:** the one Add-Type is wrapped in try/catch setting
  `$script:U32_OK`; SetProcessDPIAware, the EnumWindows walk, raw input
  scripts and the cursor/focused/frontmost probes all gate on it — and
  `list_apps`'s Get-Process MainWindowTitle fallback is finally REACHABLE
  (it was dead code: the unguarded compile aborted the script before any
  output), its entries carrying an honest `source:"get-process-fallback"`
  field. `list_windows` under the guard emits the empty-with-note shape —
  invented bounds stay forbidden.
- **probePermissions** grew a THIRD probe: a bare `-EncodedCommand`
  capsule running `Add-Type -TypeDefinition 'public class AcuteProbe {}'`
  (the flaky cold-csc compile the old probe never exercised), reported as
  `addTypeOk` (Windows only; linux/macos omit the field — absence means
  "not probed", never "failed").
- **resolveAppRef:** a FAILED-empty listApps (empty + a diagnostics note)
  is retried exactly once; if still empty-with-failure, the
  tier-5/bundleId/empty-ref app_not_found refusals carry `probeNote` (the
  note) so the agent sees WHY there is no list. A benign empty (no note) is
  not retried. Tier-1 pid semantics untouched (an exact pid still resolves
  with ZERO listApps calls).
- **The helper-process refusal:** a live-or-unknown pid owning no
  accessible top-level window (get_app_state / find_elements / type / key)
  refuses with "process <pid> is running but owns no accessible top-level
  window — it may be a helper/child process (e.g. a WebView2 renderer);
  target the HOST application instead (see list_apps)" + recovery + payload
  `{pid, processRunning, ownsAccessibleWindow:false}`; a confirmed-dead pid
  keeps the plain "not running" shape.
- **THE key fix:** `composeSendKeysChord` (windows.ts) — the key-name →
  SendKeys table (enter/return, tab, esc/escape, backspace, delete/del,
  space, up/down/left/right + arrow* aliases, home, end, pageup/pgup,
  pagedown/pgdn, insert, help, f1..f12) + LEADING modifier prefixes
  (ctrl/control → `^`, shift → `+`, alt/option → `%`) + single printable
  characters with the documented brace-escape set. `rawKey` composes ONE
  `SendWait(chord)` — `key "tab"` sends `{TAB}`, `ctrl+a` sends `^a`, never
  literal text. The Windows/Meta key REFUSES honestly (SendKeys has no such
  modifier) without spawning a capsule; unknown names list the full
  supported set. Dispatch's `splitKeyChord` preserves a literal `'++'` as
  the plus key while ordinary chords stay byte-identical for the Linux
  xdotool join.
- **The Tab-walk readback:** after a successful key press, the receipt
  carries `focused: "<element name>"` (best-effort — null/empty/throwing
  omits the field, never fails the key). Combined with the key table this
  makes the owner's Tab-walk technique real: press `key "tab"` repeatedly
  and read the focused element from each receipt.
- **Monitor turn-holds:** the store gained `turnHolds` +
  `holdForTurn(sessionId)` (a stable latch — no liveActivity bump, no decay
  arm) + `releaseTurnHold` (turn end) + `noteStopSignal` (the
  stop_computer_control frame: rest the signal + clear the hold). The
  stream-store holds on every computer-use frame during an open turn and
  releases in the finally block (every terminal path). The mini window's
  live signal is now `(liveActivity || anyTurnHold) && !killSwitch` — the
  pill survives thinking gaps while a computer-use turn is open, and
  browser-only turns never hold (the R66 guarantee is structural).

**Tests:** computer-windows-backend 30 → **48** (the -EncodedCommand argv +
a decodeCapsuleScript helper asserting the decoded script; the U32 guard
pins; the reachable fallback + source field; the full chord table/escapes/
meta-error/unknown-error matrix; rawKey's composed chord + refusal without
a capsule; the three-probe probePermissions), computer-dispatch 52 → **65**
(retry-once, probeNote, benign-empty no-retry, the pid zero-calls pin, the
helper-process refusal across get_app_state/type/key, the splitKeyChord
matrix, the focused readback incl. null/empty/throwing), computer-monitor-
store **9** (NEW — hold/no-bump/no-decay, multi-hold release,
decay-fires-while-held, noteStopSignal scoped/unscoped, clear hygiene),
ComputerMiniWindow 10 → **13** (hold-alone shows the pill, NO-FLAP across a
simulated decay fire, noteStopSignal hides).

## D — live screenshot thumbnails

**Root cause / directive:** captures' PNG bytes lived only inside the tool
call (the dispatcher's private 3-frame LRU for the vision relay; the
browser action's local raster) — the tool RESULT rides SSE as
outputSummary text, so the chat could never show the image.

**Fix:**
- NEW `agent-core/src/computer/raster-cache.ts`: the module-level raster
  registry — `registerRaster(id, pngBase64)` + `rasterFor(id)` + **LRU cap
  12** + **10-minute TTL** (expired entries are DROPPED on lookup, never
  resurrected; re-registration refreshes recency + the TTL clock).
  EPHEMERAL by design: in-memory only, never persisted, never model-facing.
- The computer-use plugin's execute wrapper emits `{type:"screenshot",
  frameId, tool, note?}` (try/catch — the frame is an enhancement, never
  breaks the tool) after screenshot / zoom (`result.data.frame.frameId`,
  note "zoomed region") / get_app_state-with-raster
  (`result.data.raster.frameId`, note "window raster"; a failed capture
  emits nothing); the browser_control screenshot action mints
  `bs_<base36>` (matching the route's id regex — no session frame exists
  for browser captures), registers, and emits with tool
  `"browser_control"`, note "browser panel". Both pull the bytes via the
  dispatcher's PUBLIC `rasterFor` right after dispatch (before the 3-frame
  LRU can evict).
- **`GET /computer-use/frames/:frameId/raster`** (server.ts, same bearer
  wall): frameId validated `/^[A-Za-z0-9_-]{1,64}$/` → 400; miss → the
  honest 404 envelope ("rasters are in-memory only, capped (12) and expire
  after 10 minutes"); hit → the decoded PNG, `image/png`, `no-store`.
- Frontend: the `screenshot` frame in `StreamTurnEvent`; the stream-store
  appends to `liveTurn.screenshots` (NEW, newest-LAST, **cap 8** — the
  handler sits AFTER the liveTurn guard like debug-*: rasters belong to the
  turn that captured them; the folded log owns no screenshot history by
  design since the bytes expire anyway); NEW `ScreenshotStrip.tsx` mounts
  in AgentChatPanel's LIVE block under the WorkingSection — each tile
  lazy-fetches the raster (a dedicated binary `fetchComputerFrameRaster`
  with its own Authorization header; object URL revoked on unmount), the
  caption names the capturing tool, a fetch failure renders the quiet
  "expired" tile, and a click opens the Dialog with the full image +
  timestamp + the 10-minute-lifetime note. The strip imports no stores —
  config rides the fetch helper's internal read.

**Tests:** raster-cache **7** (NEW — round-trip, honest-null, LRU eviction
at 13, recency on re-registration, the exact TTL boundary via fake timers,
the reset), computer-use-plugin 15 → **21** (frame + registry on
screenshot/zoom/get_app_state, no frame without a raster, refusal → no
frame, evicted raster → no frame + the tool still ok), server.test →
**25** (200 image/png + no-store + exact bytes, the 404 envelope, 400
malformed id, 401 without the token), stream-store **45** (append
newest-last, cap 8, the no-liveTurn guard, the fresh-turn reset),
ScreenshotStrip **6** (NEW — hidden when empty, the lazy fetch + img, the
expired tile, the dialog, revoke-on-unmount, one tile per capture).

## F2 — the prompts, the skill, and the tool descriptions

The code fixes only help if the model is TAUGHT the new truth (the owner's
transcript showed it driving the embedded browser with computer-use tools —
left_click/scroll/mouse_move/run_command/list_apps — because the bridge was
broken, and guessing `C:\...` paths for chat attachments):

- **prompts.ts** (titled bullets inside the EXISTING sections — the R66
  precedent; no new registry id, so the prompt-registry completeness
  contract holds as-is): tool-use Rules "IMAGE ATTACHMENTS (R67)" (the
  `saved in the project at <path>` contract: call analyze_image with the
  path EXACTLY as rendered, never guess, never ask the user to re-attach —
  gated on analyze_image being in the allowlist); computer-use
  "TAB-WALK DISCOVERY (R67)" (key "tab" + the FOCUSED-element receipt
  readback, combined with find_elements in big apps); browser-panel
  "ROUND-67 — THE EMBEDDED BROWSER IS YOURS" (omit sessionId → THIS chat
  session's OWN tab, auto-opened; get_state lists only this session's tab)
  + "DRIVE THE PANEL ONLY WITH browser_control (R67)" (NEVER computer-use
  tools on the panel — browser work must never show "agent is using your
  computer"; the bridge WORKS: read_dom first, then click/type the SELECTOR
  PATHS, submit:true / press_key Enter). Three stale R66 lines were
  CORRECTED to the R67 truth (get_state "every open tab" → this session's
  tab ×2, the default-target claim).
- **storage/skills.ts** (the built-in computer-use skill): two new tight
  paragraphs — "Tab-walk discovery (R67)" and "The embedded browser is NOT
  a desktop app" (browser_control ONLY, never computer-use tools on the
  panel). Body stays ≤60 content lines (37 → 41, the pin holds).
- **Tool descriptions** (browser.ts / vision.ts — strings only, zero logic):
  read_dom "call it FIRST and click/type the exact selector paths it
  returns"; get_state "EVERY open tab" → "this chat session's tab"; the
  sessionId sentence → "omit it to drive THIS chat session's own tab
  (auto-opened for you; never another chat session's tab)"; the honest
  web-dev-mode bridge note; analyze_image teaches "Image attachments from
  chat are saved into the project at attachments/<name> — analyze them with
  the path EXACTLY as rendered in the user message, never a guessed one".
- **The golden fixture** regenerated by the sanctioned procedure (a
  temporary vitest spec composing the identical FULL_CTX through the REAL
  builder, deleted after the run): 21 079 chars; the byte-identity test's
  comment records the R67 regeneration + the three honest R66 corrections.

**Tests:** prompt-registry 11 → **14** (a ROUND-67 describe: the
browser-panel pins incl. NOT-contain pins proving the retired R66 claims are
gone, the TAB-WALK pins, the IMAGE ATTACHMENTS pins incl. the
analyze_image gate), skills-mcp 11 → **12** (the skill body pins),
browser-tool 48 → **49** + vision-plugin 13 → **14** (the description
contracts), r65-honesty-patch unchanged at **7**.

## The architecture (the binding + the two new frame flows)

```
BIND + OPEN (E3)                                INSTANT NAVIGATE (E1)
AgentChatPanel.runTurn                          tool: navigate|back|forward|reload
  │ the chat session's ACTIVE sidebar tab         │ sidecar history mutates
  ▼                                                ▼
POST /browser/bind {chatSessionId, sessionId}  browser-navigate SSE frame {tabId, url}
  │ (null = the tool mints)                        │ turn-independent (BEFORE the
  ▼                                                ▼ liveTurn guard)
browser-proxy: chatSessionBindings Map         stream-store → browser-store
  │ tool default: explicit > binding > mint      .applyAgentNavigation (url+agentNavSeq++)
  ▼                                                ▼
unbound → mint "ag-<chatSession>" + bind       BrowserPanel agentNavSeq effect
  ├─SSE─▶ browser-open {tabId, chatSessionId,    ├─ webview alive → nativeTabNavigate
  │        url: null}                            └─ no webview → nativeCreate  ← the fix
  ▼                                               (4s poll backstop: adopt now CREATES)
right-sidebar-store.openBrowserForChatSession
  └─ tab lands in the CHAT session's slice (id ==
     the sidecar session id); auto-open only when
     it IS the active slice — background turns
     never yank the visible sidebar.

THUMBNAILS (D)                                  EVAL DECODE (E2)
tool: screenshot/zoom/get_app_state(+raster)    page action → ONE eval script
  browser_control screenshot (mints bs_<base36>)   │ the bridge (SSE→UI→Rust→WebView2)
  │ capture ok                                     ▼
  ▼                                              ExecuteScriptAsync result is
registerRaster(frameId, png)                    JSON-ENCODED; our script returns
  (LRU 12 · TTL 10 min · in-memory)             JSON.stringify(...) → DOUBLE-encoded
  ├─SSE─▶ {type:"screenshot", frameId, tool}    parseWebViewEvalJson: parse once;
  │        (AFTER the liveTurn guard —          still a string? parse AGAIN → both
  │         turn-scoped, cap 8)                 transports decode (WebKit 1×, WebView2 2×)
  ▼
ScreenshotStrip: lazy GET /computer-use/frames/:frameId/raster (bearer,
image/png, no-store) → <img> tile → click → dialog; 404 → "expired" tile.
```

## Verification (re-run this round, fresh)

- Root `npx vitest run`: **1961/1961 in 122 files** (was 1807/118).
- Splits, measured this round: agent-core **1064/1064 in 59 files**;
  frontend `src/` **885/885 in 61 files**; root `tests/` e2e **12**.
- The R67 suites, each re-run scoped THIS round (counts as measured — two
  sub-agent worklog counts drifted and the code wins, noted below):
  composer-attachments **58** (was 33) · raster-cache **7** (NEW) ·
  computer-windows-backend **48** (was 30) · computer-dispatch **65**
  (was 52) · computer-use-plugin **21** (was 15) · server.test **25** ·
  browser-tool **49** (was 43) · vision-plugin **14** (was 13) ·
  prompt-registry **14** (was 11) · skills-mcp **12** (was 11) ·
  r65-honesty-patch **7** · turn-copy **9** (NEW) · DebugReportCard **17**
  (was 8) · AgentChatPanel **22** (was 20) · Composer **71** (was 65) ·
  computer-monitor-store **9** (NEW) · ComputerMiniWindow **13** (was 10) ·
  stream-store **45** · BrowserPanel **38** (was 36) · RightSidebar **15** ·
  right-sidebar-store **11** (was 8) · native-browser **21** (was 12) ·
  ScreenshotStrip **6** (NEW) · api.test **93** (was 90).
- `pnpm lint` CLEAN · `pnpm typecheck` CLEAN (repo-wide) ·
  `pnpm version:check` 0.67.0 ×4 · `pnpm docs:check` 0/0.
- The round's live battery on the rebuilt dist (one-shot invocation): `/health`
  ok; `POST /browser/bind` 200 + the honest 400 on a bad id;
  `GET /computer-use/frames/:id/raster` the honest 404 envelope + 401 without
  the token; `POST /attachments/upload` → the file ON DISK at
  `attachments/<name>` + the `-2` dedupe suffix on a different-content
  re-upload. No UI screenshots this round: every R67 frontend surface rides
  the component suites above; the owner's live Windows run is the visual
  gate for the native paths.

## What this round does NOT claim (known limitations)

- **Windows behavior is pinned by construction only** — the headless Linux
  sandbox asserts the -EncodedCommand argv + the DECODED script text, the
  composed SendKeys chords, the U32 guard shapes and the parsed fake
  stdout; PowerShell never executes here. The owner's live Windows run
  (the bridge + the binding + the key tool + the upload, in that order) is
  the real gate for E2/C/A — the double-encoding claim in particular is a
  documented contract of `ExecuteScriptAsync`, not a sandbox observation.
- **The rasters are ephemeral by design** — in-memory, LRU 12, 10-minute
  TTL; a restarted sidecar serves 404s, a reloaded chat shows no
  screenshot history (the folded turn owns none). The quiet "expired" tile
  is the deliberate honesty, not a bug.
- **The full-turn copy rides outputSummary** — `buildFullTurnText` exports
  the PERSISTED per-call summaries (each capped at 4 000 chars at emit
  time), not the raw tool outputs (they never crossed the wire); the
  ~100 KB clipboard cap drops the head, keeps the tail.
- **The browser-navigate frame needs a live SSE stream** — the frame rides
  `toolDeps.emit`, which exists only inside a live turn; a browser tool
  call outside a stream (catalog/test contexts) falls back to the 4 s poll
  (which now creates the webview on adopt — the backstop).
- **The OS-picker >512KB caveat** — a picker file above 512 KB still dies
  at `readAttachmentFiles`' read cap (the honest per-file error toast);
  the upload route's 8 MB ceiling only serves the drop/paste paths and the
  picker's ≤8 MB binary reads that pass the read gate. A future round can
  relax the picker read cap for ≤8 MB binaries.
- **The debug analyst has no `maxOutputTokens` cap** (R66, carried) and
  **the wall self-bypass stays future work** (R66, carried).

## Worklog-count drift (code wins)

Two sub-agent worklog entries and the code disagree; the runner is the
truth and the numbers above are the measured ones:
`computer-use-plugin` — the R67-D entry says "22 total", the suite measures
**21**; `server.test` — the R67-D entry says "24 total", the suite measures
**25** (likely a sibling's additive describe landing after D's scoped run).
One observed flake was NOT reproduced this round: R67-E saw raster-cache's
two TTL tests fail once mid-round under load (fake-timer tests are
load-sensitive) — they passed in every run of THIS round (full ×1, scoped
×2, and inside the agent-core full run).
