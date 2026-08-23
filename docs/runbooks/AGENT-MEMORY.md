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
