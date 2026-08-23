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
2. Open it in Notepad and paste your values on the two marked lines:
   - `GITHUB_PAT=` your GitHub token (starts with `github_pat_`) — needed to
     download the private repository
   - `OPENROUTER_KEY=` your OpenRouter key (starts with `sk-or-`) — needed for
     live model chats
3. Save and close.

That file stays on your PC only — it is never uploaded, committed, or sent
anywhere except directly to GitHub (clone/pull auth) and, locally, into the
app's secure key store. Rotate or clear the values whenever you like.

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
   ├── ACUTE-CODE\            ← the app (downloaded, self-updating)
   └── .acute\                ← helper data (logs, isolated git credentials)
   ```
3. Dependencies install (a few minutes, first time only), the backend builds,
   your OpenRouter key is stored in **Windows Credential Manager**, and the
   servers start.
4. Open **http://localhost:5173** in your browser. Keep the window open
   while using the app; **Ctrl+C** in the window stops the servers cleanly.

## Every later run

Just double-click `ACUTE.bat` again. It checks GitHub for new versions — if
there are any, it **stops the live servers, updates, rebuilds, and restarts
them automatically** — then launches. Your agents, sessions, projects and
settings persist in `ACUTE-CODE\.dev\` and are never touched by updates.
The launcher even updates itself when the repo ships a newer one.

## If anything goes wrong

- The launcher shows a **red panel** with the exact error and the log path
  (`C:\ACUTE\.acute\launcher.log`), and **keeps the window open** so you can
  copy everything (select the text → Enter copies in the console).
- Everything is idempotent — fix the issue (or don't) and double-click again;
  it resumes where it stopped.
- Useful commands (run in cmd from your folder):
  - `ACUTE.bat status` — read-only health report (versions, update state,
    servers, credential lengths, log path)
  - `ACUTE.bat update` — update everything but don't start the servers
  - `ACUTE.bat start` — start without the update check

## Updating the launcher itself

Most of the time you never touch the files again: when the repository ships a
newer `acute_launcher.py`, the launcher **copies it over automatically** on
its next run. Only `ACUTE.bat` cannot self-overwrite (Windows locks the file
while it runs), so if the launcher prints
`! ACUTE.bat also changed — please re-download it`:

1. Open the repo → `launcher/` → `ACUTE.bat` → Raw → save over your old one.
2. Double-click again.

> **Changed in round-13 (2026-08-23):** re-download **only
> `acute_launcher.py`** — git authentication no longer uses credential
> helpers at all (they failed on Git-for-Windows); the token now goes into
> the one-off clone/fetch URL and is never stored anywhere. `ACUTE.bat` and
> `credentials.txt` stay as they are.
>
> Round-12 (superseded): re-download both `ACUTE.bat` (UTF-8 console) and
> `acute_launcher.py`.

## Notes

- **Python**: the coordinator uses it for the workhorse. If it isn't
  installed, the .bat detects that and offers to install it via winget
  automatically — then just re-double-click.
- **Node.js / git**: missing or too old → detected, highlighted in red, and
  auto-installed via winget on your confirmation.
- This launcher runs the **dev stack** (console window + browser). The
  packaged single-`.exe` experience is a later milestone and will slot into
  the same launcher.
- Linux/macOS: use `acute.sh` the same way (`bash acute.sh`).
