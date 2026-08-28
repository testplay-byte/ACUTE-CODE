<!-- last-reviewed: 2026-08-28 round-46 -->
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
    the `<!-- last-reviewed: YYYY-MM-DD round-NN -->` stamp. Existing docs
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
