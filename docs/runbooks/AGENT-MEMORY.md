<!-- last-reviewed: 2026-09-17 round-102 -->
# AGENT MEMORY — lessons learned, rules going forward

**Owner directive (2026-08-23):** "learn from the mistakes you made, document
them or create memory of it, so you do not make similar mistakes in the
future." This file is that memory. **Read it before starting any session** on
this repo (linked from HANDOFF §1). Append a new entry whenever a mistake
costs real time or produced an owner correction — never delete old entries.

Format per entry: `N. TITLE (date, source)` → mistake → root cause → rule.

## Process & owner expectations

1. **SUB-AGENTS ARE OPTIONAL, NOT A DEFAULT** (2026-08-23, owner correction).
   Round-9 M3/M4 implementation was dispatched to sub-agents; the owner:
   "you were not supposed to dispatch it to the sub-agents… if it is not
   necessarily required then don't force things." RULE: work inline by
   default. Dispatch a sub-agent ONLY for genuinely parallel/heavy work
   (e.g. multi-file research sweeps) where it is clearly the better tool —
   and even then, the orchestrator reviews and integrates everything. This
   is codified in AGENTS.md + HANDOFF §5.

2. **Fix small known bugs immediately when the owner says so** (2026-08-23,
   owner instruction): "fix it now, don't leave anything for the future" —
   about the `acute.mjs agents` model-field bug. RULE: when the owner points
   at a concrete defect, fix it in that session, verify it, and prove it in
   the report.

3. **Quality over speed, always** (repeated owner theme). RULE: verify every
   change (`pnpm verify` green, seen with own eyes), test live paths
   hands-on, never rush, never skip parts of a directive — re-read the
   owner's message top-to-bottom before starting and extract EVERY numbered
   requirement into the todo list.

## Environment (this Linux sandbox)

4. **Background processes are reaped between shell invocations** — even
   `setsid`-detached ones. Cost: mysterious "connection refused" after a
   successful boot. RULE: any live test (sidecar, vite, runner) must run as
   ONE self-contained invocation: boot → work → assert → teardown. Keep
   persistent state on disk (e.g. `.dev/*.db`) so phases compose across
   invocations.

5. **pnpm lives at `/home/z/.local/bin`** and the PATH does not persist
   between invocations. RULE: prefix every Bash call that uses pnpm/node
   tools with `export PATH=/home/z/.local/bin:$PATH` (activate once per
   invocation).

6. **`cmd | tail` hides exit codes.** RULE: always check `${PIPESTATUS[0]}`
   (bash), never trust the tail's exit code.

7. **OpenRouter networking quirk**: `api.openrouter.ai` does NOT resolve in
   this sandbox, but the apex `https://openrouter.ai/api/v1` does — and that
   apex URL is what the sidecar's provider row stores. RULE: don't "fix"
   DNS; verify the seeded baseUrl before assuming an outage. Only model
   allowed on the owner's key: `stealth/ox-alpha`.

8. **CI takes ~4–6 minutes** (windows-latest + cargo). A Bash timeout that
   kills a polling loop is NOT a CI failure — re-query the run status
   afterwards before concluding anything.

## Product code gotchas (found the hard way)

9. **AI SDK v7 tool schemas MUST be wrapped in `jsonSchema()`**
   (round-9 M4): bare JSON-Schema literals pass the TypeScript cast but fail
   at runtime with `502 "schema is not a function"` — invisible to unit
   tests because `ChatFn` is stubbed (correctly, per the no-live-AI-tests
   rule). RULE: after touching tool/SDK wiring, ALWAYS run one live smoke
   turn against the real provider before declaring victory.

