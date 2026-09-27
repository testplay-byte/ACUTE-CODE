<!-- last-reviewed: 2026-09-27 round-131 -->
# EMBEDDED BROWSER — the agent's in-app browser panel (owner's guide)

**Status:** normative · **Established:** round-43 (the panel + the tool);
grown round-62 (read/eval/screenshot/tabs), round-66 (the page-action
surface, the bot-wall checkpoint, the instant viewport apply), round-67
(the working Windows bridge: the instant navigate frame, the WebView2 eval
decoder, the chat-session tab binding, per-project cookies), round-99
(the central in-app link router) and round-100 (the honest engine rework:
the evergreen runtime restored, the de-branded ACUTE user agent, the
engine line in Settings/About — the fixedRuntime bundle RETIRED), round-131
(the browser leap: the `download` action + the eight tool truths — click's
vanished-job re-probe, the navigation-aware wait, read_dom's rendered-text
discipline + the offset/range cursor, eval's null diagnostics, type's
requested-vs-observed echo, the nearest-match refusals, the
redirect-collapse history window) ·
**Audience:** the owner watching the panel and solving walls, and any agent
maintaining the surface

The embedded browser is a REAL web browser panel inside the app's right
sidebar — you watch it live while the agent drives it with the
`browser_control` tool. R66 grew it from a navigate/observe surface into a
**16-action page driver**: the agent can identify elements and interact with
them (click, type, press keys) WITHOUT screenshots, submit forms the way a
user does, read the page's DOM and source, SAVE FILES the way a browser's
save-as does, and PAUSE for you when a bot wall
(captcha / Cloudflare / age gate) blocks the page. It is a separate surface
from computer use: it never opens your real Edge/Chrome and never touches
your desktop (the R65 SURFACE BOUNDARY prompt line enforces the narration).

## The 16 actions (`browser_control`)

"Any mode" = works in web dev mode too (server-side state/fetch);
"native bridge" = needs the desktop app's WebView2 page — the tool sends
the script over the SSE→UI→Rust bridge and the page runs it (web dev mode
answers an honest refusal, exactly like the raw `eval` action).

| Action | One line | Where |
|---|---|---|
| `navigate` | Open/change the page (absolute http(s) URL; docs/source hosts navigate freely, other hosts ask you first — the same gate as `web_fetch`) | any mode |
| `back` / `forward` / `reload` | Walk that tab's history (honest "did nothing" at a boundary) | any mode |
| `set_viewport` | Change the display size you see — presets (mobile-sm 375×667 … full-hd 1920×1080) or custom 200–3840 × 200–4320, zoom 0.25–3, rotate swaps w/h | any mode |
| `read` | The current page's TEXT, fetched fresh server-side (the logins/JS of the live panel may differ — this is the clean fetch) | any mode |
| `read_dom` | A STRUCTURED outline of the live page as JSON — title, headings, every visible interactive element (tag, text, label, value, a short selector, size), forms with field names; `include:"all"` adds the first 80 text paragraphs; `offset`/`range` page the interactive elements on huge pages ("showing elements N..M of T") — THE way to know the page without screenshots | native bridge |
| `source` | The live page's raw material: `html` (outerHTML, whole page or one selector), `css` (stylesheets + the computed style of a selector), `scripts` (src list + inline bodies) | native bridge |
| `click` | Click an element — by CSS selector, or by a case-insensitive substring of a clickable's visible text/aria-label/name/value/title (e.g. a button's label; `nth` picks among several matches) | native bridge |
| `type` | Set an input's value with the NATIVE value setter + input/change events (React/Vue pages register it — a plain `el.value = x` is invisible to them); `submit:true` submits the form after typing | native bridge |
| `press_key` | Dispatch a key (Enter, Tab, Escape, Backspace, Delete, arrows, Space, a character) to an element or the focused element; **Enter inside a form triggers REAL native form submission** | native bridge |
| `eval` | Run JavaScript INSIDE the live page and get the value back (function-body semantics: end with `return value`; ≤20 000 chars) | native bridge |
| `download` | Save a file into the project's `downloads/` folder — the panel's own save-as: fetched with the tab's cookies + the panel's user agent + the page as referer, dedupe-named (nothing is ever silently overwritten), with a content-type + magic-byte verdict in the result; a `browser-download` frame announces it | any mode |
| `screenshot` | Capture what the panel shows + a vision-model description (needs Computer Use's capture engine enabled; the vision model is configured in Settings → Image Analysis) | bridge + capture engine |
| `get_state` | currentUrl, title, viewport, canBack/canForward + THIS chat session's tab (R67: the list is scoped to the binding — never another session's tab) | any mode |
| `wait_for_verification` | The page is blocked by a bot wall — opens the countdown card in YOUR chat and waits while you solve it (see below) | probe bridge-first, fetch fallback; the card rides the live turn's SSE |

