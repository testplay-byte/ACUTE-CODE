# ACUTE-CODE — one-click launcher (first-time setup)

You want ACUTE-CODE running on your PC by double-clicking ONE file. Here is
exactly how, start to finish.

## What you need (3 files, ~2 minutes)

Create a folder anywhere — e.g. `C:\ACUTE`. In it, put these three files
from **this GitHub repo, folder `launcher/`** (open the repo in your browser →
click into `launcher/` → click each file → **Raw** button → right-click →
*Save page as…* into your folder):

| File | What it is |
|---|---|
| `ACUTE.bat` | the file you double-click (tiny coordinator) |
| `acute_launcher.py` | the program that does all the work (rich terminal UI) |
| `credentials.example.txt` | template for your credentials |

> **Yes, all three come from GitHub** — nothing is created by hand except your
> credentials file (next step). Nothing in them needs editing.

## Set up your credentials (once)

1. Rename `credentials.example.txt` → **`credentials.txt`**
2. Open it in any text editor and paste your values on the marked lines in
   the **PASTE ZONE**:
   - `GITHUB_PAT=` your GitHub token (starts with `github_pat_`) — needed to
     download the private repository. **Required.**
   - `OPENROUTER_KEY=` your OpenRouter key (starts with `sk-or-v1-`) — needed
     for live model chats. **Required.**
   - `OPENROUTER_SUB1..3_KEY=` optional extra OpenRouter keys for the
     sub-agent pool — sub-agents use these first so your main key is not
     burdened. Leave the placeholders to opt out.
3. Save and close.

That file stays on your PC only — it is never uploaded, committed, or sent
anywhere except directly to GitHub (clone/pull auth) and, locally, into the
app's secure key store. **No keys ship inside the launcher or the template**
— every value comes from you, and only you. Rotate or clear the values
whenever you like.

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
   ├── credentials.txt        ← your secrets (local only)
   ├── .acute-launch-pref.json ← your remembered launch choice (round 56)
   ├── ACUTE-CODE\            ← the app (downloaded, self-updating)
   └── .acute\                ← helper data (logs, installer downloads)
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
   `C:\Users\<you>\AppData\Local\ACUTE-CODE`), stores your OpenRouter keys
   in **Windows Credential Manager** so the app boots with them, and starts
   **`ACUTE-CODE.exe`** — a real app window with the embedded Chromium
   browser and the agent backend bundled inside. No browser tab, no servers
   to manage, nothing to type.
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
`--web` / `--no-desktop`): dependencies install, the backend builds, your
   OpenRouter key is stored in **Windows Credential Manager**, the servers
   start, and **http://localhost:5173** opens in your browser (it opens by
   itself). Keep the window open while using the app; **Ctrl+C** in the
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
    servers, credential lengths, log path)
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
> from credential helpers (they failed on Git-for-Windows) — the token now
> goes into the one-off clone/fetch URL and is never stored anywhere.
> Round-47 (2026-08-29) removed the sub-agent key defaults that used to be
> baked into the launcher: all five credential lines are now yours to fill,
> the launcher never writes key values, and the template ships placeholders
> only. If your `credentials.txt` predates round-47, missing sub-key lines
> are appended as placeholders automatically on the next run — fill them or
> ignore them.

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
