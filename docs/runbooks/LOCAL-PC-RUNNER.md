<!-- last-reviewed: 2026-09-11 round-87 -->
# LOCAL PC RUNNER — one double-click, everything handled

**Owner round-11 redesign (2026-08-23):** the round-10 pure-`.bat` approach
failed on Windows (a `.bat` written from Linux shipped with LF line endings —
cmd.exe disintegrates: `'cho' is not recognized…`). Redesigned per owner
direction: a tiny CRLF-safe `ACUTE.bat` coordinator plus a Python workhorse
with a rich terminal UI.

## The launcher (canonical owner path)

Lives in **`launcher/`** in this repo:

| File | Role |
|---|---|
| `launcher/ACUTE.bat` | the double-click entry (Windows). Tiny coordinator: finds Python (`py -3` → `python`), offers to install Python via winget if absent, then runs the workhorse. **Written with explicit CRLF line endings** (verified) — regenerate the same way if ever edited. |
| `launcher/acute.sh` | the same entry for Linux/macOS (`bash acute.sh`) |
| `launcher/acute_launcher.py` | the workhorse (~800 lines, stdlib-only baseline): rich terminal UI (panels, spinners, status tables — `rich` auto-installed with consent, clean plain-text fallback if unavailable), toolchain check with **winget auto-install** (git / Node.js missing or old), pnpm via corepack into `.acute/bin` (no global installs), **`credentials.txt` reading**, first-run clone, update-with-server-restart, dependency install, backend build, `.env.development`, OpenRouter key distribution (Windows Credential Manager via `scripts/credential.ps1`; `~/.acute/openrouter.key` on Linux), **launcher self-update** from the repo, port pre-flight, launch `pnpm dev:full` with the key injected, boxed copyable errors that keep the window open |
| `launcher/credentials.example.txt` | template the owner renames to `credentials.txt` and fills (`GITHUB_PAT`, `OPENROUTER_KEY`); local-only file, never uploaded; placeholder values are detected and rejected |
| `launcher/README.md` | owner-facing first-time setup instructions (also printed by the launcher when `credentials.txt` is missing) |

**Folder layout on the owner's PC after first run** (his explicit design):

```
C:\ACUTE\
├── ACUTE.bat            ← double-clicked
├── acute_launcher.py    ← the workhorse
├── credentials.txt      ← his secrets (local only)
├── ACUTE-CODE\          ← the app (cloned; updates itself; .dev\acute.db persists)
└── .acute\              ← isolated git credentials (0600), pnpm shims, launcher.log
```

Auth design (round-12, after the owner-reported Windows failure): every git
command runs with **HOME → `.acute/`** + `GIT_CONFIG_NOSYSTEM=1` + the
single-word `store` helper reading `.acute/.git-credentials` (URL-line
format, 0600). No quoted paths in helper config (that broke the clone on
Windows via MSYS sh — memory lesson #21), **the owner's global git config is
never touched**, the GCM popup can never hijack auth, and the token is
pre-validated against the GitHub API for precise invalid-token errors.

Commands: default = update + launch · `status` = read-only report ·
`update` = update only · `start` = launch without update check. Flags:
`--no-update`, `--verbose`, `--no-pause` (automation), `--no-rich-install`.

## Verification performed (Linux sandbox, 2026-08-23)

- No `credentials.txt` → setup-instructions panel, exit 1
- Placeholder credentials → rejected with clear message
- Full first run in a scratch folder: clone (silent auth, no prompt) →
  install → build → `.env` → key file → clean exit in 8s
- Behind-origin run (repo reset 1 commit back): update detected, pulled
  `8d504b8 → fe38f41`, reinstalled, rebuilt
- `status` mode: rich panel with versions/commit/credential-lengths/ports/log
- `start` mode: sidecar health `{"status":"ok"}` + UI HTTP 200 in 4s,
  provider key `●` end-to-end, clean teardown
- Failure path (servers killed underneath): red FAILED panel + log path +
  clean exit; window kept open (in tty mode)
- `ACUTE.bat` byte-verified CRLF (`file` → "DOS batch file … with CRLF line
  terminators"); `acute.sh` + `py_compile` clean

## Advanced: the Node runner (round-10, still maintained)

`scripts/acute-desktop.mjs` (run via `node scripts/acute-desktop.mjs`) is the
headless/terminal alternative — same lifecycle (toolchain, update, install,
build, key, launch) without the rich UI. Useful from inside an existing clone
or in automation. Documented in git history (round-10); the Python launcher
above is the canonical owner-facing path.

## Data persistence

| Data | Location |
|---|---|
| Agents, sessions, projects, usage | `ACUTE-CODE/.dev/acute.db` (gitignored; untouched by updates) |
| GitHub PAT / OpenRouter key | `credentials.txt` (+ Windows Credential Manager / `~/.acute/openrouter.key`) |
| Isolated git credentials | `.acute/git-credentials` (0600) |
| Browser wiring | `ACUTE-CODE/.env.development` (write-once) |
| UI preferences | browser localStorage |
| Launcher log | `.acute/launcher.log` |

## Scope

Runs the **dev stack** (console + browser at http://localhost:5173). The
packaged single-`.exe` is a later milestone (ADR-0003) and will slot into the
same launcher flow.