All actions target the tab THIS chat session owns (see the binding model
below) unless the agent passes an explicit `sessionId`. Viewport/page
changes appear LIVE in the panel; the agent is taught to announce them in
one line.

## Navigation is transported (R67 — the blank-panel fix)

The owner's 0.66.0 report: the agent navigated and "the panel stayed blank
until I pressed Enter in the address bar" (the engine log: "no native
webview for tab"). Root cause: `navigate` only mutated the sidecar history;
the panel learned via its 4-second poll, whose adopt path set the tab's URL
WITHOUT creating the WebView2 child. The fix, in three legs:

- `navigate` / `back` / `forward` / `reload` emit the **`browser-navigate`**
  SSE frame `{tabId, url}` the INSTANT the sidecar history changes —
  turn-independent (the stream-store applies it before the live-turn guard,
  like the R66 viewport frame), so the page lands even while you watch a
  different turn;
- the frontend applies it immediately (`browser-store.applyAgentNavigation`
  patches `currentUrl` and bumps `agentNavSeq`), and the mounted panel's
  effect navigates — or CREATES — the native webview on any seq bump;
- the 4-second poll stays as the BACKSTOP, and its adopt path is fixed:
  an unknown commanded URL with no webview yet now CREATES the webview
  instead of silently adopting (covers frames missed while the panel was
  unmounted). The frame needs the turn's live SSE stream — outside a turn
  the poll (with the same create-on-adopt) is the only channel.

R131-B addition, the **redirect-collapse window** (the history-drift fix):
the tool's `navigate` pushes the COMMANDED url, then the panel reports the
LANDED url (`POST /browser/navigate` from its location hook) — the old
core pushed BOTH, so one navigation read as `index 1, historyLength 2,
canBack true` (the ledger's recurring complaint). Now a location report
landing within **2.5 s** of a TOOL-COMMANDED navigation REPLACES the
pending entry (its url/title update, no new index — the answer's action is
`"redirect-collapse"`), multi-hop chains all fold into the one entry, and
the window is bounded: a report that arrives late, or after a back/
forward, pushes honestly. R131-B-ui LANDED the panel half: the address
bar's own commands now send `commanded: true` (the route forwards the
flag), so an address-bar "google.com" that lands on "www.google.com" stays
ONE history entry — the same collapse the agent's navigations get. Only
the COMMAND path sets the flag; the location/title reports stay reports.

## The binding model (R67 — one chat session, one tab)

