<!-- last-reviewed: 2026-09-11 round-90 -->
# Round 87 — the UX + capability round (About/reset, configure-before-add, ask_user, the embedded browser)

## 1. Owner direction (verbatim intent)

"The improvements which I need you to make are as such: I need you to add a
dedicated About section in the settings for the version of the app… the update
options… In the About section there will be options to reset the whole
application. All the things of the application will be reset: the projects, the
data, the storage… The providers and models will be removed completely too…
it takes the credentials.txt file and loads the credentials from there. But I
want you to completely remove that functionality… The user has to save the
credentials in the application by himself… When I click on any of the models
and add any of those models, it directly adds that model instead. What it
should have done is show me the options to configure that model: the display
name, the model ID, the size, the context window size, the max output size,
the pricing, the input/output, the cache read… configure which kinds of inputs
this model accepts… whether it accepts text (all the models accept text), and
… images, videos, and PDFs… which kinds of outputs this model can provide,
like text (which will be on by default)… image output, video output, port,
audio output… I don't think that a tool use is supposed to be an option there.
Also the reasoning option should not be there either because these are
model-specific rates and our application will properly detect whether it
handles reasoning or not… The UI of the models picking is not as good as it
can be… I want the whole UI to be clean and beautiful, just like the startup
and the setup pages… the whole overall UI layout looks way too cramped
together… the display name should be shown properly for the model and it
should be given in a dedicated section with borders around it… the three
buttons on the right side… the delete button, the edit button, the test
button… when I click the test button it should show an animation. After
testing it, it should show the results, whether it was successful or not, and
the results should disappear automatically after 5 seconds… the agent is
apparently not that capable of using the browser… I want it to have full
context of what the browser page is currently showing, where the elements
are… It should be able to tap on any one of the clickable elements there
easily… the screenshot will only be taken of the browser window itself…
By default it should not need to take a screenshot. It should be able to
directly check all the content of the page by using smarter techniques…
the scroll bars… it does not adapt its size according to the size of the
window… The default dimensions of the browser on the right sidebar will be
set to 1440 by 900… properly embed the browser window as a complete part of
the application itself rather than it being an overlay… If I click on the new
tab button, the whole browser window apparently disappears… If I try to
switch the tabs, then the previous tab apparently gets somewhat glitched
out… the maximum the chat area can be… there should be some padding on the
right and left sides… the mini/smallest size for the left chat window area…
I want the current minimum limit to be reduced by half… when I make it
smaller, at a point every single thing becomes minimized… the first thing
which should be shrunk… (meaning the name is the model name, the model
sector)… the provider selector… I am apparently unable to smoothly move my
mouse pointer there… When the option is opened up, the background will be
slightly darkened and a slight frosted glass effect… if I click on any one of
the projects, then the left sidebar should apparently expand fully… in our
AI agent, I would like to add some other advanced functionalities, like
giving it the ability to ask the user questions midway through. It will ask
questions and the user can select from the options or maybe he can type in a
custom response… He can answer multiple questions this way… the agent
apparently does not have a proper to-do list. It does not properly show the
to-do list. Maybe adding a to-do list will be a great option too… Make sure
to update the documentation too and the worklog too. Also make sure to
regularly back up everything to the GitHub repository."

Extracted task list: (1) the Settings About section (version + updates +
reset); (2) the application-wide reset; (3) credentials.txt removed from the
launcher; (4) configure-before-add for models + the input/output capability
chips (no tool-use/reasoning toggles); (5) the Models & Providers page
redesign (uncramped, bordered cards, the three buttons, the animated test
button with 5s auto-dismiss); (6) the NVIDIA phantom-add fix; (7) the agent
browser capability (full page context + positions + panel-only screenshots);
(8) the browser embedded as a real part of the app (keep-alive, 1440×900,
new-tab survival, no tab-switch glitch); (9) adaptive scrollbars; (10) the
chat-area widths (min halved, padding at max); (11) the composer's graduated
shrink (model name first); (12) the provider-selector hover-path fix + the
frosted-glass backdrop; (13) the sidebar expanding on project click; (14)
the agent's mid-task questions (ask_user); (15) the todo list visible in
chat; (16) docs + worklog + the 15-minute notifications + the final one.

## 2. Method

- Fresh continuation at HEAD `d6dbd57` (R86 close-out, v0.84.0) on `main`.
- Six parallel research sweeps (the sanctioned sub-agent pattern) mapped
  every touched surface with file:line evidence — the implementation map
  lives at `agent-ctx/research/r87-implementation-map.md`.
- The 15-minute ntfy progress notifier ran the whole session (topic
  `NTFY-TOPIC-REDACTED`), event pings at each milestone.
- One implementation sub-agent (R87-A1) took the five self-contained
  chat/shell layout items (scrollbars, chat widths, composer tiers, the
  selector hover + backdrop, the sidebar expand); the orchestrator took the
  backend foundation, the models/providers redesign, the browser embedding,
  and the question/todo cards.

