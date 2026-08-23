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
