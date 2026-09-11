# ACUTE-CODE — one-click launcher (first-time setup)

You want ACUTE-CODE running on your PC by double-clicking ONE file. Here is
exactly how, start to finish.

## What you need (2 files, ~2 minutes)

Create a folder anywhere — e.g. `C:\ACUTE`. In it, put these two files
from **this GitHub repo, folder `launcher/`** (open the repo in your browser →
click into `launcher/` → click each file → **Raw** button → right-click →
*Save page as…* into your folder):

| File | What it is |
|---|---|
| `ACUTE.bat` | the file you double-click (tiny coordinator) |
| `acute_launcher.py` | the program that does all the work (rich terminal UI) |

> **Yes, both come from GitHub** — nothing is created by hand. Nothing in
> them needs editing.

## Your GitHub token (asked once, on first run)

The launcher needs a **GitHub token** (starts with `github_pat_`, read
access to the private repo) to download the app. On the first run it asks
for it interactively and saves it in your **USER HOME** at
`~/.acute/github.pat` (chmod 600 where supported) — later runs reuse it
silently. That is exactly where the app's *Check for updates* looks
(round-90 fix: it used to be saved next to the launcher, where the app
never found it; a pre-round-90 copy there is moved over automatically).
Prefer the environment? Set `ACUTE_GITHUB_PAT` (or `GITHUB_PAT`) instead
of the file — the launcher also hands the token to the app it starts,
so the in-app update check works even without the file.

**AI provider keys (OpenRouter, NVIDIA, …) are no longer read from any
file** — save them inside the app itself: **Settings → Models & Providers**.
The desktop app stores them in Windows Credential Manager.

## Double-click `ACUTE.bat`

What you'll see, in order:

1. A **rich terminal UI** with panels and progress — the launcher checks
   git, Node.js and pnpm. Anything missing is **installed automatically**
   (with your confirmation; pnpm needs no admin rights at all).
2. First run only: the private repository is downloaded into a subfolder
   **`ACUTE-CODE/`** next to the launcher — your folder stays clean:
   ```
   C:\ACUTE\
   ├── ACUTE.bat              ← you double-click this
   ├── acute_launcher.py      ← the workhorse
   ├── .acute-launch-pref.json ← your remembered launch choice (round 56)
   ├── ACUTE-CODE\            ← the app (downloaded, self-updating)
   └── .acute\                ← helper data (logs, downloads — R90-B1: the
                                token now lives in your home at ~\.acute\github.pat)
   ```
3. **The launch question (round 56)** — every run asks how you want to work:
   - **[1] Desktop app** (recommended): the packaged window with the embedded
     browser and the bundled agent backend
   - **[2] Site**: the local servers + your browser at `http://localhost:5173`

   Press **Enter** to keep your last choice (first run defaults to the
   desktop app). Your answer is remembered as the next default. Skip the
   question entirely with a command: **`ACUTE.bat app`** or
   **`ACUTE.bat site`**.
4. **Desktop mode** installs/updates the packaged app (round 51+): the
   launcher checks GitHub for the latest `ACUTE-CODE_x64-setup.exe`,
   downloads it (with a progress bar), installs it **silently — no admin
   prompt, no dialogs** (it lands in
   `C:\Users\<you>\AppData\Local\ACUTE-CODE`), and starts
   **`ACUTE-CODE.exe`** — a real app window with the embedded Chromium
   browser and the agent backend bundled inside. No browser tab, no servers
   to manage, nothing to type. Save your AI provider keys once in the app
   (**Settings → Models & Providers**) — the desktop app stores them in
   **Windows Credential Manager** and boots with them from then on.
5. Keep the launcher window open while using the app (Ctrl+C there just
   closes that window — the app keeps running in its own window).

> **If the desktop engine fails to come up**, the launcher shows the
> engine's log tail and asks what to do next: **[1] retry the desktop app**,
> **[2] use the SITE instead** (same app in your browser), or **[3] keep the
> desktop app** (its offline screen has Restart-engine + Copy diagnostics).
> You are never stuck with a dead engine and no way out. Any install
> failure likewise falls back to the site flow automatically.

### The site/browser flow (a choice, not a fallback)

Choose **[2] Site** at the launch question (or run **`ACUTE.bat site`** / add
`--web` / `--no-desktop`): dependencies install, the backend builds, the
   servers start, and **http://localhost:5173** opens in your browser (it
   opens by itself). Save your AI keys in the app (**Settings → Models &
   Providers**). Keep the window open while using the app; **Ctrl+C** in the
   window stops the servers cleanly. This is also the automatic fallback
   path when the desktop flow fails.

## Every later run