10. **React 18 + framer-motion `AnimatePresence mode="popLayout"`**: direct
    children must be `forwardRef` components (React 19 doesn't need it).
    Symptom: console warning "Function components cannot be given refs …
    Check the render method of `PopChild`". Ported demo code written for
    React 19 must be adapted.

11. **First-run gate is ONLY the `acute.setupDone` localStorage flag**
    (`providers-api.ts`); the comment in `App.tsx` about provider keys is
    stale. RULE: when a fresh browser gets hijacked to `/setup`, set the
    flag (`localStorage.setItem("acute.setupDone","1")`) and re-navigate —
    don't debug the sidecar.

12. **`VITE_ACUTE_TOKEN` alone does NOT flip `demoData` off** — only
    `VITE_ACUTE_BASE_URL` does (config-store merge logic). RULE: for live
    browser sessions write BOTH into `.env.development` (gitignored), and
    delete it again before running `pnpm verify`/committing anything.

13. **Dev CLI output must be pipe-safe** (round-10 fix): `acute.mjs raw`
    used to print `status + body` on stdout, which silently broke every jq
    pipe. RULE: status/diagnostics → stderr, data → stdout. Fixed 2026-08-23
    (also fixed the `agents` command printing the non-existent `modelId`
    field — it's `model`).

## Secrets discipline

14. **Lengths only, ever.** Keys are staged at `/home/z/.secrets/` (0600,
    outside any repo) in this sandbox; values must never appear in commands
    that get logged, in repo files, docs, or ntfy messages. The git remote
    stays tokenless (sanitize after the initial PAT clone). Both round-9
    secrets transited the chat transcript once — the owner will rotate.

15. **Verify the repo is PRIVATE before every push** (`GET
    /repos/testplay-byte/ACUTE-CODE` with the PAT → `"private": true`).
    Cheap check, closed-source product, one bad push is fatal.

## Round-11 lessons (the Windows .bat failure + launcher redesign)

16. **.bat files written from Linux MUST get explicit CRLF endings**
    (2026-08-23, owner-reported failure). The round-10 `ACUTE.bat` shipped
    LF-only; cmd.exe ate characters (`echo`→`cho`) and broke every `goto`
    label — the whole script disintegrated (`'/d' is not recognized`…).
    RULE: generate .bat files via a script that inserts `\r\n` deliberately
    and verify with `file` → must say "with CRLF line terminators". Keep
    .bat files tiny coordinators (no big logic, minimal labels) — real logic
    belongs in Python/Node where line endings don't matter.

17. **git credential `store` helper FILE format is URL LINES**
    (`https://user:token@host`), NOT the `credential approve` stdin format
    (`protocol=`/`host=`/…). The wrong format fails silently: the helper
    matches nothing and git falls through to an interactive prompt
    (`fatal: could not read Username`). Hit while building the launcher's
    isolated auth. Also: quote the `--file=` path inside the helper value
    (`credential.helper=store --file="C:/A B/x"`) — git runs helpers through
    a shell, and launcher folders can contain spaces.

18. **`rich` version quirks**: `Panel(box="double")` crashes on some
    versions (`'str' object has no attribute 'substitute'`) — use the
    default box. And `rich.__version__` doesn't exist in every version —
    probe library availability with `try: import`, never `__version__`.

19. **Never hide your own diagnostics** (2026-08-23): my rich-availability
    check piped a traceback through `sed -n 1p`, which kept only the first
    line — the actual error was invisible and I misdiagnosed rich as
    "missing". Same family as the PIPESTATUS lesson: when a check fails,
    print its FULL output before concluding anything.

20. **Credentials-file pattern (owner-approved)**: the owner explicitly
    accepts a plain local `credentials.txt` (launcher folder, never
    committed, never uploaded) holding GITHUB_PAT + OPENROUTER_KEY — he
    rotates/clears them himself. The launcher still rejects placeholder
    values and never logs the contents (lengths only).

## Round-12 lessons (the Windows credential-helper failure)

21. **Never put quoted paths inside `credential.helper` config** (2026-08-23,
    owner-reported). `credential.helper=store --file="C:/..."` works on Linux
    but Git-for-Windows routes helpers with shell metacharacters through MSYS
    `sh`; from a non-tty Python subprocess the helper never answered and git
    fell back to a terminal prompt → `bash: /dev/tty: No such device or
    address` → `fatal: could not read Username` → clone dead. ROBUST PATTERN
    (now in the launcher): per-command env with **HOME → isolated dir** +
    **GIT_CONFIG_NOSYSTEM=1** + the **single word** `store` helper (no path,
    no quotes, no shell) + credentials in the store helper's native
    `<HOME>/.git-credentials` URL-line format (`https://user:token@host`).
    Bonus: the user's real global gitconfig and GCM are never touched. And
    ALWAYS pre-flight the token against the GitHub API so a bad token shows a
    precise "generate a new one" message instead of git prompt gibberish.

22. **A .bat that shows a rich Unicode UI must set the console to UTF-8**
    (`chcp 65001 >nul`) AND run Python with `PYTHONUTF8=1` — without it the
    panel borders render as garbage in the default OEM codepage ("breaking up
    at the top", owner-reported). Round-10's .bat had chcp; the round-11
    rewrite dropped it — regressions of erased hard-won fixes are a real
    failure class: when rewriting a file, diff it against the OLD version's
    hardening touches first.

23. **Never build rich console output with inline markup around dynamic
    text.** `console.print(f"[bold yellow]![/bold] {msg}")` crashed with
    MarkupError on this rich version — and ANY user-visible string containing
    brackets (paths, "[1]" prefixes) can break markup parsing. Use
    `console.print(text, style=...)` and `Text(...)` (literal) instead;
    `Panel(Text(...))` is safe by construction.

24. **Git credential HELPERS are environment-sensitive — token-in-URL is not**
    (2026-08-23, two owner-reported Windows failures). Both helper variants
    (`store --file="C:/..."` AND the single-word `store` reading
    `$HOME/.git-credentials` under an isolated HOME) worked on Linux but never
    answered on the owner's Git-for-Windows 2.55 — git fell back to a prompt
    that cannot exist in a double-clicked console (`/dev/tty` /
    `failed to execute prompt script`). RULE for unattended/launcher git:
    authenticate by passing `https://user:token@host/...` directly to the ONE
    command (clone/fetch/pull), then `remote set-url` back to the tokenless
    URL immediately (never persist); set `GIT_TERMINAL_PROMPT=0` +
    `GIT_CONFIG_NOSYSTEM=1` + isolated `HOME` so git can never hang or consult
    foreign config; register the token AND the full authed URL with the log
    redactor. This is the CI-proven pattern precisely because it has no
    helper machinery to break. Also: pre-flight the token via the GitHub API
    and DECODE git failures into human diagnoses (auth / network / disk /
    leftover-folder patterns).

## Round-14 lessons (agentic-system round)

25. **`/internal/*` routes mount WITHOUT the `/api/v1` prefix** (they sit at
    the app root next to /health, outside the versioned scope — see
    /internal/providers/keys). The frontend `request()` helper always
    prefixes `/api/v1`, so internal endpoints need a direct `fetch()` with
    the bearer header. Hit this when the folder-picker client 404'd.

26. **zustand selectors must return STABLE references** — `(s) =>
    s.todos[id] ?? []` builds a fresh array on every snapshot → React
    "getSnapshot should be cached" infinite loop → the whole screen dies.
    Use a module-level `const EMPTY: T[] = []`. Same class of bug applies to
    any `?? {}` / `?? derived` inside a selector.

27. **CLI batteries must filter template agents** (`GET
    /agents?includeTemplates=false`); a bare GET returns templates, a
    template has no provider/model and every message POST 409s confusingly.
    (The UI hooks already filtered correctly — only my raw CLI call was
    wrong.)

28. **Blocking dialogs in a server: always async spawn.** A spawnSync folder
    dialog would freeze the ENTIRE sidecar (health checks included) for as
    long as the human takes to click. Same rule applies to any subprocess
    that waits on a human.

## Round-15 lessons (owner's Windows test verdicts)

29. **A "user cancelled" result is only trustworthy with a protocol.**
   Mapping ANY failed dialog run to "cancelled" made the folder picker fail
   SILENTLY on the owner's Windows (he clicked Browse; nothing happened).
   RULE: human-facing dialogs must emit explicit markers (ACUTE_PICK:/
   ACUTE_CANCEL), treat anything else as a failure, and return the failure
   text to the UI — a cancel and a crash are never the same event. Windows
   dialogs also need a fallback method (WinForms FolderBrowserDialog →
   Shell.Application BrowseForFolder COM) because WinForms can refuse to
   pump from background console processes.

30. **CSS-animated dialogs must carry the end-state transform as their BASE
   style.** An animation from/to translate(-50%,-50%) with no base transform
   makes the dialog jump half off-screen the instant the animation ends —
   on the owner's PC the agent dialog "centered for a moment then went
   outside the view" and create/edit looked like dead buttons because the
   dialog opened OFF-SCREEN. Rule: base style == animation's final keyframe
   (position, transform, opacity) for every animated surface.

31. **Never ship a chat product that requires setup before first message.**
   A fresh install had zero agents → "Create an agent in settings" dead-end
   (owner: "by default there is actually no need for any agents or anything
   like that to be set up"). Fixed with ensureDefaultAgent seeding Nova at
   DB open (guarded: never when the user already created an agent). Rule:
   fresh-DB smoke tests must cover the FIRST-USER JOURNEY (open → send
   message), not just API CRUD.

32. **Test the whole journey on a fresh DB before claiming "works"** — most
   round-15 bugs were invisible on my long-lived dev databases (agent
   existed; dialog untested on Windows). The fresh-DB battery (seed →
   project → session → owner-scenario prompt → disk assertions) is now the
   standard pre-handover gate for anything touching agents or projects.

## Round-16 lessons (streaming + the sandbox wipe)

33. **Push large rounds to a WORK BRANCH incrementally.** The sandbox was
   wiped mid-round and the entire uncommitted round was lost (the repo is the
   single source of truth — an uncommitted working tree is worth nothing).
   RULE: for any round touching many files, `git checkout -b work/<round>`
   at the start, commit+push after each green milestone (backend green,
   frontend green, docs), merge to main only when the full verify + live
   battery pass. Restore afterward = clone + `SANDBOX-RESTORE.md` + cherry
   -pick nothing. Cost of the wipe this time: one full redo; with branches
   it would have been zero.

34. **AI SDK v7 streaming details**: text deltas arrive as
    `part.text` (NOT `.delta`); usage may only be reported per
    `finish-step` — cross-check `await result.totalUsage` against summed
    per-step usage and take the larger, or streamed turns persist 0/0.

35. **End-to-end test completion signals must be OUTCOME-based, not
    time-based**: poll the on-disk file / the specific new DOM text, never
    "sleep 40s". Also verify you drove the RIGHT element (I typed a prompt
    into the TopBar file-search twice before snapshotting refs), and beware
    stale assertions (a "tok/s" poll matched the PREVIOUS turn's stats).
   Disk is the ground truth for file-mutation turns.

36. **Fine-grained PATs have a FIXED repository selection** — repos created
    after the token are invisible to it (API says push:true, then contents
    PUT / git push 403 with "Resource not accessible by personal access
    token"). RULE: a new repo + existing PAT requires the OWNER to edit the
    token's Repository access (or mint a scoped token); design publishers to
    detect 403 and print the exact owner fix (publish-dashboard.mjs does).

## Round-28 lessons (sandbox wipe + restore governance)

37. **Sandbox wipes happen — GitHub is the backup, not the working tree.**
    On 2026-08-24 the entire `/home/z/acute-workspace/` was wiped between
    sessions; only `/home/z/my-project/worklog.md` (330 lines, rounds 1–15
    sandbox-local copy) + the GitHub remotes survived. The owner had pushed
    everything before the wipe, so NOTHING was lost — the restore was just
    re-clone + re-stage secrets. RULE: push every green milestone, not just
    round-end. The new `/home/z/PROJECT/{ACUTECODE,DASHBOARD}` layout is the
    permanent restore target. If the sandbox wipes again, DO NOT attempt
    autonomous recovery — ntfy the owner
    (`curl -d "ACUTE-CODE sandbox wiped" https://ntfy.sh/TASKISDONE`) and
    stop. The owner re-supplies tokens in chat in <5 min.

38. **Per-repo suffixed secret files when two PATs are scoped to two
    different repos on the same host.** GitHub fine-grained PATs are
    per-repo-scoped, so the ACUTE-CODE PAT can't push to DASHBOARD and
    vice versa. Use per-repo credential stores (`git-credentials-acute` +
    `git-credentials-dashboard`) and per-repo `credential.helper` config
    in each clone's `.git/config`. Don't try to mix two tokens in one
    credential store — git's longest-prefix match is correct but fragile,
    and debugging it wastes hours. The suffixed naming
    (`github-acute-code.pat`, `github-dashboard.pat`) makes it obvious
    which token is which at a glance.

39. **ntfy is the task-completion notification channel, NOT just sandbox-wipe
    (owner revision R29 — supersedes the R28 rule).** The R28 rule
    ("ntfy ONLY for sandbox-wipe + owner-APPROVE") was WRONG — the owner
    explicitly told R29: "Make sure to send me a notification properly
    too afterwards so that I can be notified that the task has been
    completed and such. And to send the notification use the topic
    'TASKISDONE'." Corrected RULE: send an ntfy ping to
    `https://ntfy.sh/TASKISDONE` at the END of every session in which the
    owner gave a task directive and the work was completed. Title the
    message with the round number + a one-line summary; body = brief
    outcome (what was delivered, what was verified, what remains if
    anything). Do NOT ntfy mid-session for individual milestones — only
    the end-of-session close-out. If the owner said CHANGES/PIVOT and
    you're still iterating, no ntfy — wait until the iteration converges
    and the session is wrapping up. The sandbox-wipe case is unchanged:
    that ping remains mandatory the moment a wipe is detected.

40. **Screenshot zip upload target changed (owner revision R28).** Round 27's
    `round-27-testing-screenshots.zip` lives at the ACUTE-CODE repo root.
    From round 28 on, screenshot zips go to the **public DASHBOARD repo**
    at `screenshots/round-NN.zip` with an index entry in `data.json`. The
    DASHBOARD repo's `build.mjs` denylist was updated to allow `screenshots/`
    paths (the denylist scan only applies to files that end up in
    `index.html` / `assets/` — the `screenshots/` directory isn't touched
    by the build, so it's safe). Publish via
    `pnpm dashboard:publish-screenshots <NN>` (Workstream K).

41. **The DASHBOARD repo's GitHub Pages CI auto-rebuilds `index.html` on every
    push — this creates a divergent commit that blocks the next push.** When
    `publish-screenshots.mjs` pushes a new screenshot zip + data.json, the
    CI runs `node build.mjs` + commits the rebuilt `index.html`. By the time
    the next push arrives, `origin/main` is ahead by that CI commit →
    `git push` fails with "non-fast-forward". RULE: after EVERY DASHBOARD
    push, the NEXT DASHBOARD operation must `git fetch && git pull --rebase`
    first. The `publish-screenshots.mjs` script's token-in-URL push can
    fail on this; recover with `cd /home/z/PROJECT/DASHBOARD && git fetch
    origin && git pull --rebase origin main` then re-push. The rebase
    sometimes conflicts on the generated `index.html` — resolve by running
    `node build.mjs` (regenerate from source) then `git add index.html &&
    git rebase --continue`. Lesson: prefer pushing SOURCE files only
    (template.html, app.js, style.css) and let CI rebuild index.html; if you
    must push a rebuilt index.html, expect the rebase dance.

42. **pnpm is NOT on the default PATH post-sandbox-wipe — install via
    corepack, then shim.** `corepack enable` fails on this sandbox (needs
    root to write to /usr/bin), but `corepack prepare pnpm@11.22.0 --activate`
    works and lands the binary at `/home/z/.cache/node/corepack/v1/pnpm/`.
    `corepack pnpm` invokes it, but plain `pnpm` isn't on PATH. RULE: create
    a shim at `/home/z/.local/bin/pnpm` (a 3-line bash script that `exec
    corepack pnpm "$@"`), then prefix EVERY Bash call that runs pnpm with
    `export PATH=/home/z/.local/bin:$PATH`. The shim survives across shell
    invocations; the corepack binary doesn't need re-activation once cached.

43. **Background processes (vite, sidecar) die between Bash invocations in
    this sandbox — run live batteries as ONE self-contained script.** The
    sandbox kills the whole process group when a Bash call returns. `nohup
    cmd &` + `disown` + `setsid` all fail to survive across invocations.
    RULE: for any live battery (sidecar boot + curl SSE, vite + agent-browser
    screenshots), write ONE Bash command that: setsid-launches the process,
    polls for readiness, runs the test, kills the process, all in sequence.
    The ORCHESTRATOR-METHOD §3.4 documents this as the "single self-contained
    invocation" pattern. Vite binds to localhost which may resolve to ::1
    (IPv6) — use `--host 127.0.0.1` to force IPv4 so curl + agent-browser
    can reach it.

44. **The demo-mode auto-detect is THE fix for "completes all tasks then
    shows results" (owner R28 complaint #4).** Root cause: `demoData`
    defaults `true`; in demo mode `AgentChatPanel` falls back to the
    SYNCHRONOUS `POST /sessions/:id/messages` route (entire turn returns
    only AFTER all tool calls + final text complete). The SSE streaming
    route exists + works (R16), but never activated because `liveMode =
    !demoData` was false. FIX (WS-D2 `useSidecarHealth`): on app boot, ping
    `GET {baseUrl}/api/v1/health`; if 200 + token, `setDemoData(false)` →
    streaming activates. The config-store already flips demoData false when
    `VITE_ACUTE_BASE_URL` is set (env path); the health-ping covers
    browser-dev + Tauri-shell-not-yet-answered. RULE: when the owner reports
    "no typing effect" or "completes then shows", FIRST check whether
    demoData is true (the sidecar may be unreachable) — the streaming
    pipeline itself is sound.

45. **The "model is not capable" attribution was wrong — the issues were in
    OUR project code (owner R28 directive #5).** The `stealth/ox-alpha`
    model IS capable. The multi-turn continuation complaint was a missing
    OUTER LOOP in the runtime (the SDK's internal multi-step loop ran, but
    the runtime did NOT start a NEW SDK call when the task wasn't
    genuinely complete) + a missing AGENTIC LOOP section in the system
    prompt (no instruction to use 4-7+ tool calls, verify saves, not stop
    after one). FIX (WS-F): outer loop (maxOuterLoops 5) + AGENTIC LOOP
    prompt + inverted continueIfUnfinished (continue UNLESS explicit
    completion signal AND all todos done). RULE: before attributing an
    agentic-quality issue to the model, audit the runtime (is there an
    outer loop?) + the prompt (is there a multi-turn instruction?). The
    MS-3 live battery proved this: with the outer loop + prompt, the model
    made 5 tool calls + verified its own save + emitted "Done." — exactly
    the owner's workflow.

46. **Doc-stamp CI gate (WS-J1) is warn-only until the stamp backfill
    (WS-J2) lands.** `scripts/docs/check-stale.mjs` fails on docs missing
    the `<!-- last-reviewed: 2026-09-11 round-88 -->` stamp. Existing docs
    (21 ADRs, ~20 runbooks, ~10 research notes) don't have it yet. CI is
    `continue-on-error: true` for now (R28 shipped the infra + the
    contract; J2 will bulk-add stamps via `scripts/docs/stamp-all.mjs`
    + flip CI to fail-closed). RULE: when adding the stamp contract to a
    repo that didn't have it, ship the check + the one-shot stamp script
    in the same round, then flip CI to fail-closed once the backfill lands.
    Don't ship the check fail-closed on day 1 — every existing doc fails.

47. **`reply.hijack()` silently drops headers set via `reply.header()` — the
    round-30 "Failed to fetch" root cause.** The SSE streaming route hijacks
    the Fastify reply and writes the raw response itself; CORS headers set in
    an onRequest hook never reach the wire, so every cross-origin streamed
    message was rejected by the browser with a bare `TypeError: Failed to
    fetch`. RULE: any hijacked route must spread its CORS/security headers
    into the raw `res.writeHead()` explicitly (see `corsHeadersFor()` in
    server.ts). If a fetch works via curl but fails in the browser, suspect
    exactly this class of bug.

48. **URL params are the single source of truth for "which session am I in".**
    Round-30's "all the sessions are exactly the same" bug was the chat panel
    binding the project's latest session instead of the `?session=` param the
    sidebar writes. RULE: any per-entity screen (chat, editor, viewer) reads
    its entity id from the URL, falls back to a sensible default, and UPDATES
    the URL when it creates a new entity — otherwise every navigation surface
    (sidebar rows, New buttons, browser back) desyncs from the screen.

49. **Live batteries: kill orphan listeners BEFORE booting, and keep each
    battery script under ~2 minutes.** A timed-out Bash call leaves servers
    running (the sandbox reaps them late, not immediately), so the NEXT
    battery can hit `EADDRINUSE` and silently test against a STALE sidecar
    (old code, wrong DB — the battery looks green but proves nothing). RULE:
    every battery script starts with `pkill -f "agent-core/dist/main.js";
    pkill -f vite`, and each script covers ONE phase (boot+seed / streaming /
    UI interactions) rather than one giant end-to-end run.

50. **Design references arrive as compiled React HTML — extract specs from the
    live DOM, not the source.** The owner's AI design tool exports a bundled
    artifact (one 200KB+ minified file, React runtime included) where the
    visual structure only exists after render. RULE: open it with
    agent-browser (`file://`), find the scaled canvases
    (`getBoundingClientRect` ≈ 52% of 1920 — the computed styles carry the
    REAL design values; divide bounding rects by the transform scale), and
    pull computed styles for every component (background, radius, border,
    shadow, fontSize). VLM alone misreads exact colors/shadows; DOM
    extraction + VLM cross-check together give faithful specs.

51. **Snapshot rows are stamped with the TURN's starting seq, not the tool
    event's seq.** `runtime.ts` computes `turnSeq = lastSessionSeq + 1` BEFORE
    the user message lands, so a write_file tool.use at event seq 2+ has its
    file_snapshots row at seq 1 (or wherever the turn started). A direct
    `GET /sessions/:id/snapshots/:toolSeq` 404s and diffs render "no snapshot
    recorded". RULE: resolve via the checkpoints list
    (`fetchSessionCheckpoints`) — same path, greatest snapshot seq ≤ tool seq
    (`resolveSnapshotForTool` in api.ts). If the runtime is ever touched,
    consider recording snapshots AFTER the tool.use event with its actual seq
    — but that's a backend change requiring a migration story.

52. **A conversational reply (zero tool calls) is a STOP signal for agentic
    loops.** The R28 inverted heuristic ("continue unless completion-signal
    AND todos-done") loops forever on chat messages — greetings have neither
    signal nor todos, so the model gets re-invoked and invents work. RULE:
    any outer-loop/continuation heuristic MUST break when an iteration
    produced text but NO tool calls. Completion-phrase matching alone is
    never sufficient.

53. **Sidebar identity lives in ONE component.** The AcuteLogo (rounded
    orange tile, geometric white "A", hover-morph to a panel toggle) is used
    in BOTH the sidebar header and the floating show-sidebar button — import
    from Sidebar.tsx (`export function AcuteLogo`). Changing the mark means
    changing ONE SVG; never re-draw the logo inline elsewhere.

54. **Tool results MUST feed back into agentic conversation history.** The
    R34 root cause of "does not handle multi-step tasks properly": the event
    log recorded tool calls but assembleHistory only rebuilt user/assistant
    text — outer-loop iterations re-planned blind. RULE: any agentic loop
    that re-assembles context from a persisted log must fold tool calls AND
    results into the model-facing messages (Cline parity), wrapped in
    data-markers with a system-prompt injection guard.

55. **Scrub secrets at EVERY boundary: persist AND emit.** Tool output
    (especially run_command, which inherits process.env holding
    ACUTE_PROVIDER_* keys) must pass through scrubSecrets() (keyring.list()
    values + sk-/pat- patterns) before BOTH the SQLite write and the SSE
    emission — the R34 review caught the sync path skipping it entirely.
    RULE: when adding any output-persisting feature, grep for both sinks.

56. **Interim assistant SEGMENTS are the unit of interleaving.** When tool
    calls land mid-message, flush the text-so-far as an assistant event so
    the log reads text → tool → text (owner R35). Stats attach ONLY to the
    final segment; a tool-terminated turn appends an empty-content stats
    CARRIER that history-skips (asChatMessage) and the item-folding merges
    into the last real message — otherwise reply badges silently vanish.

57. **Sandbox wipes can happen MID-round.** R35 started with /home/z/PROJECT
    gone (ntfy fired per the standing rule). The GitHub backup restored both
    repos at the exact round-34 tips in ~3 minutes (credentials from the
    conversation history, pnpm shim, .env.development, pnpm install, tests
    green). RULE: push after EVERY round, never leave work unpushed.

58. **Semaphore reservation must be ATOMIC (check + increment in one
    synchronous step).** The R36 orchestrator initially checked capacity,
    returned the slot, and incremented AFTER — two concurrent delegate calls
    both passed the check and overran the limit (the test caught it:
    "expected queued, received completed"). RULE: any concurrency gate
    shared across async boundaries needs check-and-reserve as ONE
    synchronous operation, or it's not a gate.

59. **Sub-agent session ids flow through the tool OUTPUT, not argsSummary.**
    The child id only exists AFTER the tool executes — so the delegate tool
    prefixes its report with "[subagent session: … | role: …]" which
    survives into the persisted outputSummary; the UI parses it from there.
    argsSummary only ever carries the INPUT (task/role). RULE: for
    tool-generated resources the UI needs, embed the handle in the tool's
    output string in a machine-readable prefix.

60. **Persisted-view grouping must match the live-view shape or the seams
    show.** The R35 live renderer deduplicated headers but the folded log
    re-rendered them per event — the owner SAW the seam ("a new chat
    started"). RULE: when a live view special-cases rendering, the canonical
    fold must produce the same structure; otherwise the post-stream swap
    visibly changes the screen.

61. **Ask for credentials the moment a wipe is detected — don't search the
    filesystem for them.** R37 started with ~30 min of PAT hunting that
    found nothing (by design: secrets live outside every repo and temp
    dir). The round-28 rule (notify + stop) exists for exactly this. RULE:
    on wipe → ntfy → ASK THE OWNER → restore. Zero exceptions.

62. **Prefix allow/blocklists collide (vite blocked vitest).** Short
    command prefixes like "vite" silently matched "vitest" in the R37
    approval engine. RULE: exact-word commands get word-boundary regexes,
    not raw prefixes; add the collision case to the tests immediately.

63. **A settings tab lives in TWO registries — add it to both or it is
    unreachable.** R43 added the Sub-agents tab to `TABS` in
    `src/pages/SettingsPage.tsx` but not to `SETTINGS_SECTIONS` in
    `src/components/shell/Sidebar.tsx` — and since R34 the sidebar IS the
    settings nav, so the whole tab (the sub-agent key pool the owner was
    promised) was invisible except by hand-typing `?tab=subagents`. The R44
    VLM pass (agent-browser screenshots of every settings screen + vision
    analysis) caught it; the same pass caught dashboard cards linking to the
    dead `/sessions` route. RULE: any new settings section must update BOTH
    registries in the same commit (see MAINTENANCE.md recipe c), and a round
    that adds a screen must VLM-verify the NAV path to it, not just the
    deep link.

64. **A feature that ships to an unrouted component does not exist.** R44-c
    built the SessionsScreen (session search + fork, two-pane, 23 passing
    unit tests) and the round report called it delivered — but NO route
    imported the component, so the feature was unreachable at any screen
    size and no user could ever see it. Worse, an old App-level test
    asserted "no Sessions nav entry exists" — a test that had PINNED the
    bug as correct behavior. The R45 VLM/browser pass caught it (clicking
    through the real UI, not reading test output); now routed at `/sessions`
    + a sidebar entry. RULE: a NEW screen is verified reachable by CLICKING
    to it from the app shell in a real browser (or VLM pass), never by its
    own colocated tests alone — those prove the component works, not that
    anyone can open it. When wiring it, also grep for existing tests that
    assert the OLD nav shape: they may have pinned the absence.

65. **A backend route without a frontend caller is a feature that does not
    exist — and nothing guards routes the way the drift guard guards
    tools.** The `POST /checkpoints/:id/restore` route + `restoreSnapshot()`
    shipped in round 25 and stayed GREEN in every test run for 21 rounds —
    yet no api.ts function and no button ever called it, so users could not
    restore agent-mutated files from the UI at all (the same lesson-#64
    shape, one layer deeper: not an unrouted COMPONENT but an uncalled
    ROUTE). Nothing flagged it: the R45 TOOL_CATALOG drift guard covers
    agent TOOLS only, and a route with zero callers fails no test — the
    server suite tests routes it exercises itself. Caught in R46 only
    because the round's recon explicitly hunted "what a highly capable
    agent is missing". RULE: when a round ships a REST route, the SAME
    ROUND (or its docs wave) must ship or verify the caller — and periodic
    recon should diff `scope.<method>(...)` registrations in server.ts
    against `src/lib/api.ts` client functions, the same way the drift test
    diffs TOOL_NAMES against TOOL_CATALOG. IMPLEMENTED-API.md is the place
    the gap shows: a route documented there with no consumer named is a
    smell.

66. **A feature that silently depends on baked-in defaults hides its own
    broken input path.** The R44 launcher sub-key flow "worked" for three
    rounds (44–46) purely because `DEFAULT_SUB_KEYS` injected the same three
    keys the owner was expected to paste — while the credentials parser's
    regex `^([A-Za-z_]+)` could not match names containing DIGITS, so the
    owner's own `OPENROUTER_SUB1/2/3_KEY` lines were silently NEVER parsed
    and his values were always ignored (`ACUTE.bat status` always showed
    slots unset). Every test and the live battery passed against the
    DEFAULTS, not the input path. Only deleting the defaults (R47's key
    scrub) surfaced the bug — via simulation, in the same round. RULE: when
    a feature has a baked-in fallback, test the no-fallback path explicitly
    (run once with the defaults removed) BEFORE shipping; and when you
    remove a fallback, first prove the primary path it was masking actually
    works — the fallback is where input bugs hide.

67. **A green suite that mocks a backend's CONTRACT instead of its BEHAVIOR
    hides the production bug.** The R48 browser flash-loop (owner-reported:
    the embedded browser "flashes every one or two seconds… eventually
    'ticket missing, expired or invalid'") was invisible to the 9 passing
    BrowserPanel tests for five rounds (the rotation bug was original R43
    code) because the panel's fetch mock
    returned the SAME ticket from every `POST /browser/session` and never
    simulated rotation — the mock copied the routes' shapes (contract) but
    not the semantics that mattered (behavior): `SessionStore.create()`
    ROTATES on every call, and navigate/viewport were silently invalidating
    the ticket the panel was still using. The panel "adopted a new ticket"
    in tests that was secretly still the old one, so every recovery path
    looked healthy while the real backend re-killed the credential under
    it. The R48-d fix mock mirrors the real semantics (mint rotates and
    kills the previous ticket; navigate/viewport never change ticket
    validity; the probe 401s iff `bt` ≠ the session's current ticket) — and
    the new regression tests were stash-verified to FAIL against the
    pre-fix backend before being accepted. RULE: when a component test
    mocks a stateful backend, the mock must reproduce the backend's
    STATE-CHANGING behavior (what rotates/expires/invalidates what), not
    just its response shapes — and when you fix a bug found only in
    production, prove the new tests fail on the old code (stash the fix,
    run them, restore) so you know the mock finally sees the class of bug
    it missed.

68. **A migration that APPENDS to a "means-everything" sentinel destroys
    the sentinel — and fresh-install tests can never see it.** The R49
    root cause of "the main agent has no file tools": the default agent is
    seeded with `allowed_tools = []`, which per ADR-0019 means ALL tools;
    migrations 0014+0015 then `json_insert`-appended the new tools to that
    empty array "when missing" — converting "all tools" into an explicit
    allowlist of exactly the five appended tools on every database seeded
    BEFORE those migrations ran. No test or battery ever caught it because
    `openDatabase` runs migrations BEFORE the agent seed on a FRESH
    database — the append finds no row and the agent later seeds as `[]`,
    so every clean install (every sandbox round) was healthy while the
    owner's long-lived Windows database was crippled. Compounding: the
    crippled agent honestly REPORTED its five tools, and a sub-agent
    (children run the parent's agent row) SAVED that observation to
    project memory — the memory system then auto-injected "sub-agents have
    no write_file" into every subsequent turn, teaching even repaired
    agents to refuse work (the digest is now excluded from child turns,
    and the memory master switch lets the owner kill the whole system).
    RULE: before a migration mutates a column whose EMPTY/NULL value is a
    meaningful sentinel ("all"/"none"/"inherit"), check what the seed
    writes AND what order openDatabase runs seeds vs migrations; and test
    damaged-database repair against a database built the OLD way
    (hand-applied migrations + hand-seeded rows), never only against fresh
    installs. When a stored "capability" claim contradicts a live report,
    suspect a stale MEMORY before suspecting the code.

69. **A live battery against a SHARED database is only valid under strict
    single-process hygiene.** (2026-08-30, round-50 battery.) The first
    battery runs left orphaned sidecar processes (the harness's `kill
    $SIDECAR` silently failed to reap the backgrounded node process), and a
    LATER boot's `sweepStaleRunning` then flipped a LIVE session belonging
    to ANOTHER process to `failed` mid-turn (its last event at sweep time
    was a tool.use, not a closing assistant message) — the delegation turn
    then 409'd with "session is failed", sending the orchestrator chasing a
    phantom status-machine bug through runtime.ts, the SSE close handler,
    and every `setSessionStatus` call site for half an hour. The product
    code was CORRECT: one sidecar per DB (the only supported topology — the
    Tauri shell spawns exactly one) makes the race impossible, and the clean
    re-run proved queued → running → queued on every turn. RULE: any script
    that boots a sidecar against a persistent DB must (a) `pkill -f` by
    exact entrypoint + verify the port is FREE before booting, (b) verify
    the process actually died after `kill` (check the port, not the exit
    code), and (c) treat "a status changed but no code path writes that
    status" as MULTI-PROCESS interference first — grep the writers, and if
    the only writer is a boot-time sweep, suspect a second boot you didn't
    know about.

70. **A green gate that verifies the wrong platform is worse than no
    gate — it launders the failure into "proven".** (2026-08-31, round-57;
    the fourth packaged-engine crash in a row, each with a different root
    cause.) The R51 staging check "booted the staged tree and curled
    /health" — **on Linux**. The tree it booted was a pnpm link farm
    (189 symlinks; junctions on the Windows build runner), which Linux
    resolves happily and tauri-bundler + NSIS pack/extract does NOT
    preserve — so the owner's installed engine died with
    ERR_MODULE_NOT_FOUND before its first log line while every check was
    green. The round-56 audit even called the staging "Sound" because the
    audit asked "are the versions/layout right?", never "can the
    INSTALLER's target platform extract this?". RULE: for anything that
    ships, the verification must run ON THE SHIPPING TARGET with the
    SHIPPING ARTIFACT (the release now boots the real staged engine with
    the real pinned node.exe on windows-latest BEFORE packing it), and
    any tree handed to an installer must be walked for
    symlinks/junctions — links are a BUILD-machine convenience that
    installers do not owe you. Generalized: when a check passes but the
    field fails, the first question is not "what else is broken" but
    "what does this check NOT actually exercise?".

71. **The .d.ts lies twice: read the type the CONSUMER actually resolves,
    not the one that greps first.** (2026-08-31, round-58; caught by
    typecheck after the tests passed.) The AI SDK v7 ships TWO
    `tool-input-start`/`tool-input-delta` shapes: the UI-message parts
    (`toolCallId` / `inputTextDelta` — greps first near the top of
    index.d.ts) and the fullStream parts (`id` / `delta` — what
    `result.fullStream` actually yields). The first implementation (and
    its passing tests — the mocks mirrored the wrong shape) used the
    wrong field names; TypeScript flagged `Property 'toolCallId' does not
    exist` and the fix was two lines. RULE: when consuming a library type
    through a union/iteration, grep for the type the ITERATION SITE
    resolves (search the `TextStream*Part` family, not the message
    family), and treat "tests green" + "types red" as the tests mocking
    the wrong shape — mock from the CONSUMER's resolved type, never from
    a doc example.

72. **An ordering you never questioned IS the bug: "latest" is a sort
    order, not a fact.** (2026-09-07, round-74; the owner's frozen
    updater.) The installed desktop app sat on 0.67.0 while 0.73.0 was
    live, with zero errors anywhere — because the launcher's first-match
    walk trusted GitHub's /releases list order, and that list sorts
    never-published DRAFTS above every published release (the R63–R67
    close-outs left five drafts at positions 1–5). It "used to work"
    precisely because in the all-drafts era list order was harmless.
    RULE: whenever code derives "the newest/latest/best" from an
    externally-ordered list, ask what the sort key actually is and
    compute the fact yourself (max version via integer tuples); and
    close out drafts the same round they are created (recipe g), because
    an ordering artifact today is a field incident months later.

73. **A library can report failure WITHOUT throwing: exhaust the
    non-throw channels before trusting the error you see.** (2026-09-07,
    round-75; caught only by driving a REAL 429 through the live stack.)
    The AI SDK surfaces post-retry provider errors as fullStream ERROR
    PARTS — the iterator never throws — so our adapter's for-await
    skipped them and the runtime only ever saw the generic
    `NoOutputGeneratedError` ("Check the stream for errors": no status,
    no message patterns). Every mock in the suite threw the way the code
    expected, so 2558 tests were green while REAL rate limits classified
    `unknown` and the entire retry ladder was dead on arrival. RULE: for
    any streaming/queue API, enumerate the union of failure channels
    (throw, error part, error frame, done-with-error flag, empty
    completion) and test against the channel the real producer actually
    uses — a live repro of the failure beats any mock for the happy
    path's error twin.

74. **`flex-1` silently eats inline height styles: when CSS and JS both
    size an element, verify WHO is winning — on screen, not in the
    code.** (2026-09-07, round-75; the textarea that never grew.) The
    autosize JS set `style.height = 132px` and every reader of the code
    believed it; the live DOM kept `clientHeight = 34px` because the
    textarea's `flex-1` (flex-basis 0%) let the flex algorithm override
    the height style — for TWENTY-FIVE rounds, while the owner reported
    "cut off to two lines" and each round's fix attempt adjusted the JS.
    RULE: when an element is both flex-sized and style-sized, only ONE
    wins — pick the single source of truth (here: drop `flex-1`, let the
    height style govern, set `maxHeight` alongside so CSS and JS never
    disagree), and prove sizing claims with live `clientHeight`
    measurements (the agent-browser snapshot), never with code reading.

75. **A freshness gate that fails 100+ files at once is a COHORT
    aging, not a content rot — diagnose the shape before the sweep.**
    (2026-09-07, rounds 53/54/75.) `docs:check` failed 162 of 173 docs
    in one run: the 3-round cap means every doc stamped by round N fails
    together at round N+4 (round-71's cohort aged out at 75), and
    `stamp-all.mjs` only ADDS missing stamps — it never bumps existing
    ones, so the "documented" fix tool cannot fix the actual failure
    mode. RULE: on a mass gate failure, first bucket the failures by
    error kind and check whether they share one stamp round (cohort) or
    scatter (rot); refresh cohorts with first-line-only stamp bumps
    verified via `git diff` (zero content drift), and record the refresh
    rule where the next agent will find it (DOC-STANDARDS §8, MAINTENANCE
    recipe g step 2b).

76. **"Complete but uncommitted" is a claim, not a state: after any
    session interruption, re-verify from zero before shipping.**
    (2026-09-07, round-75 close-out.) A prior session left R75 fully
    implemented, documented as verified — and uncommitted at context
    exhaustion. Re-running the entire ladder from scratch (2613 tests,
    lint, both typechecks, docs:check) surfaced exactly one real gap
    (round-75.md's missing stamp + the aged cohort, item 75) that the
    prior session's own "docs:check 172/0/0" claim had already papered
    over — the claim was true when written and false at ship time,
    because the round counter had moved. RULE: treat handoff claims as
    hypotheses; re-run the gates yourself, expect at least one drift
    between "verified" and "now", and never push a commit whose
    verification you did not personally watch happen.

77. **A "fresh key" is not a fresh quota (the R77 storm): OpenRouter's
    free-models-per-day cap is ACCOUNT-wide, not key-wide.** Swapping the
    sidecar from the exhausted key to any of the other three changed
    nothing — every key of one account shares the same daily 50-request
    free pool, and the 429 body says so (`limit_source:
    openrouter_free_tier_daily`, `X-RateLimit-Remaining: 0`, a
    `X-RateLimit-Reset` epoch). RULE: before diagnosing "the provider is
    broken" or "the app is not sending", read the 429's limit_source;
    when a battery dies mid-run, check the reset epoch and schedule the
    remaining stages after it — do not burn an hour re-testing with other
    keys from the same account.

78. **A vanished failure is worse than a failed failure: the R77 root
    cause behind "it was not sending the message properly" was not a send
    bug — it was the cleanup path ERASING the evidence.** A turn that
    failed without a persisted turn.error (pre-hijack rejections, dropped
    streams) fell through the stream-slice cleanup: the error card AND
    the user's optimistic bubble were both wiped, leaving the transcript
    looking like the send never happened. RULE: whenever you add
    "clear the live state after the turn ends" logic, ask what ELSE rides
    that state — an error that only exists in live state (never
    persisted) dies with the cleanup; keep the failure visible until the
    next send or persist it. A user who sees a red card retries; a user
    who sees nothing files "it's broken".


79. **Never paraphrase the provider's error into a class line: the class is
    a chip, the API's words are the message.** (2026-09-08, round-78; the
    owner's "no matter the real cause, the UI always shows 'rate-limited'
    — every other failure must show the API's ACTUAL error text".) The
    R71 classifier mapped 403 → "auth — the provider rejected the API key"
    even when the body said "This model is not available in your region",
    and every class rendered a GENERIC one-liner ("the provider is
    throttling requests") while the real text sat on a terminal card the
    owner only saw after six failed attempts. The owner's trust in every
    error card burned once — a card that says "rate-limited" during a
    region block is a lying UI, and the user stops believing ANY of them.
    RULE: a classification is a CHIP (one-glance routing: ladder or
    fail-fast), never the displayed message — display the provider's real
    text (scrubbed, capped) everywhere the error is shown, keep the class
    as the small label, and when the real text contradicts the class, the
    CLASS is what moves (403-region → unknown/fail-fast), not the text.

80. **`agent-browser open` is a HARD reload: live store state resets by
    design — assert persistence through in-app SPA navigation, and unwrap
    the SDK's RetryError before trusting any status.** (2026-09-08,
    round-78; the queue-round browser battery.) Two traps cost debugging
    time: (1) opening a URL fresh wipes the live stream store — the
    queued chips, the Stopped card + Continue, the retry card are LIVE
    state by design (the folded log owns the post-stream render), so a
    "chip disappeared after navigation" test via a fresh open tests the
    reset, not a bug; navigate in-app (SPA route changes) when asserting
    that live state survives. (2) The AI SDK wraps exhausted retries in a
    RetryError whose OWN message ("Failed after 5 attempts. Last error: …")
    carries NO status — extractStatus saw nothing and classification rode
    message-pattern luck; the real status lives one unwrap away in
    `lastError` (or the last `errors[]` element). RULE: when a library
    wraps failures, unwrap to the UNDERLYING error before classifying or
    displaying (and walk the wrapper chain for status, bounded + cycle-
    guarded); when testing ephemeral live state, drive the app like a user
    (clicks/SPA nav) instead of re-opening pages.


81. **A mock-provider oracle must assert on what the model RECEIVES, not
    what it generates — and the mock must fail the way the real failure
    class fails.** (2026-09-08, round-79; three real bugs in the
    battery's request-body oracle, each found while proving the R79
    reminder section.) (1) The first oracle searched the mock's recorded
    REQUEST bodies for the parent's REPLY text — but the reply is what
    the model GENERATES; what it receives is keyed by the turn's USER
    message, so the assertion never matched its own stage. (2) The
    "doomed child" mock answered 500 — and the R75 ladder correctly
    classified that as NETWORK-transient and auto-RETRIED it, so the
    "failed child" never stayed failed (fail-fast tests must use 400;
    the failure class is the test's contract with the runtime). (3)
    Dispatching parent-vs-child by the LAST message broke the moment the
    child's history carried tool results (a tool-looping child's last
    message is a tool result, not the framing) — and the mock could not
    decide how many times to fail, because the failure-streak length is
    the RUNTIME's decision, not the mock's. RULE: for a model-facing
    oracle, search the recorded request bodies by a marker you PUT in
    the turn's user message; dispatch on the RAW body (history carries
    the framing, and tool loops end with tool results); make the mock
    fail with the HTTP class you mean (400 fail-fast vs 500 transient),
    and when the scenario needs "it keeps failing until X", latch it in
    the mock (a `{failForever}` flag the test clears at the pivot), never
    a counted script.

82. **An interrupted agent's tree is a CLAIM, not a state — verify it
    line-by-line before building on it, and expect the missing half to
    be the unglamorous half.** (2026-09-08, round-79; the R79-a backend
    sub-agent died mid-flight.) The agent's handoff said the work was
    mostly done — and the line-by-line review found exactly that: the
    implementation was real and correct (kept, typecheck green, the
    existing 1742 tests green). What was entirely MISSING was everything
    that makes it verified: no new tests, no battery, nothing. The
    interrupted agent had spent its whole budget on the code and none on
    the proof — the completion claim was true of the IMPLEMENTATION and
    false of the ROUND. RULE: after any mid-flight death, inventory the
    claim against the round's definition of done (implementation, tests,
    live battery, docs) and re-run the gates yourself before reusing so
    much as one function; the surviving code is a gift, the missing
    verification is your job, and "the agent said it was done" is a
    hypothesis, not evidence (see #76 — the same rule from the other
    side: there the drift was a stamp; here it was the entire proof).

83. **A mock that models an unfaithful wire teaches the wrong behavior —
    when a guard is added against a real-world failure shape, every
    pre-existing mock of that surface becomes a false witness; fix the
    MOCK to model the real wire, not the guard to tolerate the mock.**
    (2026-09-09, round-80; the A1 truncation guard.) The R80 guard
    flags "content streamed but zero finish-step parts" as the
    clean-close silent stop — and the r58/r78 route-test mocks, written
    years-of-rounds earlier without finish-step parts, were EXACTLY
    that shape. Twenty tests failed: some as honest assertion misses,
    but the route tests as 30-second HANGS (the guard's error
    classifies as `network` → the retry ladder → the 90s rung → the
    SSE stays open → the test times out waiting for a done frame).
    The wrong fix is a `allowMissingFinishStep` escape hatch; the
    right fix is the mock learning what a healthy provider actually
    sends (a finish-step part per step — the chat-completions
    finish_reason the SDK maps). RULE: when a guard exists to catch a
    REAL wire pathology, the test mocks of that wire must model the
    healthy real wire in full — otherwise the suite pins the pathology
    as the contract. Corollary: a NEW guard's blast radius includes
    every stale mock of its surface; budget time to update them the
    same round, and when a test times out after adding error-path
    retry logic, suspect a RETRY WAIT (the ladder's long rung), not a
    deadlock — read which class the new error maps to before touching
    the loop code.

84. **A stamp-only cohort refresh over-claims freshness — when the round
    changed the world a doc describes, the stamp bump must come with a
    content check.** (2026-09-10, round-85; the docs-truth audit.) The
    R84 close-out bumped ~12 docs' `last-reviewed` stamps to round-84 as
    first-line-only diffs (legal per DOC-STANDARDS §8's cohort rule) —
    but R84 had SPLIT server.ts and KILLED the import cycle, and the
    stamped docs still described the pre-split world: MODULE-BOUNDARIES
    §3 told agents to add routes in server.ts ("do not preemptively
    create routes/"), §4 presented the dead cycle as current, MAINTENANCE
    §e carried the same wrong recipe, and the stamp made them look
    fresh. A low-context agent following the normative contract would
    have edited the wrong file. RULE: the stamp ceremony has two cases —
    (a) pure aging (content still true): bump freely; (b) the round
    changed the structures the doc describes: the stamp bump REQUIRES a
    content verification pass over the affected sections in the same
    commit. When a structural round lands, list every doc that names the
    changed files/structures and check those references before stamping.

85. **A verification claim is only as good as its scope — state the
    scope IN the claim, and make the check re-runnable.** (2026-09-10,
    round-85; the "zero cyclic SCCs" correction.) R84 claimed "a Tarjan
    check over the runtime import graph reports ZERO cyclic SCCs" — but
    the check ran over 90 files while the tree had 104, and it excluded
    the one edge class that mattered (the value-import `TOOL_NAME_RE`
    edge `tools/registry.ts` ↔ `tools/plugins/mcp.ts`, present since
    R61). The claim survived its own round's review because the scope
    was implicit; the R85 re-run with full scope found the counter-
    example in minutes. The same round's "392-line SSE route" and
    "~31 remaining routes" figures were stale counts nobody re-measured.
    RULE: verification claims name their exact scope (file count,
    inclusion/exclusion rules, the command) so a successor can re-run
    them verbatim; a "zero X" claim is a prediction about the FULL
    scope, not the tested one. Cheap corollary: re-measure line/route
    counts at commit time instead of carrying forward figures from
    earlier rounds.

86. **After a verbatim block move, prune imports from a USAGE COUNT,
    never from the moved block's dependency list.** (2026-09-10, round-86;
    the approvals.js near-miss.) The R86 SSE-route extraction pruned
    server.ts's imports by walking the moved route's dependencies — and the
    first pass deleted `./approvals.js` on the false memory that the
    approvals routes belonged to the moved block (they are 51 routes that
    REMAIN in server.ts). The diff was read BEFORE any gate ran, the import
    restored, and nothing ever went red. RULE: after any extraction, for
    each import in the source file run a use-count over the file EXCLUDING
    the moved lines (`awk` range + `grep -c`), and prune only the symbols
    whose count drops to their import statement. A moved block tells you
    what it NEEDS — it tells you nothing about what the REMAINDER still
    needs.

### Lesson #87 — components defined inside render remount per keystroke; pins written before the behavior exists go stale silently
**Two discipline notes from R87.** (1) `CapChip` was first defined INSIDE
`ModelConfigDialog` (copying the old `Toggle`/`TriStateToggle` pattern) — a
component function created during render is a NEW TYPE on every re-render,
so React unmounts and remounts its whole subtree on every keystroke that
touches the draft: test-held element references go stale (the chip's
`aria-pressed` read `false` right after a click — the clicked DOM node was
replaced), and real users lose focus/state on every draft change. RULE:
interactive subcomponents always live at MODULE level (they can call
`useThemeStyles()` themselves); defining them inside a component is reserved
for truly static decoration. (2) A sub-agent had updated the
`ModelsProvidersTab.test.tsx` fixture to expect the six NEW capability
fields in the dialog's PATCH body while the dialog itself still sent the
old shape — the test went red AFTER the fixture change but BEFORE the
behavior change, and because the two landed in different workstreams the
failure looked like a "pre-existing flake" to the layout sub-agent (it
correctly quarantined it as out-of-scope, but a less careful agent would
have "fixed" it by reverting the fixture). RULE: when a test pin is updated
for a behavior that is being implemented in the SAME round by another
workstream, the fixture change and the behavior change must land in the
SAME commit — or the fixture change waits. (2026-09-11, round-87.)

### Lesson #88 — every DB-opening test closes its handles per test (the Windows EPERM)

The R87 suites opened a fresh SQLite db + fastify app per `beforeEach` and
never closed either — every test PASSED, and on Linux the suite was green
(all the way through the R87 local verification). On windows-latest the
afterAll `rmSync(tempDir, {recursive, force})` hit EPERM: Windows refuses to
delete a directory containing an OPEN file, and SQLite keeps the .db open
until `db.close()`. The CI failure surfaced as 2 file-level failures AFTER
2,803 passing tests — the worst kind of signal (green tests, red suite, and
only on the OTHER platform). The rule: any test that calls `openDatabase`
follows the standing pattern (approval-flow / browser-tool) — `afterEach`:
`await app.close(); db.close();` — and a test that REASSIGNS the app
mid-test closes the old instance first (an orphaned app holds the same
handles even though nothing references it). The rmSync's own
`maxRetries`/`retryDelay` covers the residual ephemeral-lock class but is
NOT a substitute for closing: the handle is the cause, not the timing.
(2026-09-11, round-87's close-out fix — diagnosed from run 34579011412's
log: `EPERM, Permission denied` at the afterAll line, both new files, zero
code-level test failures.)

# 91
- A compile-clean Rust command can still be a Windows deadlock: `WebviewWindowBuilder::build` inside a SYNC command is tauri's documented hang (the cargo check verifies types, never threading). Every new shell command that creates a window must be `async fn` — and the BrowserPanel now carries a watchdog so the browser's visibility is self-healing even if a new path slips through (R91-B).
- A delete that "does nothing" may be an honest 409 the UI never taught you to read: before hunting a bug in the DELETE, check what references the row (the seeded default agent blocked OpenRouter deletes for three rounds of owner reports). Force-paths belong at the API with the plain-409 default kept for other callers (R91-A).
- Tests that pin a UI's disabled-state often hide the real ask: the owner read the always-rendered disabled queue button as "a second send button doing nothing." Ask whether the affordance should EXIST in that state, not just whether it is enabled (R91-F).

# 92
- A reset that creates a state no mainstream flow ever produced is a compatibility test for EVERY reader of that state: R91-A's NULL agent broke two latent consumers in one round (prepareTurn's pre-override 409 gate, the agents form's `.trim()` on a null string). When you add a writer of NULL/empty states, grep for every reader of the field and check each against the new state — the type system only catches it if the TYPES tell the truth (the shared AgentRecord claimed `string` while the backend served `string | null` for 91 rounds).
- A dispatch timeout is not a work failure: both implementation waves completed after the orchestrator's context deadline — verify the tree (typecheck + the focused suites) before re-dispatching, then finish the interrupted tail yourself. The interrupted agents left: un-pinned tests (3 files), an un-wired frontend consumer of a new backend frame (meta.key), and a flaky teardown leak. Budget close-out time for exactly that tail.
- "The browser feels like an overlay" was a LAYERING vocabulary problem, not a bug list: every DOM layer that can geometrically touch the native webview must either ride above it (the overlay window) or be exempt with a reason (backdrops render BELOW it). Writing the rule down (popover-webview-guard's header) ended a three-round whack-a-mole.
- Key-pool failover belongs BEFORE the retry ladder with delay 0, and only for key-ATTRIBUTABLE classes (auth, rate_limit): network/timeout errors are not the key's fault, and waiting before trying a healthy key punishes the user twice.

# 93
- vitest resolves the TS SOURCE graph; the shipped sidecar is compiled ESM — an extension-less relative import (`from "./types"`) passes tsc, passes every unit suite, and kills the built artifact at Node ESM runtime (ERR_MODULE_NOT_FOUND at boot). The e2e suite (black-box against `agent-core/dist`) is the ONLY local gate that boots the built thing — never close a round that touched agent-core's import graph without it. The R93 catch: element-map.ts crashed the sidecar invisibly to 3,011 green unit tests.
- A "degrades honestly" probe can be 100% INERT and still look alive in tests: `$el.PSObject.Methods['GetPropertyValue']` is always non-null on a managed AutomationElement, but `$m.Invoke(<int>)` can never bind int→AutomationProperty — every call threw into the catch and returned $null, so three whole clickability layers shipped as zero (script-content tests only proved the calls were PRESENT, not that they could FIRE). Layered detection needs a pin per layer's success path — or the honest deletion. When the only real path is another API face (COM IUIAutomation vs the managed bridge), document the absence instead of shipping dead scaffolding.
- A literal NUL byte inside a template literal compiles, tests green, and makes the file BINARY-opaque: grep refuses it, `git diff` prints "binary files differ", review tooling sees nothing. Write `\u0000` escapes — the runtime string is identical and the source stays reviewable text (the R93 element-map identity separator).
- powershell.exe 5.1 decodes a BOM-less .ps1 as ANSI: any -File transport carrying non-ASCII (the walk's "›" breadcrumb separator) must be written UTF-8 WITH BOM (`"\uFEFF" + script`). -EncodedCommand is immune (UTF-16LE base64) — the ceiling-driven switch to -File quietly introduced the mojibake class.
- "Pre-existing" claims must be verified against the TAG, not the inherited tree: a sub-agent called the `react-hooks/exhaustive-deps` disable-comment lint error "pre-existing at line 1994" — `git archive v0.90.0` proved the comment (and the error) were born in THIS round's own commit. Mid-round trees carry your own unstaged history; only the tag tells the truth.

# 94
- Before ANY repository-visibility flip, scan the WHOLE HISTORY (every blob, every credential shape), not the working tree: the R44 launcher's "baked-in defaults" (real OpenRouter keys) had been scrubbed from the TREES in R47 but lived in history ~50 rounds — `git filter-repo --replace-text` purged them the day the repo went PUBLIC. A tree-only grep would have leaked them the moment the repo flipped.
- A private repo going PUBLIC exposes three classes beyond obvious secrets: (1) commit-author EMAILS — rewrite to the GitHub noreply form (`{user_id}+{login}@users.noreply.github.com`) via `--email-callback`; (2) shared-secret strings quoted in docs (the ntfy topic — anyone who reads it can read/spam the feed); (3) synthetic fixtures that reuse a real secret's OPENING SEGMENT (harmless to authenticate with, but GitHub secret-scanning flags the shape and mails the owner). All three were caught and purged in the R93 flip.
- An Actions run that "completes" instantly with zero steps, empty logs, and `runner_id: 0` is NOT a code failure — it is runner provisioning. On this account it meant the monthly private-repo Actions minutes were exhausted (windows-latest bills 2×). The bisect that proved it: identical probe jobs got runners in the PUBLIC DASHBOARD repo and none in the PRIVATE ACUTE-CODE repo. The owner's remedy: the repository is PUBLIC (unlimited free standard-runner minutes; flippable back — the docs are written for both states).
- Pushing more than three tags at once suppresses ALL tag push events (documented GitHub behavior): a bulk `--tags` force-push fires NO workflows. Delete and re-push the release tag ALONE to trigger the Release workflow.
- Tool-output hygiene for the agent itself: display layers can redact `github_pat_*` shapes and eat `[m`-style sequences — never trust what a grep LOOKS like; verify secrets by computed length + prefix equality + full-blob byte scans (the R93 audit's false comfort: line 306 "looked" clean in output).

# 95
- The in-app updater's asset-URL allowlist and the asset-picking code are ONE contract that no test pinned end-to-end: findInstallerAsset returned browser_download_url (github.com) while the download route accepted only the API/CDN hosts — every real update died with the owner's literal error while every mocked test passed because the MOCK used the accepted shape. When a gate validates a URL/host, pin the ACTUAL producer's output shape in the same test.
- A task-timeout'd subagent is not a failed subagent: all four context-deadline casualties of R94 had left complete work in the tree. The protocol that worked: `git status --short` → diff-stat per owned area → run the area's focused suite → finish the interrupted tail (un-pinned tests, unwired consumers) yourself. Budget close-out time for exactly that tail, and verify BEFORE re-dispatching.
- vitest fake timers advance the CLOCK before flushing the turn's microtasks: a retry wait registered mid-flush lands its deadline PAST the window you already advanced — `advanceTimersByTimeAsync(N)` can leave the very timer it was supposed to fire pending. Two advances (or runAllTimersAsync) when the wait is registered inside the flush. Symptom signature: the test hangs exactly one wait-long, and `vi.getTimerCount()` > 0 after the advance.
- A unit-tested mechanism can still miss its real integration seam: the mid-turn queue injection passed every r78-queue test because the fake chatStream yields tool-result events directly — but the LIVE wire only produced them because the agent's toolset existed. The live-fire caught it: a PROJECTLESS session resolves NO tools (tool calls error, no tool-result parts, no boundaries). When a feature hangs on a part the adapters map from the SDK, prove it against the real wire (scripts/r94-live-fire.mjs is the template: a local OpenAI-compatible SSE provider + the BUILT sidecar).
- When EVERYTHING in a failure report cascades from one diagnostic sentinel (enumWindowsCount:-1, foregroundPid:0, active:false, "owns no accessible top-level window"), find the ONE root before fixing symptoms — it was the U32 Add-Type compile dying on the owner's machine all along. The fix was a no-csc fallback layer (LoadWithPartialName UIAutomation needs no compiler), not five patches.

### Lesson #96 — a capability knob the provider exposes is not a knob the provider accepts TOGETHER with its sibling

R95-E shipped reasoning.effort + reasoning.max_tokens in one body because
the OpenRouter catalog advertises BOTH (supported_parameters lists
"reasoning"; three models also carry supported_efforts; supports_max_tokens
appears as its own flag) — every unit test passed because the MOCKED
provider accepted every shape. The REAL API answered "Only one of
reasoning.effort and reasoning.max_tokens can be specified" the first time
the two rode together. RULE: when a feature composes TWO knobs from one
provider capability surface, the combination matrix needs either a
documented spec citation or a live-fire leg that exercises the COMBINED
shape — a mock that echoes success proves nothing about the pair's
validity. (The R95 fix: mutual exclusion by design — the ladder gets
effort, ladder-less reasoning gets the budget; the constraint is now
pinned in the test suite AND taught in the code comment where the next
agent will look first.)

### Lesson #97 — a guard fed a lossy DISPLAY summary false-positives on every argument the summary drops; and a guard that stops work must prove the work is actually stuck

Two rules from R96-B, both bought with the owner's patience across THREE
rounds of "the thinking/loop guard is still not proper":

1. **IDENTITY INPUTS ≠ DISPLAY INPUTS.** The R51 loop guard compared
`argsSummary` — a display string `summarizeArgs` builds by keeping ONLY
string args ("content: 120 chars", "path: x"). It silently DROPS every
numeric and nested arg, so `read_file {path, offset: 1, limit: 5000}` and
`{path, offset: 5000, limit: 5000}` produced IDENTICAL summaries — and the
guard stopped the owner's healthy paged read at the 5th "identical" call.
The code even KNEW ("a rare false-positive that only ever produces a
nudge/stop… the honest fix (threading raw args) belongs to a future
chat.ts round") — the hedge became a three-round owner bug. RULE: any
detector that decides "same" vs "different" must consume the RAW input
(canonicalized), never a rendering built for humans; if you must ship the
lossy version, the comment's "future round" needs a follow-up line item,
not just a note.

2. **A HARD STOP is a product decision the owner must own.** We built the
stop because the R51 owner asked for step efficiency; the v0.93 owner
reversed it flat ("The loop guard should not be one that will stop but it
will only warn the user and it will pass the generation, pass the
workflow"). The asymmetry: a false NEGATIVE (a real loop runs 20 extra
calls) costs tokens; a false POSITIVE (healthy work stopped, "Generation
failed" over finished work) costs TRUST — and the caps (maxTurns /
maxOuterLoops / request guards) already bound the worst case. RULE: guards
that interrupt user-visible work default to WARN + nudge; hard stops
belong to true resource caps with honest cap messages, and the escalation
from warn to stop needs the owner's explicit signature.
(2026-09-13, round-96; the paged-read false positive + the
identical-text detector + the warn-only rewrite.)

### Lesson #98 — a UI test that asserts at FIRST PAINT is a latent race; and a shipped control that does nothing is a dead setting wearing a button

1. **The synchronous-assert race.** R97-I made the chat render a skeleton
   until the session queries settle (the false greeting killed). TEN tests
   broke — none of them wrong about the behavior they meant to pin: Composer,
   ChatFocusLayout, and the layout contract all asserted the greeting or
   the composer SYNCHRONOUSLY after `renderWithProviders`, which had always
   worked only because the fixture backends resolved before the first
   assert. RULE: any test that asserts on data-driven UI must await a READY
   marker (`waitFor(() => expect(document.querySelector("[data-empty-state]")))`
   or the element itself) — the first paint is a loading state now, and
   adding a loading state to ANY surface retroactively races every
   first-paint assert in the repo.
2. **The dead control.** R97-G shipped the browser HOME button with a
   Settings section around it — and the review pass found it was a NO-OP in
   native mode (the webview painted over the home screen's DOM) and a
   ≤4-second flash in web mode (the poll re-adopted the page we left). The
   section LOOKED complete: the setting existed, the button rendered, the
   tests passed. RULE: "no dead settings" means the CONTROL must be verified
   end-to-end against the state machine that fights it (here: the 4s poll's
   re-adopt + the native webview's Z-order), not just against the store it
   writes. A control whose effect can be silently undone by a background
   process needs that process named in its test.
(2026-09-14, round-97; the state-awareness sweep's ten re-pins + the
review's M1.)

#99 (2026-09-15, R98): A sandbox reset lost EIGHT unpushed commits — the
only durable store is the REMOTE. Push after every verified workstream
commit; never batch pushes to "release time". Corollaries proven across
three further shutdowns: (a) killed agents leave no worklog entry but their
uncommitted diffs LAND — the worktree state is the truth, wait + inspect
before re-dispatching; (b) have agents append their worklog record BEFORE
their final long suites so a cut can't lose it; (c) connection death ≠
agent death. Also: verify the ROOT tsconfig (it includes agent-core/tests —
agent-core's own tsc passing does NOT mean the shared gate passes; an
unused const in a test file fails the root gate).

#100 (2026-09-15, R99): Three Tauri/CI traps and one tooling trap. (a) The
`webviewInstallMode` serde tag field is `type`, NOT `mode` — tauri-build
fails at cargo check with `missing field 'type'` (read the enum's serde
attribute before writing config). (b) tauri-build validates EVERY
`bundle.resources` path at COMPILE time — a CI-staged, gitignored resource
dir needs a committed placeholder (the staging/sidecar/README.md pattern:
`dir/*` ignore + `!dir/README.md`) or plain cargo check fails on clean
checkouts. (c) The audit/terminal output pipeline EATS literal `[m`
sequences (ANSI-reset artifacts) — "[math]::Round corrupted" and
"max-w-[min(75%,640px)] broken" were display illusions; hex-dump (od/python
bytes) BEFORE believing a file is corrupted. (d) Disk exhaustion (18k
test-temp dirs, 6.9 GB in /tmp) produces mass ENOSPC test failures that
mimic code breakage — check `df -h` before diagnosing a sudden suite-wide
failure. Also proven again at scale: killed subagents' diffs land in the
worktree — verify + complete + re-pin from the tree (7 of 8 workstreams
this round).

#101 (2026-09-17, R100): Three lessons. (a) The research-first method
paID off twice: both reports (the browser trilemma, the UI design
language) drove the workstreams AND became the durable record — when the
owner asks "why not engine X", the answer is a measured document, not a
hunch. (b) The subagent FINAL-REPORT death pattern: 6 of 8 implementation
agents died at their last LLM call (context deadline) — every one AFTER
landing its full diff. The work always lands; the completion protocol
(orchestrator verifies the tail, re-pins, appends worklog, commits) is
routine. SIZE THE CONTRACT: agents scoped to one screen/subsystem
survived whole; "a wave" died at the report. (c) The audit-gate ratchet
is the round's structural gift: a cleanup that CANNOT regress (counts
may only go down, enforced in verify + CI). Corollary: a live-fire
battery on REAL provider turns is the only test that catches
classification gaps — "Invalid JSON response" sailed through 2,384 green
unit tests because no fixture ever emitted that exact string; the
battery's one transient glitch exposed a fail-fast dead end that
unit-land could not see.

#102 (2026-09-17, R101): Three lessons. (a) A deliberate kill must be
ANNOUNCED: the R96-I pre-install kill was correct engineering, but every
watcher of the killed process (the 20s watchdog, the connect loop, every
in-flight query) reached the honest conclusion "it crashed" because nobody
told them the death was planned. The `update-installing` event + the
`updateInFlight` suppression flag is the general pattern — coordinated
shutdowns need a BROADCAST, not just an ordering. Verify lifecycle
hand-offs by what the USER SEES at every second, not just the end state
(the NSIS `/R` relaunch worked all along; the 7 seconds around it told the
owner a crash story). (b) A silent `catch {}` is a defect AMPLIFIER:
mermaid never "failed" — it degraded silently through four different
defects, three producing zero diagnostics. Surfaced errors would have made
the owner's report one line instead of a guess. When wrapping third-party
renderers: log the error, surface its message, retry once (import AND
render, with a fresh id), and gate the build on the chunk actually
shipping. (c) The rail overflow gotcha: CSS-only hover chips on a 48px
icon rail require the container to let them paint PAST the column —
`overflow-x-visible` pairs only with `overflow-y-clip` (the CSS axis
constraint; `overflow-hidden` on the aside would swallow every chip). When
a label chip "doesn't appear", audit the overflow geometry of every
ancestor first.

#102-addendum (2026-09-17, R101 hotfixes, same day): (d) A VERSION BUMP IS
A CODE CHANGE — the r89-updates test's hardcoded "future" tag pin (v0.99.0,
set two rounds earlier) aged out the exact moment the engine reached
0.99.0, and the fast gates (lint/typecheck/docs/audit) were all green while
the suite flipped. After version:set, RUN THE SUITE before tagging. Tests
that mock "a newer release" must derive the version live (patch+1 from the
manifest — the r89 NEWER_VERSION helper), never hardcode it. (e) The Linux
arch-naming asymmetry, learned from the first real ARM64 run: dpkg names
the arch `arm64`, the AppImage/Rust triple names it `aarch64` — the same
release carries `_arm64.deb` + `_aarch64.AppImage`, and any pipeline that
expects one spelling for both formats fails loudly (which is the design:
the verify step caught it before publication).

#103 (2026-09-17, round 102 — the Linux key store made real): (a) A FALLBACK
NOBODY CAN USE IS NOT HONESTY. ADR-0031's round-100 "honest fallback" for
Linux machines without a Secret Service (error + point at the
ACUTE_PROVIDER_<ID> env vars) was honest about the limit and useless to a
desktop-app owner — his report was "nothing was happening at all." The fix
stored the key SOMEWHERE (a disclosed 0600 key file, amber UI note, path +
migration instructions) instead of refusing. When a SPEC hard rule collides
with the product's core promise on some machine class, the answer is a
DOCUMENTED, DISCLOSED exception that preserves the rule's intent — never a
dead end, and never a silent bend. (b) "CANNOT COMPILE THE PLATFORM"
usually means "cannot compile the FULL APP," which is not the same claim:
the risky new Linux code needed only keyring + libdbus + a stub keys
module, so a throwaway #[path]-include crate compiled the REAL wincred.rs
natively on the sandbox (which IS Linux), with the libdbus dev files
relocated into a user-local pkg-config prefix (no sudo). That harness
CAUGHT the PlatformFailure-vs-NoStorageAccess classification defect that
reading the docs never would have — keyring's sync-secret-service maps
"cannot connect to the bus" to PlatformFailure, so code keyed on
NoStorageAccess alone errors on every keyless read. Prefer a scoped
harness over no verification; the R100 write-off was too hasty. (c) SYNC
TAURI COMMANDS RUN ON THE MAIN THREAD: any command touching an OS API with
unbounded latency (D-Bus, keyrings, shells) must be `async` AND wrap the
call in a bounded worker thread (the 20s mpsc deadline pattern in
wincred::imp::bounded). The owner's frozen-app report was not a keyring
bug — it was our command shape. (d) THE OWNER'S "handle it just like how
it was handled previously" IS A SPEC: R100-E1 retired the ROUND-34
settings sidebar to satisfy a research pattern (VS Code's settings-local
nav), and the owner rejected the doubled-sidebar result outright. Research
patterns inform; the owner's lived preference decides. Restorations are
cheap when the history is in git — `git show <old-round>:<file>` is the
reference implementation. Also: one shared module (settings-sections.ts)
beats two synced lists — the R44 id-sync discipline now holds by
construction.
