# LOCAL PC RUNNER — one file, double-click, done

**Owner round-10 request (2026-08-23):** "I select a folder on my PC, put one
file in it, double-click it, and it sets everything up, keeps itself updated,
restarts the servers, keeps my credentials/sessions, shows progress, and shows
me copyable errors instead of closing the window."

This runbook documents that system exactly as built.

## The two layers

| File | Where it lives | What it does |
|---|---|---|
| **`ACUTE.bat`** (Windows) / **`acute.sh`** (Linux/macOS) | any folder YOU choose — copy it out of the repo (GitHub web UI → open the file → Raw → copy → save as `ACUTE.bat`) or double-click it inside an existing clone | checks git + Node are installed, clones the private repo ONCE (asking for your GitHub username + PAT a single time — stored safely by the OS credential store), then hands off to the runner |
| **`scripts/acute-desktop.mjs`** | inside the repo (delivered by the clone) | everything else: toolchain, updates, installs, builds, credentials, server lifecycle, error reporting |

Both are idempotent: double-clicking the same file again never re-does
completed work.

## First run (what you will see)

1. Git asks for credentials **once**: username `testplay-byte`, password =
   your GitHub PAT. Stored via Windows Credential Manager (wincred) — never
   retyped, never written into the repo.
2. The runner checks Node ≥ 20, git, and activates **pnpm** automatically via
   corepack (the exact version pinned in `package.json` — no global installs,
   no admin rights).
3. Dependencies install (first time only — a few minutes), `shared` +
   `agent-core` build.
4. `.env.development` is written (browser wiring; gitignored, persists).
5. OpenRouter key: on Windows you're offered a one-time prompt to store it in
   Windows Credential Manager (`ACUTE-CODE/provider/openrouter`). Declining is
   fine — the app runs; live model calls need the key. On Linux it is read
   from the `ACUTE_PROVIDER_OPENROUTER` env var or `~/.acute/openrouter.key`
   (chmod 600).
6. Servers start: sidecar `127.0.0.1:5178` + UI `http://localhost:5173`.
   Open the URL in your browser. Keep the window open while using the app;
   **Ctrl+C in the window stops both servers cleanly**.

## Every later run (update + restart)

1. Update check against `origin/main`:
   - **behind** → any running ACUTE servers on :5173/:5178 are stopped
     automatically → `git pull --ff-only` → `pnpm install` → backend rebuild →
     servers start on the new version.
   - **up to date** → straight to launch (seconds).
   - **offline** → warning, continues on the local version.
   - **local modifications** in the repo folder → update is skipped with a
     warning (never destroys your changes).
2. Ports are pre-flighted: leftovers from a crashed previous run are killed
   before launch.

## What persists where (survives every update)

| Data | Location |
|---|---|
| Agents, sessions, projects, usage (SQLite) | `<repo>/.dev/acute.db` (gitignored, untouched by `git pull`) |
| GitHub PAT | Windows Credential Manager (wincred) / `~/.acute-git-credentials` (600) |
| OpenRouter key | Windows Credential Manager `ACUTE-CODE/provider/openrouter` / env var / `~/.acute/openrouter.key` |
| Browser wiring | `<repo>/.env.development` (kept as-is once written) |
| UI preferences (theme, panel sizes…) | browser localStorage |
| Runner log | `<repo>/acute-runner.log` (auto-rotates at 2 MB) |

## When something goes wrong

- The runner prints a **boxed error** with the failing step, the captured
  output, and the log path — and the window **stays open** (press Enter to
  close) so you can copy everything.
- Everything is also in `acute-runner.log` inside the ACUTE-CODE folder.
- Common fixes:
  - *git clone/pull auth fails* → the PAT was rejected; regenerate it on
    GitHub and update Credential Manager (Windows: Control Panel → Credential
    Manager → Windows Credentials → `git:https://github.com`) — or just delete
    that entry and the next run re-prompts.
  - *Port stuck busy* → the runner already auto-kills :5173/:5178; if Windows
    still complains, reboot or `netstat -ano | findstr :5173` →
    `taskkill /F /PID <pid>`.
  - *Build failed* → the log has the full compiler output; re-run the
    launcher (idempotent) after fixing (e.g. disk full, antivirus lock).

## Commands (optional, for terminals)

```
ACUTE.bat                 → update + launch (the default double-click)
ACUTE.bat update          → update only, then exit
ACUTE.bat start           → launch without the update pass
ACUTE.bat status          → versions, commit, ports, key, DB — read-only
ACUTE.bat -- --verbose    → stream all sub-command output live
```

(On Linux/macOS: `bash acute.sh <same args>`. `ACUTE_RUNNER_NO_PAUSE=1`
skips the keep-window-open waits — used by automation.)

## Scope note (honest)

This runs the **dev stack** (Vite UI + Node sidecar in a console window) —
not yet a packaged `.exe`. The portable single-exe build is a later milestone
(ADR-0003); until then this runner is the supported way to run ACUTE-CODE on
your PC. The runner will keep working unchanged when packaging lands.