The owner's leak report: a NEW chat session drove the PREVIOUS session's
still-open tab ("the embedded browser window of the OTHER session was shown
/ driven") — the old default target was the process-global LRU tail, and
`get_state` listed every session's tabs. Now every CHAT session maps to
exactly ONE browser tab:

1. **You declare it.** Just before every turn starts, the chat panel POSTs
   **`/browser/bind`** `{chatSessionId, sessionId|null}` with the chat
   session's ACTIVE right-sidebar browser tab (the tab you are viewing in
   that session's sidebar; null when there is none). Fire-and-forget — a
   failed bind just means the tool mints.
2. **Or the tool mints one.** An unbound session gets a deterministic
   `ag-<chatSession>` tab minted server-side, bound, and announced with the
   **`browser-open`** SSE frame `{tabId, chatSessionId, url:null}` — the
   sidebar opens a REAL tab whose id IS the sidecar session id (panel,
   bridge and history align on one id), in the CHAT session's own sidebar
   slice. A background session's turn browses into ITS OWN slice — never
   the sidebar you are looking at; the slice only auto-opens when it is
   the active session's.
3. **Scoping.** Every `browser_control` action resolves its target as:
  explicit `sessionId` param > the chat session's binding > the mint.
  `get_state` lists only the addressed tab — the agent never even sees
  another session's tab to be tempted by. The legacy shared fallback tab
  survives only for no-chat-session contexts (catalog/tests), and the tool
  output says so honestly.

Cookies are PER-PROJECT now (the R46 wire-up is real): the panel's session
mint carries the project id, so two projects' tabs keep separate jars
(was the shared `_default` profile — the other half of the leak).

## The WebView2 eval decoder (R67 — "the page rejected the script")

Every page action (`click`/`type`/`press_key`/`read_dom`/`source`/`eval`)
compiled to exactly the right script on the owner's real Windows machine —
and then failed with "the page rejected the script". Root cause: WebView2's
`ExecuteScriptAsync` returns a script's result value **JSON-encoded**; our
scripts end with `return JSON.stringify(...)`, so the callback string was
DOUBLE-encoded (the JSON of a string that is itself JSON). One `JSON.parse`
yielded a STRING, the `{ok}` envelope was never seen, and every action
failed. The Linux sandbox's mocks single-encode — which is why every test
stayed green while Windows failed.

The fix is `parseWebViewEvalJson` in `src/lib/native-browser.ts`: parse
once; if the result is still a string, parse it again; a non-JSON string
survives as the raw string (honest — the caller validates the shape). Both
transports decode (WebKit after one parse, WebView2 after two), and an
unexpected payload is reported with the raw text quoted instead of the old
misleading rejection. The pop-out GUTTER SCROLLBAR probe rides the same
normalizer (it was silently dead on Windows for the same reason).

R131-B-ui addition, **the null fork**: a literal `null` payload is a REAL
signal, not garbage — WebView2's `ExecuteScriptAsync` answers the JSON
`null` when the page NAVIGATED AWAY under the eval (the old document is
destroyed; the callback fires with nothing) or when the script itself
evaluated to `undefined` (an undefined return serializes as null). The
decoder now answers that case with BOTH causes named + the recovery
("the page navigated away or the script returned undefined — the eval
context is gone; re-probe with get_state") + the tab's LAST KNOWN URL
(module memory, refreshed by every `browser-navigated` event and every
`browser_tab_url` read) — never the old bare "unexpected payload: null"
dead end. Other non-object payloads keep the raw quote.

The panel resize no longer floats over the chat either (the owner's
"overlay kind of vibe"): in the desktop shell the width snaps INSTANTLY
(duration 0) so the bounds-sync loop keeps the OS-level webview
pixel-glued to the placeholder; the smooth 200 ms animation stays for the
web build (pure DOM, no floating layer).

## The panel drag-resize (R131-B-ui — the owner's "drag the corners")

The owner: "the ability to flexibly change the width of the browser window
itself… like I should be able to drag the corners and resize it properly
as needed." The panel itself now carries the house separator grammar
(the ChatFocusLayout separator's exact pattern — `role="separator"`, the
aria label, keyboard arrows ±16px, the 5px hit area, the hover-revealed
2px hairline over the `bg-line` wash):

- **The RIGHT-EDGE handle** widens/narrows the SIDEBAR through the SAME
  `setWidth` clamp path the chat's separator drives (one truth: the chat's
  floor holds no matter WHICH affordance dragged — the panel's handle
  receives the same live `sidebarWidthCap` the separator does).
- **The BOTTOM-EDGE handle + both CORNER squares** drive the panel's own
  **height** — a NEW per-slice `browserPanelHeight` in the right-sidebar
  store, persisted like the width. `null` (the default) is the FILL
  behavior the panel always had (flex-1, the whole sidebar column); a
  number renders the panel top-anchored at exactly that height. Clamped
  `[280px .. ~75% of the measured column]` (the floor wins when the column
  is too short — a usable browser beats a sliver); a stored value that
  outgrows a later-shorter column is honestly RE-CAPPED at render time
  (RightSidebar's ResizeObserver height law). Double-click any
  height-bearing handle resets to the fill behavior.
- **The geometry law**: the handles live in DOM space the OS-level webview
  never covers (a sibling column beside the content card, a sibling row
  below it, the root's padding corners) — the native webview floats above
  ALL app HTML over the placeholder rect ONLY, so a sibling is the only
  spot a clickable affordance can exist on the panel itself. Every drag
  delta re-glues the webview automatically (the bounds-sync loop's
  ResizeObserver reacts to ANY placeholder geometry change); the width
  keeps the R67/E5 instant-snap law (duration 0 in Tauri) and the height
  is a plain style change — instant on every platform by construction.

## Form submission discipline (the Google-search fix)

The owner's live report: the agent typed a search query into Google's box
but **never submitted it** — typing alone never navigates. The discipline
the tool description + the prompt section now teach:

- `type` with **`submit:true`** — the input's form is submitted NATIVELY
  (`form.requestSubmit()`, handlers included); without a form, a synthetic
  Enter keydown is attempted and the honest `submitHow` note says which
  happened.
- `press_key` with **`key: "Enter"`** — synthetic keyboard events never
  trigger native submission on their own, so Enter inside a form ALSO calls
  `requestSubmit()` and reports `submitted:true`.
- `click` the submit button by its visible text.

R131-B addition, the **requested-vs-observed echo**: the `type` result now
opens with `submit requested: false/true · observed: …` — BOTH sides of
the story, because the field ledger caught a Google page whose own key
listener submitted the form while the call carried `submit:false` and the
bare `submitted:true` was unattributable. A `submitted:true` under
`requested:false` means the PAGE submitted on its own (the note says so);
the agent never claims it commanded what it merely observed.

## The bot-wall protocol (captcha / Cloudflare / age gates)

When a page shows a human-verification wall, the agent must WAIT FOR YOU,
not hammer the page:

1. **Detection.** A pure detector (`detectVerificationWall` in
   `agent-core/src/browser-checkpoint.ts`) matches word-boundary,
   case-insensitive markers — priority **cloudflare > captcha > age >
   generic "verification"** — against the page title first, then its
   visible text/HTML, and returns the kind + a ≤120-char evidence window
   (the "why" the card shows). `navigate` and `read` append an honest
   note to their results:
   `⚠ A verification wall (<kind>) is showing on this page — call
   browser_control with action wait_for_verification so the owner can
   solve it while the agent waits.`
   The prompt section forbids retry loops while the wall is up.
2. **The checkpoint.** `wait_for_verification` probes the live page (a tiny
   bridge script: title + the first 4 000 chars of text + which wall
   WIDGETS are present — reCAPTCHA / Turnstile / hCaptcha /
   challenge-platform; a server-side fetch is the fallback). Clean page →
   an honest "no wall detected". A wall → the wait is clamped to
   3 000–60 000 ms (default 15 s; the hard cap is 60 s — you can never be
   asked to stare at a countdown longer than a minute) and a checkpoint
   opens:
   - the SSE **`browser-checkpoint`** frame mounts the chat card — the
     kind's title ("CAPTCHA verification needed" / "Cloudflare
     verification needed" / "Age verification needed"), the URL, the
     evidence, a **live countdown** with a progress bar, and two controls:
     **Mark as done** and **Stop waiting**;
   - your click POSTs **`/api/v1/browser-checkpoints/:id/resolve`** with
     `{action:"done"|"stop"}` (the unknown/expired id answer is the honest
     `{ok:false, resolution:"timeout"}` the card's own countdown falls
     back to);
   - every settle — your click OR the countdown expiring — emits the
     **`browser-checkpoint.resolved`** frame so the card collapses even
     with no click.
3. **The honest re-probe.** After the wait: "done" + the wall gone →
   "verification cleared — the page now shows `<title>`"; "done" but
   markers still present → an explicit warning to re-check before trusting
   the page; "stop" → "the owner stopped the wait — do not retry this page
   automatically"; timeout with the wall still up → tell the owner what is
   needed. The agent is never allowed to claim success past a wall.

The wall page stays visible in the browser panel the whole time — you
solve it there, the tool waits in chat. **Self-bypass is future work** —
the agent never attempts to solve a wall itself in this round.

## Viewport changes apply INSTANTLY (the "nudge a number" fix)

The owner's report: the agent set a viewport preset and the panel did not
change until a manual number edit nudged it. Root cause: the panel's
"natural size" mode — agent presets landed in the store but the mounted
panel kept sizing itself to its container until a local edit flipped the
mode. The fix, in three legs:

- `set_viewport` now also emits the **`browser-viewport`** SSE frame
  (turn-independent — a background turn's change applies too);
- the frontend applies it instantly (`applyAgentViewport` patches the tab
  store AND bumps `agentViewportSeq` — the mounted panel's effect exits
  natural mode on any seq bump);
- the panel's 4-second poll is the backfill: when the server's viewport
  differs from the local one on width/height/preset/rotate, the poll
  adopts it and bumps the same seq (zoom-only changes never force the
  layout switch — zoom applies in natural mode too).

## Reading the page without screenshots

`read_dom` is the default first look (the prompt teaches "USE THE BROWSER
LIKE A USER WOULD: read_dom first"): a structured outline — headings,
every visible interactive element with a short CSS selector + text/label/
value + its size, forms with field names — capped at 12 000 chars
(`maxChars` up to 20 000; `include:"interactive"|"all"`). `source` digs
into the raw HTML/CSS/JS when the outline is not enough. Both ride the
same eval bridge as `eval` (one script per action; user input is embedded
via `JSON.stringify` only — never string-concatenated into the script).

R131-B, two laws the field ledger forced:

- **RENDERED text, never serialized text.** Element text and paragraphs
  come from the page's RENDERED text (`innerText` — the same discipline
  the wall probe uses), and the paragraph walker skips
  `style/script/noscript/template` ancestors outright. The confirmed
  defect: a Google homepage `<button>` whose `text` was a raw CSS blob
  (`.plR5qb.PHjFye .CbxW7b{display:none}…`) because `textContent`
  serializes unrendered code into element text.
- **The offset/range cursor.** On a huge page, pass `offset` (skip the
  first N interactive elements) and optional `range` (default 120, max
  500): the result says `showing elements N..M of T` — an ELEMENT-COUNT
  cursor cut in the page script, never the old mid-payload byte
  truncation that died mid-element (the ledger's ~3.4KB-truncated read).
  `offset` beyond the end answers the honest empty + the count. The outer
  `maxChars` cap stays and its marker now suggests the offset hatch.

## Saving files — the download action (R131-B)

The owner's verdict on the panel's capability: "it is not able to
right-click and then click save as and save to the download folder as it
needs to be… a full-fledged browser." The agent-side half is the
**`download`** action — the tool's own save-as:

- **Page-context fetch.** The sidecar fetches the URL through the same
  guarded upstream walk every proxied page rides (`fetchUpstreamGuarded`):
  the tab's PER-PROJECT cookie jar on every hop (login-gated downloads
  work), the panel's user agent, and the tab's current page as the referer
  — never a fabricated one. Redirects are followed and re-guarded per hop;
  non-http(s) URLs are refused; the honest size cap is 50 MB.
- **The pinned location.** Files land in `<projectRoot>/downloads/` (the
  ROUND-115 pinned folder, the twin of `attachments/`), created on demand.
  The output's path is PROJECT-RELATIVE (`downloads/report.pdf`).
- **Never a silent overwrite.** The attachments law mirrored: a name
  collision with DIFFERENT bytes mints `-2`/`-3` suffixes; byte-identical
  content is REUSED and reported as such (re-downloading the same file is
  a no-op). The model's `filename` is sanitized to a bare name (path
  separators die — no `../` escapes); without one, the URL's last path
  segment names the file.
- **The magic-byte verdict rides the output.** PNG/JPEG/GIF/WEBP markers
  are sniffed against the content-type: a mismatch is REPORTED ("the
  content-type says image/png but the bytes carry no known image signature
  — likely an HTML error page served as a 'successful' download") with the
  requested filename KEPT — the agent decides what to trust, the tool
  never silently renames.
- **The announcement.** A **`browser-download`** SSE frame
  `{tabId, sessionId, path, bytes}` rides the turn's stream beside the
  `browser-navigate` pattern, so the frontend can toast/card the save.
- **Honest failures.** Every miss names its cause: the HTTP status, the
  transport error, the cap, or the missing project context (downloads
  need a project-bound chat session — that is where the folder lives).

R131-B-ui addition, **the announcement's frontend landing**: the
stream-store intercepts the frame (turn-independent, exactly like the
navigate/open frames — the raw SSE parser passes well-formed frames
through without a union gate), maps its `tabId` to the panel store's tab
key, and records it as the tab's `lastDownload`; the mounted panel
surfaces it as the same quiet status line the native pipeline uses.

The NATIVE right-click "save image as…" pipeline is LANDED (R131-B-ui,
Windows-only, CI-verified per ADR-0012) — both halves land the same
`<projectRoot>/downloads/` folder:

- **The context menu is pinned ON** (`AreDefaultContextMenusEnabled` in
  the same `with_webview` settings pass at tab-create time) — right-click →
  "Save image as…" is no longer a dead right-click; the save flows through
  the pipeline below.
- **`browser_tab_set_download_dir(tab_id, dir)`** — the command that
  tells Rust where THIS tab's downloads land. Rust never knows the project
  root (the sidecar owns project state), so the PANEL resolves the bound
  project's `rootPath` and registers `<root>/downloads` on mount; a tab
  that never got one falls back to the app's download dir. Validation is
  honest (absolute path required, created recursively); the registration
  survives webview re-creation (the map is per tab id, not per webview).
- **The `DownloadStarting` handler** (registered per webview via
  `with_webview` → ICoreWebView2_4): `Handled(true)` +
  `ResultFilePath = <dir>/<suggested name>` with the attachments-style
  never-overwrite `-<n>` minting (EXISTENCE-based at start time — the
  bytes are not down yet; a fully-consumed series refuses by reusing the
  base name and surfacing the failed write as an interrupted download,
  never a silent overwrite). A `browser-download` TAURI event
  (`{tab_id, state, path, file_name, received_bytes, total_bytes}` —
  starting → completed/interrupted) reaches the panel, which presents a
  quiet fading status line; Rust stays THIN.
- **Non-Windows degrades honestly**: the command answers
  "downloads are Windows-only in this build" and the panel logs it once
  and swallows it — the agent-side `download` ACTION still works
  everywhere through the sidecar (its fetch is plain HTTP, no WebView2).
- Two DIFFERENT transports share the `browser-download` name: the
  sidecar's SSE frame (the agent ACTION, above) and Rust's Tauri event
  (the native right-click save, here). They never collide — different
  channels — and both land the same folder.

## The native title delivery (R131-B-ui)

Native mode never delivered page titles (the Rust `on_navigation` hook
fires at navigation START — the document is not loaded yet, there IS no
title), so `get_state` answered `title:null` and the tab strip fell back
to the host. `BrowserNavigated` now carries `title: Option<String>` (the
one in-tree emitter sends None — the field exists so a future
DocumentTitleChanged hook can fill it without another wire change), and
the PANEL bridges the gap: after handling a native navigation it fires
ONE delayed (600 ms — the page settles, `document.title` stabilizes by
then) `eval("return document.title")` → the store's `handleTitleMessage`
route (the iframe path's own `acute:title` feeder — it POSTs the
title-update the agent's `get_state` reconciles against). The probe is
debounced across navigation bursts and seq-guarded so a stale reply can
never title the NEXT page; a failed/empty/garbage probe leaves the
current title untouched (never a fabricated fallback). It is
best-effort by design — a page that retitles itself after 600 ms (SPA
route changes) shows the stale title until the next navigation; the
sidecar's reconcile eval stays the truth.

## The monitor boundary

Browser work must never show "the agent is using your computer" — that
floating monitor is computer-use-only. The `screenshot` action **no longer
records into the computer-use session ring** (the R66 fix for the owner's
A1 report: browser turns wrongly tripped the monitor). The live signal on
the monitor is the decayed REAL-control activity (6 s decay) — a browser
turn never shows it, and browser-only turns never arm the R67 turn-hold
either (only computer-use frames hold; see [COMPUTER-USE](COMPUTER-USE.md)).
R67-D addition: the `screenshot` action now also publishes the capture as
a live chat THUMBNAIL (`screenshot` SSE frame + the ephemeral raster route
— see [ATTACHMENTS](ATTACHMENTS.md), the ephemeral-rasters section).

R124/R125 addition: the `screenshot` action's capture is STAGED — the
tab's webview is re-staged at a fixed 1280×720 logical px (resolution is
never the window's size), and on Windows the grab is now OCCLUSION-PROOF:
the sidecar finds the staged child webview by its on-screen rect and
`PrintWindow(PW_RENDERFULLCONTENT)` renders THAT window's own surface —
so the capture works while the app is unfocused or covered by another
application (the old screen-region grab scraped whatever was on top —
the owner's "it takes the screenshot of that application rather than
the browser window itself"). The tool's result names its source
honestly (a window capture vs the legacy screen-region fallback, which
still exists for the paths the window grab genuinely cannot serve).
A minimized window is refused up front (PrintWindow would render stale
pixels); the staged page still flashes ~0.5 s during the grab.

## The engine, honestly (R100-A — evergreen + the de-branded UA)

Round-99 read the owner's directive ("ship the browser packages alongside
the app") as "bundle the WebView2 Fixed Version Runtime inside the
installer" — and the owner read the result for exactly what it was:
**Microsoft Edge shipped with the app** (~258 MB installer, 4× the
previous ~37 MB) with `msedgewebview2.exe` sitting in the install folder.
Round-100 reverts that trade and de-brands what remains:

- **`src-tauri/tauri.conf.json`** pins
  `bundle.windows.webviewInstallMode = { type: "downloadBootstrapper" }`
  — the evergreen contract: the installer carries only the tiny bootstrapper
  (~2 MB); at install time it verifies the machine's WebView2 runtime and
  downloads it ONLY when absent (every Windows 10/11 machine since 2021
  has one — the bootstrapper is a repair path, not a dependency in
  practice). The `webview2-runtime` resources row, the CI cab-fetch step,
  the staging dir, and the 45-min NSIS timeout are all GONE (back to
  30 min; the installer is ~37–40 MB again).
- **The de-branded user agent** (`src-tauri/src/browser.rs`
  `PANEL_USER_AGENT`): every CONTENT webview (`browser_tab_create` — panel
  tabs AND the pop-out's page) presents
  `…Chrome/153.0.0.0 Safari/537.36 AcuteBrowser/1.0` on Windows — the
  engine-lineage tokens stay honest (sites gatekeep on them) but the
  `Edg/…` Microsoft Edge brand token is GONE and our identity rides last.
  On Linux the string keeps WebKitGTK's honest shape + `AcuteBrowser/1.0`.
  The app's own chrome pages (main/mini/popout hosts) keep the default UA
  — local content never sees a user agent. Bump rule: when the evergreen
  floor passes 153, bump the `Chrome/` token once (UA-version pinning is
  standard practice; sites feature-detect via JS APIs, not UA numbers).
- **The engine line** (Settings → Browser + the About tab): the panel runs
  the OS webview — WebView2 (Chromium-based, ACUTE-branded UA) on Windows,
  WebKitGTK on Linux. Stated plainly; the question never needs asking
  again. The Linux release (R100-B) ships deb + AppImage with the panel on
  WebKitGTK — the genuinely-not-Edge leg of round-100.
- **The trilemma, on record** (`docs/research/browser-engine-and-linux-round-100.md`
  §B.0): on Windows in 2026 you pick two of {not-Chromium-lineage,
  production web compatibility, installer ≤ ~100 MB}. Servo is 66.4% WPT
  (real sites break); CEF adds +165 MB (worse than the complaint). The
  opt-in experimental-engine fallback (research §B.2) is the documented
  path if the owner ever rules Chromium-lineage unacceptable — it is NOT
  the default because a 66%-compat browser would break the agent's core
  browsing feature.
- **Local-dev note**: `pnpm tauri dev` on Windows uses the machine's
  evergreen runtime — nothing to stage anymore. Web dev mode (`pnpm dev`)
  and the Linux sandbox never touch WebView2. The release workflow remains
  the canonical bundling path — `ci.yml` only runs `cargo check`.

R131 honest scoping (the owner's "download Chromium base and build our own
internal application browser… a full-fledged browser"): the WebView2
runtime the panel already runs IS the Chromium-family engine — the same
engine lineage as Edge/Chromium, auto-updated by the OS — so round 131
ships the CAPABILITY leap on it (native downloads + right-click save-as,
the context menu, the drag-resize, the eight tool truths) rather than
bundling a separate engine. "Bundling our own Chromium" would mean
replacing the app shell itself (a fixed-runtime build — the exact ~258 MB
trade round-100 reverted — or a CEF fork at +165 MB), which is an
owner-gated ADR, PROPOSED not decided: see round-131.md §4's pre-declared
caveat and the R100 trilemma research above.

## Where links open (R99-A — the central link router)

Every clickable http(s) link inside the app routes through ONE module:
`src/lib/open-link.ts`. Before R99 the chat markdown links, the file-preview
markdown links and the About tab's Releases button were plain
`<a target="_blank">` — silently SWALLOWED inside WebView2 (wry never
hands a webview anchor to the OS browser), i.e. DEAD links (the documented
AboutTab lesson).

The router's contract — every leg returns a typed `OpenLinkResult`, so
callers and tests can assert where the link went and why:

1. **Scheme gate** — http/https ONLY (parsed through the WHATWG URL
   constructor); `mailto:`, `file:`, `javascript:`, `ftp:` and unparseable
   strings are refused honestly. Never guessed.
2. **Preference** — the browser settings domain's `linkOpeningMode`
   (`"in-app"` | `"system"`, default **in-app**; GET/PUT
   `/settings/browser`, the `browser.linkOpeningMode` row — the same
   domain as the search engine/homepage/zoom/quick links since R97-G). The
   Settings → Browser tab's "Link opening" card (two ChoiceCards) is
   the UI. The value lives in an in-memory cache hydrated once at app boot
   (`hydrateLinkOpeningMode`, called from AppShell beside the notification
   bridge's init) and pushed LIVE by the settings card on every confirmed
   flip — the next click obeys without a restart.
3. **In-app leg** — resolves the current project (the caller's
   `projectId` override → the project-chat store's `activeProjectId`
   → the right-sidebar store's) and lands the link as a browser tab in
   that project's sidebar via `openBrowser(projectId, url)`. No project
   context (a global surface on a fresh boot) → the honest
   system-browser fallback, said so in the result. A store throw → the
   same fallback (a link must never become a dead click).
4. **System leg** — `open_external_url` (the Rust OS-level handoff,
   http/https re-validated in Rust) inside the desktop shell; `window.open`
   only in web dev mode. Failures are reported, never swallowed.

Callers: **ChatMarkdown** (both link render sites — the `[text](url)`
mark and the bare-URL autolink; middle-click/aux button 1 rides the same
router, and the REAL `href` + `rel` stay on the anchor for hover preview,
copy-link and keyboard Enter — Enter fires click, which routes),
**FileViewerPanel** and the explorer's markdown preview (the exported
`Markdown` renderer takes an optional `projectId`), and **AboutTab** (the
Releases button routes in-app by default; a small explicit "open externally"
affordance sits beside it).

**Escape hatches (explicit user intent — deliberately NOT routed
through the preference)**: the BrowserPanel's own "Open externally" button,
the pop-out window's "Open in system browser", and AboutTab's external
affordance (`forceExternal: true` — it beats every preference). The
user can always reach the device's browser deliberately.

## Honest limitations

- **The native-bridge actions are desktop-only** (`read_dom`, `source`,
  `click`, `type`, `press_key`, `eval`, the `screenshot` region): web dev
  mode refuses them honestly. `navigate`/history/`set_viewport`/`read`/
  `get_state` work in every mode (server-side state/fetch).
- **The Windows decode is pinned by construction only** — the
  double-encoding is a documented `ExecuteScriptAsync` contract; the
  headless Linux sandbox pins the normalizer's matrix by test (single-
  encoded, double-encoded, non-JSON) but cannot run a real WebView2. Your
  live Windows run is the proof (navigate → read_dom → click/type in that
  order).
- **The `browser-navigate`/`browser-open` frames ride the turn's live SSE
  stream** — outside a turn (catalog/test contexts) there is no channel;
  the 4-second poll (now with create-on-adopt) is the only backfill.
- **The navigate wall probe is single-try, 5 s, bridge-only, failures
  swallowed** — a page still loading can race the probe (no ⚠ note lands);
  `read`'s detector covers the fetched text as the second chance.
- **The checkpoint card is turn-bound** — it renders during a LIVE turn
  (the tool only runs inside turns, so this is the normal case), but a wall
  during a background turn with no mounted chat panel shows no card (the
  tool still times out honestly and reports it).
- **`screenshot`'s vision description** needs Computer Use's capture
  engine ON (the refusal says so and points at `read`/`eval` meanwhile);
  the vision model itself is configured in Settings → Image Analysis
  (R66 moved it out of Computer Use).
- **The page the panel shows can differ from a fresh fetch** (logins, JS):
  `read` = clean server-side text, `read_dom`/`click`/`type`/`press_key`/
  `source`/`eval` = the LIVE page, `screenshot` = the pixels you see.
- **The evergreen runtime auto-updates** (the R100-A contract — the
  fixedRuntime bundle is retired): the machine's WebView2 runtime tracks
  Microsoft's evergreen channel, and the panel's UA pin
  (`PANEL_USER_AGENT`) is bumped deliberately when the floor moves (the
  section above says how). The installer carries NO engine payload
  (~37–40 MB).
- **The router's in-app leg needs a project context** — a link clicked
  on a global surface before any project is opened degrades honestly to the
  system browser (the result says so).
- **`download` is fetched, not gated like a navigation** (R131-B's honest
  scoping): the action reuses the tab's cookie context but is NOT routed
  through the `web_fetch` host-approval gate — the brief's contract (the
  page-context fetch, the scheme/private-net guard, the 50 MB cap, the
  project-relative path) is the whole law. If downloads should carry the
  same host gate as `navigate`/`web_fetch`, that is an owner-gated follow-up.
  The magic-byte sniff covers PNG/JPEG/GIF/WEBP only (a mismatch is
  reported, other formats ride on trust of the content-type).
- **The redirect-collapse window is 2.5 s** (R131-B): a location report
  landing LATE (a slow redirect chain, a hung page) still pushes a second
  entry — the drift returns for those shapes, honestly. The window is
  armed by the AGENT's tool navigations and (R131-B-ui) the panel's own
  address-bar commands (`commanded: true` on the command path only); the
  pop-out window, quick links and external opens do not arm it.
- **The native download pipeline is Windows-only and CI-verified**
  (R131-B-ui, ADR-0012): no local Rust toolchain — the COM plumbing was
  API-verified against docs.rs webview2-com 0.38.2 + wry 0.55.1's own
  DownloadStarting registration, and CI's `cargo check` is the compile
  gate; the owner's live Windows run is the behavioral proof (right-click
  an image → "Save image as…" → the file lands in the project's
  `downloads/` and the panel toasts). The dedupe law is EXISTENCE-based
  at DownloadStarting time (the sidecar's ACTION dedupes by CONTENT after
  the fetch — the two laws are deliberately different because their
  timing is).
- **The native title probe is a 600 ms best-effort** (R131-B-ui): the
  probe fires once per navigation burst; a page that retitles itself
  later (SPA route changes) keeps the stale title until the next
  navigation. `get_state`'s reconcile eval stays the truth.

## See also

- [COMPUTER-USE](COMPUTER-USE.md) — the OTHER surface (your real desktop;
  the R65 boundary lines in both runbooks' source prompts name each other)
- [DEBUG-MODE](DEBUG-MODE.md) — the post-turn analyst that dissects
  browser turns
- [ATTACHMENTS](ATTACHMENTS.md) — the chat attachment pipeline (and the
  ephemeral screenshot rasters the browser screenshot now publishes)
- [EXTENSIBILITY](EXTENSIBILITY.md) — where `browser_control` sits in the
  tool vocabulary
- Code map: the tool `agent-core/src/tools/plugins/browser.ts` (16 actions,
  the page-script builders, the wall probe, the binding resolution + the
  navigate/open/download frames + the screenshot thumbnail frame + the
  nearest-match refusals), the binding Map +
  the bind route + the session mint `agent-core/src/browser-proxy.ts` (the
  redirect-collapse window + the download fetch
  `browserFetchForDownload`), the
  checkpoint registry + detector `agent-core/src/browser-checkpoint.ts`, the
  resolve route + the wall probe wiring in `agent-core/src/server.ts`, the
  bridge answer channel `POST /api/v1/browser-commands/:id/result`
  (`agent-core/src/browser-proxy.ts` + `src-tauri/src/browser.rs`), the
  eval double-parse `src/lib/native-browser.ts` (`parseWebViewEvalJson`),
  the central link router `src/lib/open-link.ts` (the scheme gate + the
  linkOpeningMode preference + the in-app/system legs), the de-branded UA
  (`src-tauri/src/browser.rs` `PANEL_USER_AGENT` + the engine line in
  Settings → Browser and the About tab),
  the panel `src/components/right-sidebar/BrowserPanel.tsx` (the
  agentNavSeq effect + the create-on-adopt poll backstop + the R131-B-ui
  drag-resize handles + the native title probe + the download toast), the
  tab store + instant apply + the bind client `src/lib/browser-store.ts`
  (the address-bar `commanded:true` collapse arm + `applyAgentDownload`),
  the sidebar slice landing `src/lib/right-sidebar-store.ts`
  (`openBrowserForChatSession` + the persisted `browserPanelHeight` law),
  the instant width + the render-time height cap
  `src/components/right-sidebar/RightSidebar.tsx`, the chat card
  `src/components/project-chat/BrowserCheckpointCard.tsx`, the frame
  intercepts `src/lib/stream-store.ts` (navigate/open/viewport/checkpoint/
  download), the native download pipeline + the download-dir command + the
  `BrowserNavigated.title` field `src-tauri/src/browser.rs`
  (`browser_tab_set_download_dir`, the `downloads` module's
  DownloadStarting/StateChanged handlers), the prompt section
  `agent-core/src/agents/prompts.ts` (EMBEDDED BROWSER PANEL).