## 3. What shipped

### 3a. Backend — the capability + system foundation

- **Migration 0032** (`0032_model_io_capabilities.sql`): the model table's
  INPUT/OUTPUT capability columns — `supports_pdf` (PDF document input),
  `supports_text_output` / `supports_image_output` / `supports_video_output`
  / `supports_audio_output` (what the model PRODUCES) — all tri-state
  (NULL = unknown, the R82 contract), plus `size_label` (a human-facing
  parameter-size string like "70B"). The text-output INSERT default is ON
  (the chat-completions contract itself); everything else defaults unknown.
- **`ask_user` end-to-end** (the owner's mid-task questions): the plugin
  (`tools/plugins/ask-user.ts`) + the mechanics module
  (`agent-question.ts` — the browser-checkpoint pattern: a pending-ask
  registry, the `agent-question` / `agent-question.resolved` SSE frame
  pair, the 10-minute timeout, abort-signal cancellation) + the resolve
  route (`routes/questions.ts`, POST `/agent-questions/:id/resolve`) + both
  transitions persisted as session events (`agent-question.requested` /
  `.resolved` — they fold back after reload exactly like approvals).
  Migration **0033** appends the tool to todo_write-capable template/default
  allowlists (the 0021/0026/0027 companion-rule pattern); PLAN_MODE_TOOLS
  keeps it (pure clarification); the PLAN prompt now teaches "call ask_user
  EARLY with the batched questions".
- **POST `/system/reset`** (`routes/system.ts`): aborts every live turn
  (the shared turn-registry), clears the in-memory keyring (`ProviderKeyring.clear()`
  — NEW: the spawn-time env snapshot would otherwise keep answering tests
  with erased keys after the webview reload), disposes every terminal
  session, wipes every user table (FKs-off sweep) + reseeds the factory
  state (`reseedFactoryData` — the one shared definition `openDatabase`
  also calls), VACUUMs, and purges the machine files best-effort
  (`~/.acute` notes + key files + external plugins, the dataDir's
  vapid.json). `dataDir` joined `RouteContext` for it.
- **Tauri `purge_provider_keys`** (keys.rs): deletes every
  `ACUTE-CODE/provider/*` credential (the five builtins + noted customs +
  vision slugs, canonical AND legacy target forms) + clears both note
  files. The webview calls it BEFORE the reset route (the sidecar's purge
  deletes the note files the Rust side reads to know which custom targets
  to erase).
- **Browser tool capability** (the owner: "full context of what the browser
  page is currently showing, where the elements are"): `read_dom` now
  returns each interactive element's **x/y/w/h position** on the page
  (alongside the selector + text/label/value) — the agent has the full
  spatial layout. `screenshot` **never falls back to a full-display
  capture** anymore — a missing panel region is an honest error steering
  to `read`/`read_dom` (the old fallback leaked the owner's entire screen
  into the agent's context). The browser-use skill teaches both changes.
- **`todo_write` emits a live frame** (`todo-updated`): the chat's todo
  card updates mid-turn now (the persisted event remains the truth).

### 3b. Launcher — credentials.txt is GONE

`read_credentials` / `ensure_subagent_keys` / `distribute_key` /
`_desktop_seed_keys` deleted; `credentials.example.txt` deleted. The
launcher's ONE remaining credential is the GitHub token that downloads the
private repo: `resolve_github_pat()` — the `ACUTE_GITHUB_PAT`/`GITHUB_PAT`
env var, the saved `.acute/github.pat` (chmod 600), or a first-run prompt
(masked, EOF-hardened). Provider API keys are saved IN THE APP (Settings →
Models & Providers → the desktop app writes Windows Credential Manager).
README + plan panels + status mode updated; the status flow smoke-tested
on Linux.

### 3c. Frontend — the UX wave

- **Settings → About** (NEW `AboutTab`): the version card (the same
  single-source version the release pipeline enforces + a check-for-updates
  button against GitHub's latest release + the Releases link), the about
  card, and the danger zone — type RESET → the Tauri purge → POST
  /system/reset → the webview's localStorage stores + query cache cleared
  → reload to first-run. Registered in SettingsPage TABS +
  Sidebar SETTINGS_SECTIONS (`?tab=about`).
- **Models & Providers redesigned**: the NVIDIA phantom-add FIXED (the
  Add-Provider dialog's already-added set now derives from the same
  hasKey-aware `configuredProviders` the left list uses — a keyless seeded
  preset reads as ADDABLE, not "added"); every model is its own **bordered
  card** (rounded-14, 1.5px border, capability chips IMG/VID/PDF/AUD IN +
  TEXT/IMG/VID/AUD OUT); the three right-side actions are uniform 8×8 icon
  buttons; **the test button animates** (pulse + spinner while testing)
  and its result **auto-dismisses after 5 seconds** with the button tinted
  green/red for the same 5s (a re-test re-arms both).
- **Configure-before-add**: clicking a model in the picker opens the
  **Add-mode config dialog** with the catalog prefill (display name,
  pricing, context window, modality bits) — the checkbox multi-select is
  GONE; every add is configured first. The by-id path rides the same flow.
- **The config dialog's capability chips**: INPUTS — Text (locked on),
  Images / Video / PDF / Audio; OUTPUTS — Text (default on, can turn off),
  Images / Video / Audio. Clean on/off pills, not toggles. **Reasoning and
  tool use are GONE from the dialog** — the app detects those (the owner's
  directive); the PATCH simply omits them (absent = keep stored). A Size
  label input joins the identity card.
- **The embedded browser**: default viewport **1440×900** (frontend store
  + the backend proxy mirror + the test pins); **KEEP-ALIVE** — the right
  sidebar now keeps every browser tab's panel MOUNTED (display:none when
  inactive): the native webview hides but never re-creates (no reload, no
  blank frame — the tab-switch glitch is gone), the proxied iframe stays
  loaded, switching back is instant, and the browser no longer "closes in
  the background" when the new-tab menu opens (a dimmed "browser paused
  while the menu is open" hint makes the popover hide read deliberate).
  `BrowserPanel` gained a `hidden` prop (folds into the webview-visibility
  math; pauses the bounds sync — a display:none rect is 0×0 and never
  reaches a live webview; suppresses the create-time show).
- **The question + todo cards in chat**: `QuestionCard` (option pills +
  a custom-text input per question, one Send for the whole batch; the
  answered state shows Q → A; timeout/cancelled collapse honestly) and
  `TodoCard` (the progress meter + per-item status marks, one card per
  turn upserted with the latest snapshot) render in the working stream —
  live via the new SSE frames, folded via the new session-event folds.
- **The chat/shell layout batch** (sub-agent R87-A1): viewport-adaptive
  scrollbars (clamp-scaled webkit gutters); the chat minimum width halved
  (480 → 240 in focus layout, 320 → 160 in panels layout) + graduated
  max-width padding (px-6/md:px-12/xl:px-16 on the content column); the
  composer's graduated shrink (the model name's label shrinks FIRST via
  stepped max-widths with transitions, the pill labels collapse in stages
  — never all at once); the provider-selector flyout's trajectory-intent
  gating (moving toward the flyout no longer re-targets mid-path) + the
  frosted-glass backdrop on the main popover; a rail project click expands
  the sidebar then navigates.

## 4. Verification

| Gate | Result |
|---|---|
| Frontend suite | **157 files / 2,839 tests GREEN** (was 155/2,825) |
| agent-core suite | **94 files / 1,877 tests GREEN** (was 92/1,867; +r87-reset-and-capabilities ×6, +r87-ask-user ×4) |
| Lint (eslint .) | CLEAN |
| Typechecks (tsc ×2) | CLEAN |
| Build (shared + agent-core + vite) | SUCCESS |
| e2e (vs built dist) | 12/12 GREEN |
| License audit | 134 CLEAN |
| Live boot smoke | GREEN |
| Launcher status-mode smoke (Linux, env PAT) | GREEN |
| CI (windows-latest) | **run 34584230413 SUCCESS** on the close-out-fix push 7b6e47e — the full verify pipeline green. (The initial push 3735f93 FAILED honestly: the two new suites left their SQLite handles open → Windows-only EPERM blocking the afterAll temp-dir removal, though every test in them passed — 2,803 green that run. Fixed per the repo's standing afterEach pattern: `await app.close(); db.close();` + retried rmSync; the reset test's mid-test app replacement now closes the beforeEach instance first.) |
| Release workflow | **run 34584240071 SUCCESS** — v0.85.0 installer (36.6 MB) + kit (95 KB, credentials.example.txt gone) built, PUBLISHED at close-out (both assets verified, zero drafts remain). (The initial run 34579018284 failed at "Assemble launcher kit": the step still copied the R87-deleted credentials.example.txt — removed from the workflow + the launcher headers + HANDOFF's tree, ACUTE.bat CRLF preserved byte-exactly.) |

New tests: the reset route's full contract (wipe + reseed + keyring clear +
409-after), the ask_user round trip (frames + events + resolve shapes), the
capability columns' tri-state contracts, the configure-before-add flow, the
Images-chip PATCH, the test-button tiers, the flyout intent function, the
240-floor geometry, the expand-then-navigate.

## 5. Known residuals

- The dead `src/components/sessions/` directory (559 lines — the R85 find)
  is STILL pending deletion (Wave 3's queue, unchanged).
- The R86 queue (Wave 2-b turn-loop harness, the remaining 51 server.ts
  routes, Wave 3 frontend seams) is unchanged — R87 was the owner's
  UX/capability round, not a modularity round.
- Site-mode (browser) key persistence after restart remains the pre-R87
  behavior: the desktop app's Credential Manager is the durable path; the
  browser-dev keyring stays in-memory for the session (documented in the
  tab's own note).