Just double-click `ACUTE.bat` again. It checks GitHub for new versions — if
there are any, it **updates the launcher (and immediately runs the new
version), stops the live servers, updates, rebuilds, and installs the newest
desktop app automatically** — then asks app-or-site and launches. Your
agents, sessions, projects and settings persist (the desktop app keeps them
in `%APPDATA%\acute-code\`, the dev flow in `ACUTE-CODE\.dev\`) and are
never touched by updates.

### How the DESKTOP app update is verified (round 63)

Nothing about the desktop update is assumed — three versions are checked
against the newest GitHub release on every app launch:

1. **the uninstall registry's** version (what the installer claims),
2. **the installed exe's real version on disk** (a PowerShell FileVersion
   probe — the registry can lie when a past silent install raced a closing
   app),
3. **the running engine's `/health` version** after launch (the engine
   reports the version it actually booted from).

If any of them disagree — a *hybrid install*, exactly the "updated but
nothing changed" failure — the launcher **deletes the app completely**
(NSIS uninstaller, folder residue, stale registry entries) and reinstalls
from a **sha256-verified** download, then verifies again. A stuck engine
version is flagged on the spot and self-heals on the very next run. Your
data (`%APPDATA%\acute-code`) is never touched by any of this.

Which release counts as "the newest"? The **numerically greatest** one
that carries a Windows installer — chosen by version, never by list
order: GitHub lists never-published drafts ABOVE published releases, and
trusting that order once froze the app at 0.67.0 while 0.73.0 was live
(round 74). Drafts are included on purpose — your PAT can see them, so a
freshly built release reaches you on the very next double-click,
published or not; the version panel and `ACUTE.bat status` always name the
tag (and say when it is still a draft).

Extra commands when you want to drive it yourself:

- `ACUTE.bat reinstall` — delete the desktop app completely, download +
  install the newest release, verify it, launch it.
- `ACUTE.bat uninstall` — remove the packaged desktop app cleanly (data is
  kept). No credentials needed; works even if the app is half-broken.
- `ACUTE.bat status` — now shows the full version truth: registry version,
  exe-on-disk version, latest release on GitHub, update-pending flag, and
  whether a repair is queued.

## If anything goes wrong

- The launcher shows a **red panel** with the exact error and the log path
  (`C:\ACUTE\.acute\launcher.log`), and **keeps the window open** so you can
  copy everything (select the text → Enter copies in the console).
- Everything is idempotent — fix the issue (or don't) and double-click again;
  it resumes where it stopped.
- Useful commands (run in cmd from your folder):
  - `ACUTE.bat` — ask app-or-site, then launch (the default)
  - `ACUTE.bat app` — the packaged desktop app, no question
  - `ACUTE.bat site` — the site in your browser, no question
  - `ACUTE.bat status` — read-only health report (versions, update state,
    installed desktop app, launch preference, engine last-boot line,
    servers, token length, log path)
  - `ACUTE.bat update` — update everything but don't start the app
  - `ACUTE.bat start` — start without the update check (still asks)
  - `ACUTE.bat desktop` — same as `app` (install/launch ONLY the packaged
    desktop app; falls back to the dev flow if it cannot)
  - `ACUTE.bat reinstall` — full delete + fresh install + launch (round 63)
  - `ACUTE.bat uninstall` — remove the packaged desktop app cleanly (round
    63; your data in `%APPDATA%\acute-code` is always kept)
  - `ACUTE.bat --web` — skip the question, run the browser flow

## Updating the launcher itself

Most of the time you never touch the files again: when the repository ships a
newer `acute_launcher.py`, the launcher **copies it over and re-runs itself
immediately** (round 56) — the new logic drives that very session, not the
next one. Only `ACUTE.bat` cannot self-overwrite (Windows locks the file
while it runs), so if the launcher prints
`! ACUTE.bat also changed — please re-download it`:

1. Open the repo → `launcher/` → `ACUTE.bat` → Raw → save over your old one.
2. Double-click again.

> **History note:** round-13 (2026-08-23) switched git authentication away
> from credential helpers (they failed on Git-for-Windows) — the token goes
> into the one-off clone/fetch URL and is never stored in git config.
> Round-87 removed `credentials.txt` entirely: the launcher's only
> credential is the GitHub token (asked once interactively, saved in your
> user home at `~/.acute/github.pat` — round-90, with a pre-round-90 copy
> next to the launcher migrated automatically — or read from
> `ACUTE_GITHUB_PAT`, which is also passed to the app it starts), and
> every AI provider key is saved inside the app itself (Settings → Models
> & Providers → the desktop app writes Windows Credential Manager).

## Notes

- **Python**: the coordinator uses it for the workhorse. If it isn't
  installed, the .bat detects that and offers to install it via winget
  automatically — then just re-double-click.
- **Node.js / git**: missing or too old → detected, highlighted in red, and
  auto-installed via winget on your confirmation. (The packaged desktop app
  needs NEITHER — its Node runtime is bundled inside the installer — but the
  launcher's update/self-update path still uses them.)
- The packaged **desktop app** (round 51+) is the default on Windows: it
  bundles the whole backend (a pinned Node runtime + the agent core) inside
  the installer, which is what finally activates the embedded Chromium
  browser and **computer use** — the dev/browser flow can never use them
  (browsers don't expose the native webview APIs). Since round 63 the
  launcher's SITE plan says so explicitly, and the desktop app's version is
  verified three ways on every install (see above).
- Linux/macOS: use `acute.sh` the same way (`bash acute.sh`) — the desktop
  installer is Windows-only, so those platforms always use the dev flow.
