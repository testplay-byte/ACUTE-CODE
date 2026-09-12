#!/usr/bin/env python3
# ACUTE-CODE launcher — the workhorse behind ACUTE.bat / acute.sh.
#
# Round-12 hardening (2026-08-23, owner-reported Windows failure): git auth
# switched to an isolated HOME + single-word `store` helper (quoted paths in
# the helper config broke the clone on Windows via MSYS sh — 'failed to
# execute prompt script'); GitHub-API token pre-flight for precise errors;
# spinner-ghost fix; secret redaction in logs; run-plan panel; disk-space
# check; chcp 65001 + PYTHONUTF8 in ACUTE.bat (fixes mojibake borders).
#
# Owner round-11 redesign (2026-08-23): the .bat file is only a tiny
# double-clickable coordinator; THIS Python program does the real work with a
# rich, beautiful terminal UI (panels, spinners, progress, tables). It:
#
#   • asks for your GitHub token ONCE on first run (saved in your USER
#     HOME at ~/.acute/github.pat — it downloads the repo; R87: the
#     old credentials.txt file is GONE and provider API keys are saved IN
#     THE APP, Settings → Models & Providers; R90-B1: the token moved out
#     of the kit folder so the app's update check finds it)
#   • checks the toolchain and AUTO-INSTALLS what is missing
#     (git / Node.js via winget on Windows, with your confirmation;
#      pnpm is activated through corepack — no global installs)
#   • keeps your folder clean: launcher files stay at the top level, and
#     everything downloaded lives inside ./ACUTE-CODE (the app) and
#     ./.acute (downloads cache + logs) in the SAME directory (R90-B1: the
#     GitHub token itself lives in the USER HOME — ~/.acute/github.pat)
#   • on every run: checks GitHub for updates → stops the live servers →
#     pulls → reinstalls → rebuilds → relaunches (your data persists)
#   • self-updates: if the repo ships a newer launcher, it copies it over
#   • shows every failure in a red panel with the full log tail and the log
#     file path, and KEEPS THE WINDOW OPEN so you can copy it
#
# Zero required third-party packages. If `rich` is available (installed
# automatically on first run — MIT licensed) you get the full graphical
# terminal; otherwise it degrades to clean plain text and keeps working.
#
# Python 3.9+ · Windows / Linux / macOS · run via ACUTE.bat (Windows) or
# acute.sh (Linux/macOS), or directly: python3 acute_launcher.py [command]
#
# Commands:  (default) update-check, ASK app-or-site, then launch
#            start = no update pass (still asks)  · update = update only, exit
#            status = read-only health report    · app|desktop = packaged app
#            site|web = the local servers + browser (no desktop install)
#            reinstall = DELETE the desktop app completely + fresh install
#            uninstall = remove the packaged desktop app (data is kept)
# Flags:     --no-update   --verbose   --app (force desktop)   --site/--web
#            --no-desktop (same as --site)   --reinstall (force a full
#            delete-and-reinstall of the desktop app this run)
#
# ROUND-56 (R56): the launcher ASKS how to launch — the desktop app or the
# site in the browser — on every interactive run (Enter = your last choice,
# first run defaults to the desktop app). Explicit commands/flags skip the
# question. The remembered choice lives in .acute-launch-pref.json next to
# this file. The self-update now RE-EXECs the fresh launcher so new logic
# runs THIS session instead of the next one.
#
# ROUND-63 (R63) — the desktop-UPDATE truth round (owner: "the desktop
# application was not reinstalled properly, not updated properly"):
#   • the update decision no longer trusts ONE signal. THREE versions are
#     checked against the latest GitHub release: the uninstall registry's,
#     the installed exe's FileVersion ON DISK, and (after launch) the
#     running engine's GET /health version.
#   • hybrid installs (registry bumped, exe stale — a silent install over a
#     running app) are DETECTED and repaired by a FULL removal: NSIS
#     uninstaller (/S, pinned synchronous with _?=) + folder residue +
#     stale registry entries, then a fresh install, verified the same way.
#   • downloads are sha256-verified against the release asset digest; the
#     app is closed AND waited-for (process poll, not a fixed sleep)
#     before the installer runs, so no file is ever locked mid-replace.
#   • new commands:  ACUTE.bat reinstall  (delete + fresh install + launch)
#     and  ACUTE.bat uninstall  (remove the packaged app cleanly).
#     A sticky repair flag (.acute/desktop-repair-flag.json) makes the next
#     run self-heal an engine that booted the wrong version.
#
# ROUND-74 (R74) — the draft-order freeze fix (owner: "the installed desktop
# app version was 0.67.0 — it did not update"): GitHub's /releases list
# sorts never-published DRAFTS above every published release, and the
# round-63..67 close-outs left five drafts (v0.63.0 … v0.67.0) sitting at
# list positions 1-5 — the old first-match walk in _desktop_latest_release
# returned draft v0.67.0 as "latest", so an installed 0.67.0 looked current
# while v0.73.0 was live. The winner is now chosen by MAX VERSION
# (_pick_latest_release: pure, unit-tested in launcher/tests/) — drafts
# stay first-class (the owner's PAT sees them by design), and the
# version-truth panel names the tag it picked. Nothing else changed.
#
# ROUND-94-A (R94-A) — the public-migration update round (owner: the update
# died with "fatal: Not possible to fast-forward, aborting" after the repo
# went PUBLIC — the v0.91.0 migration REWROTE the history, so every
# pre-existing clone diverged from remote main):
#   • the repository being PUBLIC is the intended state now — the old
#     "GitHub reports this repository as PUBLIC" warning is GONE (a plain
#     note instead); all "private repo" help/error texts neutralized (the
#     PAT is still used — it only raises rate limits and sees drafts);
#   • repo_state also counts "ahead" (FETCH_HEAD..HEAD); clone_or_update
#     REALIGNS a diverged checkout with `git reset --hard FETCH_HEAD`
#     (clean-tree-guarded, nothing outside ACUTE-CODE/ touched) instead of
#     the fast-forward pull that could never succeed;
#   • an update failure NEVER dead-ends a machine with an existing build —
#     warn + boot the installed version, retry next run. Only a fresh-clone
#     failure (no local copy at all) still hard-fails.

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.request import urlopen

IS_WIN = os.name == "nt"
LAUNCHER_DIR = Path(__file__).resolve().parent
APP_DIR = LAUNCHER_DIR / "ACUTE-CODE"
DOT_DIR = LAUNCHER_DIR / ".acute"
BIN_DIR = DOT_DIR / "bin"
LOG_PATH = DOT_DIR / "launcher.log"
ENV_PATH = APP_DIR / ".env.development"
REPO_URL = "https://github.com/testplay-byte/ACUTE-CODE.git"
GIT_USER = "testplay-byte"
UI_PORT = 5173
SIDECAR_PORT = 5178
NODE_MIN_MAJOR = 20
STARTED = time.time()

# ROUND-90 (R90-B1b): Windows consoles on legacy codepages (cp1252/cp437 —
# the GitHub Actions pwsh default among them) raise UnicodeEncodeError the
# moment panel() prints its box-drawing characters, crashing the launcher at
# its FIRST message (found by the R90 CI run 34631535592: the fresh-machine
# PAT prompt test died inside panel, not inside the prompt logic). Reconfigure
# both streams to UTF-8 with replacement — a console that cannot SHOW a glyph
# still shows something, and the launcher keeps working.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError, ValueError):
        # A replaced/captured stream (tests, pipes) keeps its own settings.
        pass

# R56: launch-mode commands + the remembered-choice file. The preference is
# intentionally OUTSIDE .acute (which `status` describes as a cache) — it is
# user settings, not a download, and must survive a cache wipe.
SITE_COMMANDS = ("site", "web")
DESKTOP_COMMANDS = ("desktop", "app")
# R63: full-reinstall / clean-removal commands (see desktop_flow and
# mode_uninstall). `reinstall` = delete + fresh install + launch;
# `uninstall` = remove the packaged app (data in %APPDATA% is kept).
REINSTALL_COMMANDS = ("reinstall", "repair")
PREF_PATH = LAUNCHER_DIR / ".acute-launch-pref.json"

# ─────────────────────────────────────────────────────────────────────────────
# rich bootstrap (optional, auto-installed on first run; plain fallback)
# ─────────────────────────────────────────────────────────────────────────────

RICH = None


def _try_install_rich():
    # Ask before touching the machine — plain question, rich isn't loaded yet.
    print("The beautiful terminal UI needs the free 'rich' package (MIT license).")
    answer = input("Install it now for this user? [Y/n] ").strip().lower()
    if answer in ("", "y", "yes"):
        for args in (
            [sys.executable, "-m", "pip", "install", "--user", "--quiet", "rich"],
            [sys.executable, "-m", "pip", "install", "--quiet", "rich"],
        ):
            try:
                r = subprocess.run(args, capture_output=True, text=True, timeout=300)
                if r.returncode == 0:
                    return True
            except Exception:
                continue
        print("Could not auto-install rich — continuing with the plain text UI.")
    else:
        print("Skipping rich — continuing with the plain text UI.")
    return False


if "--no-rich-install" in sys.argv or "--no-pause" in sys.argv or not sys.stdin.isatty():
    try:
        import rich  # noqa: F401

        RICH = "present"
    except ImportError:
        RICH = None
else:
    try:
        import rich  # noqa: F401

        RICH = "present"
    except ImportError:
        if _try_install_rich():
            try:
                import rich  # noqa: F401

                RICH = "present"
            except ImportError:
                RICH = None

if RICH:
    from rich.console import Console
    from rich.panel import Panel
    from rich.rule import Rule
    from rich.table import Table
    from rich.text import Text

    console = Console()

LOGO = [
    r"╔═╗╔═╗╦ ╦╔╦╗╔═╗",
    r"╠═╣║  ║ ║ ║ ║╣ ",
    r"╩ ╩╚═╝╚═╝═╩╝╚═╝",
]

STEP_N = 0

# Active rich spinner bookkeeping — fail()/wait_close() must stop any running
# spinner BEFORE printing, or its line ghosts after the panel (owner-reported).
SPINNER_STATE = {"s": None}


def stop_active_spinner():
    s = SPINNER_STATE["s"]
    if s is not None:
        try:
            s.stop()
        except Exception:
            pass
        SPINNER_STATE["s"] = None


def banner():
    if RICH:
        art = "\n".join(LOGO)
        console.print()
        console.print(
            Panel(
                Text(f"{art}  ‑ C O D E\n", style="bold cyan", justify="center")
                + Text("local-first multi-agent workbench · one-click launcher\n",
                       style="dim", justify="center")
                + Text(time.strftime("%Y-%m-%d %H:%M") + f"  ·  {'Windows' if IS_WIN else sys.platform}",
                       style="dim", justify="center"),
                border_style="cyan",
                title="[bold cyan]ACUTE-CODE[/]",
            )
        )
    else:
        print("=" * 62)
        print("  ACUTE-CODE — local-first multi-agent workbench launcher")
        print(f"  {time.strftime('%Y-%m-%d %H:%M')}  ·  {sys.platform}")
        print("=" * 62)


def rule(title=""):
    if RICH:
        console.print(Rule(title=title, style="dim cyan"))
    else:
        print(f"──── {title} ".ljust(62, "─") if title else "─" * 62)


def step(name):
    """Numbered step header; returns a context manager wrapping a spinner."""
    global STEP_N
    STEP_N += 1
    label = f"[{STEP_N}] {name}"

    class _Step:
        def __enter__(self):
            stop_active_spinner()
            if RICH:
                # Text() = literal label — the "[1]" step prefix can never be
                # misparsed as rich markup.
                self._s = console.status(Text(label, style="bold cyan"), spinner="dots12")
                self._s.start()
                SPINNER_STATE["s"] = self._s
            else:
                print(f"\n── {label} " + "─" * max(2, 56 - len(label)))
            return self

        def __exit__(self, *exc):
            if RICH:
                if SPINNER_STATE["s"] is self._s:
                    SPINNER_STATE["s"] = None
                self._s.stop()
            return False

    return _Step()


def ok(msg):
    if RICH:
        # style= kwarg — no inline markup, so message content can never break it
        console.print(f"  ✓ {msg}", style="bold green")
    else:
        print(f"  [OK] {msg}")


def note(msg):
    if RICH:
        console.print(f"      {msg}", style="dim")
    else:
        print(f"       {msg}")


def warn(msg):
    if RICH:
        console.print(f"  ! {msg}", style="bold yellow")
    else:
        print(f"  [!] {msg}")


def confirm(question, default=True):
    if RICH:
        from rich.prompt import Confirm

        return Confirm.ask(question, default=default)
    hint = "[Y/n]" if default else "[y/N]"
    a = input(f"{question} {hint} ").strip().lower()
    if not a:
        return default
    return a in ("y", "yes")


def panel(text, style="cyan", title=None):
    if RICH:
        console.print(Panel(Text(text, justify="left"), border_style=style, title=title))
    else:
        print(f"┌─ {title or ''}".ljust(64, "─"))
        for line in text.splitlines():
            print(f"│ {line}")
        print("└" + "─" * 63)


def fail(where, detail):
    """Visible, copyable failure. Keeps the window open, never raises."""
    stop_active_spinner()
    tail = "\n".join(redact(str(detail)).strip().splitlines()[-40:])
    log_hint = f"Full log: {LOG_PATH}"
    body = (
        f"{tail}\n\n"
        f"{log_hint}\n"
        "Fix the issue above, then double-click the launcher again —\n"
        "everything is idempotent and resumes where it stopped."
    )
    log(f"!!! FAILED at {where}\n{detail}")
    try:
        if RICH:
            console.print(Panel(body, title=f"✗ FAILED — {where}", border_style="red"))
        else:
            raise RuntimeError("plain mode")
    except Exception:  # noqa: BLE001 — plain fallback can not fail
        print("╔" + "═" * 63)
        print(f"║  FAILED — {where}")
        print("╠" + "═" * 63)
        for line in body.splitlines():
            print(f"║  {line}")
        print("╚" + "═" * 63)
    wait_close()
    sys.exit(1)


def wait_close():
    if "--no-pause" in sys.argv or not sys.stdin.isatty():
        return
    try:
        input("\nPress Enter to close this window… ")
    except EOFError:
        pass


def log(msg):
    try:
        DOT_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(redact(str(msg)).rstrip() + "\n")
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# subprocess helpers
# ─────────────────────────────────────────────────────────────────────────────

CMD_SHIMS = {"pnpm", "corepack", "winget", "npm", "npx"}


def wrap(cmd):
    """Windows .cmd shims need cmd /c; everything else runs directly."""
    if IS_WIN and (cmd[0] in CMD_SHIMS or Path(cmd[0].lower()).suffix in (".cmd", ".bat")):
        return ["cmd", "/c", *cmd]
    return cmd


def run(cmd, cwd=None, env=None, check=True, timeout=None):
    cmd = wrap(cmd)
    display = " ".join(str(c) for c in cmd)
    log(f"$ {display} (cwd={cwd or LAUNCHER_DIR})")
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        if check:
            fail(display, f"timed out after {timeout}s")
        return None
    except FileNotFoundError:
        if check:
            fail(display, "command not found — is it installed and on PATH?")
        return None
    out = (proc.stdout or "") + (proc.stderr or "")
    log(out.strip())
    if "--verbose" in sys.argv and out.strip():
        for line in out.strip().splitlines():
            note(line)
    if proc.returncode != 0 and check:
        fail(display, out or f"exited with code {proc.returncode}")
    return proc


def probe(cmd, timeout=20):
    """Run without check; returns (returncode, output) — returncode None if missing."""
    try:
        cmd = wrap(cmd)
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout,
        )
        return proc.returncode, ((proc.stdout or "") + (proc.stderr or "")).strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None, ""


# ─────────────────────────────────────────────────────────────────────────────
# GitHub access token (R87: credentials.txt is GONE — provider API keys are
# saved IN THE APP, Settings → Models & Providers; the launcher's only
# credential is the GitHub token that downloads the repository itself)
# ─────────────────────────────────────────────────────────────────────────────

SETUP_INSTRUCTIONS = """\
FIRST-TIME SETUP — 3 steps, about 2 minutes:

  1.  Create a folder anywhere (e.g.  C:\\ACUTE  ) — done, you are here.
  2.  Put exactly TWO files in it (from the GitHub repo,
      folder  launcher/  → click each file → Raw → right-click → Save as):
        • ACUTE.bat            (the file you double-click)
        • acute_launcher.py    (the program doing all the work)
  3.  Double-click ACUTE.bat. When asked, paste your GitHub token
      (starts with github_pat_ — it downloads the app and its updates).
      It is saved on YOUR PC only (never uploaded anywhere).

Later runs: just double-click ACUTE.bat — it checks GitHub for updates,
restarts the servers, and keeps all your data (agents/sessions/projects).

API keys for AI providers (OpenRouter, NVIDIA, …) are NO LONGER read from
any file — save them inside the app:  Settings → Models & Providers.
"""

# R90-B1: the token is saved in the USER HOME, not next to the launcher.
# The app's sidecar (agent-core/src/routes/system.ts readLauncherGithubPat)
# reads  <home>/.acute/github.pat; the pre-R90 kit-relative location below
# could never be found there, so the app's "Check for updates" answered
# "token not saved" forever even after the owner let acute.bat save it.
# DOT_DIR keeps ONLY the logs + download cache — nothing else moves.
# The launcher also hands the resolved token to the app it starts via the
# ACUTE_GITHUB_PAT environment variable (the env layer the sidecar honors
# FIRST), so the update check works even before/independent of the file.
PAT_PATH = Path.home() / ".acute" / "github.pat"
# The pre-R90 location — kept ONLY as the one-time migration source plus
# the fallback read when the home copy cannot be written/read (a locked or
# portable home must never lock the owner out of their own token).
LEGACY_PAT_PATH = DOT_DIR / "github.pat"


def _no_interactive_github_pat():
    """Non-interactive shell (stdin closed / CI): no prompt is possible —
    show the honest setup panel and exit instead of a raw traceback."""
    panel(
        SETUP_INSTRUCTIONS,
        style="yellow",
        title="GitHub token needed — no interactive prompt available",
    )
    log("no GitHub token and stdin is not interactive")
    wait_close()
    sys.exit(1)


def resolve_github_pat():
    """The ONE credential the launcher still needs: the GitHub token that
    downloads the repository. R87 (credentials.txt removed): resolved from
    (1) the ACUTE_GITHUB_PAT / GITHUB_PAT environment variable, (2) the
    locally saved  ~/.acute/github.pat  in the USER HOME (R90-B1: moved out
    of the kit folder — the app's update check reads exactly this path, and
    a pre-R90  <kit>/.acute/github.pat  is migrated below), (3) an
    interactive prompt on first run — the answer is saved so later runs
    never ask again. Never logged, never echoed (input is masked).
    """
    # R90-B1 one-time migration: a token saved by a pre-R90 launcher sits at
    # <kit>/.acute/github.pat — move it into the USER HOME so the app (whose
    # sidecar reads ~/.acute/github.pat) finally finds it. This runs BEFORE
    # the env-var short-circuit: even a launcher run that authenticates via
    # ACUTE_GITHUB_PAT should carry the owner's already-saved token over, so
    # an app started WITHOUT this launcher (Start Menu / desktop shortcut,
    # no env) still finds the file. The legacy file is only deleted AFTER the
    # home copy is safely written, and a failed migration never locks the
    # owner out — the legacy read below stays as the fallback.
    try:
        if LEGACY_PAT_PATH.is_file() and not PAT_PATH.is_file():
            legacy = LEGACY_PAT_PATH.read_text(encoding="utf-8", errors="replace").strip()
            if legacy.startswith(("github_pat_", "ghp_", "gho_")):
                PAT_PATH.parent.mkdir(parents=True, exist_ok=True)
                PAT_PATH.write_text(legacy + "\n", encoding="utf-8")
                try:
                    os.chmod(PAT_PATH, 0o600)
                except OSError:
                    pass
                LEGACY_PAT_PATH.unlink()
                log("GitHub token: migrated the saved token from the launcher folder to the user home")
    except OSError:
        # Unwritable/locked home, half-copied file, … — keep going: the
        # legacy copy is still on disk and the fallback read below finds it.
        log("GitHub token: home migration failed — keeping the launcher-folder copy")

    env_pat = (os.environ.get("ACUTE_GITHUB_PAT") or os.environ.get("GITHUB_PAT") or "").strip()
    if env_pat:
        log("GitHub token: environment variable")
        return env_pat

    try:
        saved = PAT_PATH.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        saved = ""
    if not saved.startswith(("github_pat_", "ghp_", "gho_")) and LEGACY_PAT_PATH.is_file():
        # R90-B1 fallback: the home read failed or held nothing usable — a
        # token still sitting at the legacy kit path keeps working (this is
        # the branch a FAILED migration lands in, and also covers a manual
        # pre-R90-style file the owner dropped next to the launcher).
        try:
            saved = LEGACY_PAT_PATH.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            saved = ""
    if saved.startswith(("github_pat_", "ghp_", "gho_")):
        log("GitHub token: saved from an earlier run")
        return saved

    # First run — the prompt. The launcher is an interactive console program
    # (it asks app-or-site later anyway), so asking here is the same UX.
    panel(
        "The launcher needs your GitHub token ONCE to download the app.\n"
        "It is saved on this PC only (never uploaded, never logged).\n"
        "Get one: github.com → Settings → Developer settings →\n"
        "Personal access tokens → Generate new token (read access to this\n"
        "repository, testplay-byte/ACUTE-CODE).",
        title="GitHub token",
    )
    try:
        import getpass

        pat = getpass.getpass("Paste your GitHub token (input hidden): ").strip()
    except EOFError:
        _no_interactive_github_pat()
    except Exception:
        try:
            pat = input("Paste your GitHub token: ").strip()
        except EOFError:
            _no_interactive_github_pat()

    if not pat.startswith(("github_pat_", "ghp_", "gho_")):
        fail(
            "GitHub token not recognized",
            "The token should start with  github_pat_  (or ghp_/gho_).\n\n"
            "How to fix (2 minutes):\n"
            "  1. Go to github.com → Settings → Developer settings →\n"
            "     Personal access tokens → Generate new token\n"
            "  2. Give it read access to this repository (testplay-byte/ACUTE-CODE)\n"
            "  3. Run the launcher again and paste the new token",
        )

    try:
        PAT_PATH.parent.mkdir(parents=True, exist_ok=True)
        PAT_PATH.write_text(pat + "\n", encoding="utf-8")
        try:
            os.chmod(PAT_PATH, 0o600)
        except OSError:
            pass
        ok(f"token saved at {PAT_PATH} (chmod 600 where supported)")
        note("delete that file any time to re-enter it")
    except Exception as exc:
        warn(f"could not save the token locally ({exc}) — you will be asked again next run")

    log("GitHub token: entered interactively (values never logged)")
    return pat


# ─────────────────────────────────────────────────────────────────────────────
# secrets hygiene + GitHub pre-flight
# ─────────────────────────────────────────────────────────────────────────────

SECRETS_TO_REDACT: list = []


def register_secrets(*values):
    """Values that must never appear in logs or error panels."""
    for v in values:
        if v:
            SECRETS_TO_REDACT.append(v)


def redact(text):
    for s in SECRETS_TO_REDACT:
        if s:
            text = text.replace(s, "***")
    return text


def validate_github_access(pat):
    """Pre-flight the PAT against the real GitHub API so a bad token shows a
    PRECISE message (expired / no repo access / offline) instead of git's
    cryptic prompt failure. Returns True (ok) / None (offline — continue)."""
    import json as _json
    import urllib.error
    import urllib.request

    url = "https://api.github.com/repos/testplay-byte/ACUTE-CODE"
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {pat}", "User-Agent": "acute-launcher"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = _json.loads(resp.read().decode("utf-8", "replace") or "{}")
        # R94-A: the repository is PUBLIC by owner decision (the v0.91.0
        # public migration) — "public" is the intended, healthy state, not
        # an anomaly to flag. The PAT stays valid: it only raises GitHub's
        # rate limits (and still sees draft releases).
        visibility = "private" if body.get("private") else "public"
        if visibility == "public":
            note("repository is public — anonymous GitHub access works; the saved token only raises rate limits")
        ok(f"token accepted  ·  repository visible ({visibility})")
        return True
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            fail(
                "GitHub token rejected",
                f"GitHub answered HTTP {exc.code}: the saved GitHub token is invalid,\n"
                "expired, or revoked.\n\n"
                "How to fix (2 minutes):\n"
                "  1. Go to github.com → Settings → Developer settings →\n"
                "     Personal access tokens → Generate new token\n"
                "  2. Give it read access to this repository (testplay-byte/ACUTE-CODE)\n"
                f"  3. Delete {PAT_PATH} (or set ACUTE_GITHUB_PAT), then run the\n"
                "     launcher again and paste the new token when asked",
            )
        if exc.code == 404:
            fail(
                "repository not visible to this token",
                "The token itself is valid, but GitHub hides testplay-byte/ACUTE-CODE from it.\n"
                "It needs read access to this repository\n"
                "(or the repository owner/name changed — check with the owner).",
            )
        fail(f"GitHub answered HTTP {exc.code}", f"While verifying the token: {exc}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        warn("could not reach GitHub to verify the token — continuing; git will retry")
        note(f"({exc.__class__.__name__})")
        return None


def check_disk_space(need_gb=2.0):
    """First-run safety: warn early when the disk cannot hold install+build."""
    try:
        free_gb = shutil.disk_usage(str(LAUNCHER_DIR)).free / (1024 ** 3)
        if free_gb < need_gb:
            warn(f"only {free_gb:.1f} GB free — the first install needs ~{need_gb:.0f} GB; it may fail")
        else:
            note(f"{free_gb:.1f} GB free on this drive")
    except OSError:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# git auth — token-in-URL (round-13). The CI-proven, environment-independent
# pattern: the token goes into the URL for THE ONE COMMAND, and the stored
# remote is sanitized to a tokenless URL right after the clone. No credential
# helpers at all (both helper variants failed on the owner's Git-for-Windows
# even when correctly configured — memory lesson #24), no helper files, no
# HOME games for auth. GIT_TERMINAL_PROMPT=0 makes git FAIL FAST instead of
# trying to ask a question in a window that cannot answer one.
# ─────────────────────────────────────────────────────────────────────────────

GIT_CLEAN_URL = "https://github.com/testplay-byte/ACUTE-CODE.git"


def authed_url(pat):
    """One-command authenticated repo URL (redacted from every log/panel)."""
    from urllib.parse import quote

    return (
        f"https://{quote(GIT_USER, safe='')}:{quote(pat, safe='')}"
        "@github.com/testplay-byte/ACUTE-CODE.git"
    )


def git_env(env):
    """Environment for git commands: isolated from the user's config, and
    NEVER allowed to sit waiting for an interactive answer."""
    out = dict(env)
    out["HOME"] = str(DOT_DIR)           # user's gitconfig / GCM not consulted
    out["GIT_CONFIG_NOSYSTEM"] = "1"     # machine gitconfig (GCM) not consulted
    out["GIT_TERMINAL_PROMPT"] = "0"     # fail fast instead of prompting
    return out


def explain_git_failure(proc, cmd_display=""):
    """Turn git's output into a human diagnosis + fix (owner round-13 request
    for proper error displaying). Patterns cover the failures seen in the
    wild on this project."""
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    low = out.lower()
    head = [
        f"command exited with code {proc.returncode}",
    ]
    if cmd_display:
        head.append(f"command: {cmd_display}")
    head.append("")
    head.append(out if out else "(git produced no output)")
    head.append("")

    if ("could not read username" in low or "authentication failed" in low
            or "invalid username or password" in low or " 403 " in low
            or "access denied or repository not enrolled" in low):
        head += [
            "Diagnosis: GitHub rejected the download — almost always the token.",
            "Fix: delete ~/.acute/github.pat (or set ACUTE_GITHUB_PAT), rerun, and paste",
            "token (github.com → Settings → Developer settings → Personal access",
            "tokens → it needs read access to this repository), save, re-run.",
        ]
    elif ("could not resolve host" in low or "timed out" in low
          or "connection" in low and ("reset" in low or "refused" in low)
          or "ssl" in low or "proxy" in low):
        head += [
            "Diagnosis: network problem — GitHub was unreachable.",
            "Fix: check your internet connection (or VPN/proxy) and re-run.",
            "      The launcher continues from where it stopped — nothing is lost.",
        ]
    elif "already exists and is not an empty directory" in low:
        head += [
            "Diagnosis: a leftover folder blocked the download.",
            "Fix: delete the ACUTE-CODE folder next to the launcher, then re-run.",
        ]
    elif "no space left" in low or "disk quota" in low:
        head += [
            "Diagnosis: the disk is full.",
            "Fix: free a few GB (the app needs ~2 GB) and re-run.",
        ]
    else:
        head += [
            "If this is not self-explanatory, copy this whole panel and send it",
            "to the developer — the full log is referenced at the bottom.",
        ]
    return "\n".join(head)


# ─────────────────────────────────────────────────────────────────────────────
# toolchain
# ─────────────────────────────────────────────────────────────────────────────

def winget_install(pkg_id, what):
    code, _ = probe(["winget", "--version"])
    if code is None:
        panel(
            f"{what} is not installed and winget is unavailable.\n"
            "Install it manually:\n"
            "  git  → https://git-scm.com/downloads\n"
            "  Node → https://nodejs.org  (LTS, 20 or newer)",
            style="red",
            title=f"missing: {what}",
        )
        wait_close()
        sys.exit(1)
    if not confirm(f"{what} is missing. Install it automatically with winget now?"):
        fail(f"{what} is required", "Install it manually, then run the launcher again.")
    run(
        ["winget", "install", "-e", "--id", pkg_id, "--silent",
         "--accept-package-agreements", "--accept-source-agreements"],
        timeout=1800,
    )
    panel(
        f"{what} has been installed.\n"
        "PATH changes only apply to NEW windows — please CLOSE this window\n"
        "and double-click the launcher again. Everything resumes from here.",
        style="green",
        title="installed — restart needed",
    )
    wait_close()
    sys.exit(0)


def check_toolchain():
    results = []
    with step("Checking the toolchain (git · Node.js)"):
        code, out = probe(["git", "--version"])
        results.append(("git", (out.splitlines() or ["?"])[0] if code == 0 else None))

        code, out = probe(["node", "--version"])
        node_ver = (out.splitlines() or ["?"])[0] if code == 0 else None
        results.append(("Node.js", node_ver))

    if RICH:
        t = Table(show_header=False, box=None, padding=(0, 2))
        t.add_column(style="dim bold")
        t.add_column()
        for name, ver in results:
            mark = "[bold green]✓[/]" if ver else "[bold red]✗[/]"
            t.add_row(name, ver or "not installed", mark)
        console.print(t)
    else:
        for name, ver in results:
            print(f"    {name:<10} {ver or 'not installed':<24} {'OK' if ver else 'MISSING'}")

    git_ver, node_verv = results[0][1], results[1][1]
    if not git_ver:
        winget_install("Git.Git", "git")

    if not node_verv:
        winget_install("OpenJS.NodeJS.LTS", "Node.js")
    else:
        major = int((re.search(r"v(\d+)", node_verv) or [None, "0"])[1] or 0)
        if major < NODE_MIN_MAJOR:
            warn(f"Node.js {node_verv} is older than v{NODE_MIN_MAJOR} — the app may misbehave.")
            if confirm("Upgrade Node.js to the current LTS with winget now?"):
                winget_install("OpenJS.NodeJS.LTS", "Node.js (upgrade)")
            note("continuing with the installed version…")
    ok("toolchain ready")


def ensure_pnpm(env):
    """Activate pnpm via corepack into .acute/bin (version pinned by the repo)."""
    with step("Activating pnpm (via corepack — no global install)"):
        BIN_DIR.mkdir(parents=True, exist_ok=True)
        env["PATH"] = str(BIN_DIR) + os.pathsep + env.get("PATH", "")
        env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
        run(["corepack", "enable", "--install-directory", str(BIN_DIR)], env=env, check=False)
        code, out = probe(["pnpm", "--version"], timeout=120)
        if code is None or code != 0:
            run(["corepack", "prepare", "pnpm@11.22.0", "--activate"], env=env, check=False)
            code, out = probe(["pnpm", "--version"], timeout=300)
        if code is None or code != 0:
            fail("activating pnpm", out or "corepack could not provide pnpm")
        ok(f"pnpm {(out.splitlines() or ['?'])[0]}")
        return env


# ─────────────────────────────────────────────────────────────────────────────
# repo lifecycle
# ─────────────────────────────────────────────────────────────────────────────

def stop_live_servers(reason):
    """Kill anything listening on :5173 / :5178 (a previous ACUTE run)."""
    pids = []
    for port in (UI_PORT, SIDECAR_PORT):
        if IS_WIN:
            code, out = probe(["netstat", "-ano", "-p", "tcp"])
            if code == 0 and out:
                for line in out.splitlines():
                    m = re.search(rf":{port}\s+\S+\s+\S*\s+LISTENING\s+(\d+)", line)
                    if m and m.group(1) != str(os.getpid()):
                        pids.append(m.group(1))
        else:
            code, out = probe(["bash", "-c", f"lsof -t -i :{port}"])
            if code == 0 and out.strip():
                pids += [p.strip() for p in out.split() if p.strip()]
            else:
                code, out = probe(["bash", "-c", f"ss -ltnp 2>/dev/null | grep ':{port} '"])
                if code == 0 and out:
                    pids += re.findall(r"pid=(\d+)", out)
    pids = [p for p in dict.fromkeys(pids) if p != str(os.getpid())]
    if not pids:
        return
    note(f"stopping previous ACUTE servers ({reason}): pid {', '.join(pids)}")
    for pid in pids:
        if IS_WIN:
            run(["taskkill", "/F", "/PID", pid], check=False, timeout=30)
        else:
            run(["kill", "-9", pid], check=False, timeout=30)
    time.sleep(2)


def repo_state(pat, env):
    genv = git_env(env)
    head = run(["git", "rev-parse", "--short", "HEAD"],
               cwd=APP_DIR, env=genv, check=False)
    if head.returncode != 0:
        return None
    head = head.stdout.strip()
    dirty = bool(
        run(["git", "status", "--porcelain"], cwd=APP_DIR, env=genv, check=False).stdout.strip()
    )
    fetch = run(["git", "fetch", authed_url(pat), "main"],
                cwd=APP_DIR, env=genv, check=False, timeout=180)
    if fetch.returncode != 0:
        # R94-A: "ahead" defaults to 0 when GitHub is unreachable —
        # divergence can only be judged against a FETCH_HEAD we actually got
        # (and the behind == -1 caller path returns before ever reading it).
        return {"head": head, "behind": -1, "ahead": 0, "dirty": dirty}
    behind = run(["git", "rev-list", "--count", "HEAD..FETCH_HEAD"],
                 cwd=APP_DIR, env=genv, check=False).stdout.strip()
    # R94-A: "ahead" counts the commits local HEAD carries that FETCH_HEAD
    # does not. >0 means the histories DIVERGED (e.g. the project rewrote
    # its history when going public), so `git pull --ff-only` can never
    # succeed — clone_or_update realigns with a reset instead.
    ahead = run(["git", "rev-list", "--count", "FETCH_HEAD..HEAD"],
                cwd=APP_DIR, env=genv, check=False).stdout.strip()
    return {"head": head, "behind": int(behind or 0), "ahead": int(ahead or 0), "dirty": dirty}


def _local_build_available():
    """R94-A: is there a runnable local build to fall back to when an update
    fails? True only when the checkout exists AND was already built (the
    agent-core bundle is there) — a fresh machine with no local copy has
    nothing to boot, which keeps the hard fail() below; everything else
    warns and continues with the installed version."""
    return (APP_DIR / ".git").exists() and (APP_DIR / "agent-core" / "dist" / "main.js").exists()


def clone_or_update(pat, env):
    if not (APP_DIR / ".git").exists():
        with step("Downloading ACUTE-CODE from GitHub (first run)"):
            check_disk_space()
            if APP_DIR.exists():
                shutil.rmtree(APP_DIR)
            r = run(["git", "clone", authed_url(pat), str(APP_DIR)],
                    env=git_env(env), timeout=1800, check=False)
            if r is None or r.returncode != 0 or not (APP_DIR / ".git").exists():
                fail(
                    "downloading the ACUTE-CODE repository",
                    explain_git_failure(r) if r is not None else
                    "command exited with code —\n\n(git produced no output; the clone"
                    " timed out or could not start)",
                )
            # Never persist the token: sanitize the stored remote right away.
            run(["git", "remote", "set-url", "origin", GIT_CLEAN_URL],
                cwd=APP_DIR, env=git_env(env))
            head = run(["git", "rev-parse", "--short", "HEAD"],
                       cwd=APP_DIR, env=git_env(env)).stdout.strip()
            ok(f"repository downloaded  ·  folder ACUTE-CODE/  ·  commit {head}")
            note("the app lives in its own subfolder — your launcher files never mix with it")
        return True  # fresh clone ⇒ needs install + build

    with step("Checking GitHub for updates"):
        state = repo_state(pat, env)
        if state is None:
            fail("reading the local repository", f"{APP_DIR} exists but is not a git checkout")
        if state["behind"] == -1:
            warn("GitHub unreachable (offline?) — continuing with the local version")
            return False
        if state["dirty"]:
            warn("local changes inside ACUTE-CODE/ detected — update skipped to protect them")
            note("commit or revert them inside ACUTE-CODE, or delete the folder to re-download")
            return False
        if state["behind"] == 0:
            ok(f"already up to date  ·  commit {state['head']}")
            return False
        stop_live_servers("applying update")
        # R94-A divergence-aware updating:
        #   ahead == 0 → the local history is an ancestor of main → the plain
        #                fast-forward pull keeps working;
        #   ahead  > 0 → the histories DIVERGED (the project rewrote its
        #                history when going public — every pre-existing
        #                clone hit "Not possible to fast-forward, aborting"),
        #                so realign to FETCH_HEAD (the fetch repo_state just
        #                did) with a hard reset. The dirty-tree guard above
        #                already proved the tree is clean, so the reset loses
        #                nothing — and nothing outside ACUTE-CODE/ is touched.
        realigned = False
        if state["ahead"] > 0:
            note("local history diverged from GitHub (the project rewrote its history when going public) — realigning to the published version; nothing outside ACUTE-CODE/ is touched")
            r = run(["git", "reset", "--hard", "FETCH_HEAD"],
                    cwd=APP_DIR, env=git_env(env), timeout=600, check=False)
            realigned = True
        else:
            r = run(["git", "pull", "--ff-only", authed_url(pat), "main"],
                    cwd=APP_DIR, env=git_env(env), timeout=600, check=False)
        if r is None or r.returncode != 0:
            # R94-A: an update failure must NEVER dead-end a machine that
            # already has a working local build — warn with the diagnosis
            # and keep booting the installed version (the update retries
            # next run). The hard fail() stays reserved for a fresh clone
            # with no local copy at all (handled above). Returning False
            # tells install_and_build "not updated, don't rebuild" — exactly
            # right for continuing with the existing build.
            detail = (
                explain_git_failure(r)
                if r is not None
                else "command exited with code —\n\n(git produced no output; the update\ncommand timed out or could not start)\n\n"
                     "Diagnosis: the update itself failed — the local copy is untouched.\n"
                     "Fix: check your internet connection (or VPN/proxy) and re-run."
            )
            if _local_build_available():
                warn(redact(detail))
                note("continuing with the currently installed version — the update will retry next run")
                return False
            fail("updating ACUTE-CODE to the latest version", detail)
        new_head = run(["git", "rev-parse", "--short", "HEAD"],
                       cwd=APP_DIR, env=git_env(env)).stdout.strip()
        if realigned:
            ok(f"updated (realigned)  ·  {state['head']} → {new_head}")
        else:
            ok(f"updated  ·  {state['head']} → {new_head}  ·  {state['behind']} new commit(s)")
        return True


def install_and_build(env, updated):
    if updated or not (APP_DIR / "node_modules").exists():
        with step("Installing dependencies (first time takes a few minutes)"):
            run(["pnpm", "install"], cwd=APP_DIR, env=env, timeout=1800)
            ok("dependencies ready")
    else:
        with step("Dependencies"):
            ok("already installed (nothing to do)")

    if updated or not (APP_DIR / "agent-core" / "dist" / "main.js").exists():
        with step("Building the backend (agent-core + shared)"):
            run(["pnpm", "--filter", "shared", "run", "build"], cwd=APP_DIR, env=env, timeout=900)
            run(["pnpm", "--filter", "agent-core", "run", "build"], cwd=APP_DIR, env=env, timeout=900)
            ok("backend build ready")
    else:
        with step("Backend build"):
            ok("already built (nothing to do)")


def write_env_file():
    with step("Browser wiring (.env.development)"):
        if ENV_PATH.exists():
            ok("present — kept as-is")
            return
        ENV_PATH.write_text(
            "# Written by the ACUTE-CODE launcher — safe to delete, regenerated.\n"
            "VITE_ACUTE_BASE_URL=http://127.0.0.1:5178\n"
            "VITE_ACUTE_TOKEN=acute-dev-local\n",
            encoding="utf-8",
        )
        ok("written (gitignored, survives updates)")


def self_update_check():
    """If the repo ships a newer launcher, copy it over and RE-RUN it now.

    R56: the old contract was "takes effect on the NEXT double-click" — which
    meant every launcher improvement (R55's What's-new panel, R56's
    app-or-site question, any failure-handling fix) arrived exactly one run
    LATE: the run that upgraded the app was still driven by the previous
    launcher's logic. The fresh copy is now exec'd in place, so the new code
    drives THIS session. The re-exec carries the original arguments and an
    env guard (ACUTE_LAUNCHER_REEXEC=1) that breaks any pathological loop —
    if the hashes STILL differ on the second pass, we warn and continue with
    the running code instead of exec'ing again.
    """
    with step("Launcher self-update check"):
        repo_copy = APP_DIR / "launcher" / "acute_launcher.py"
        if not repo_copy.exists():
            note("no launcher copy in the repo — skipping")
            return

        def sha(p):
            return hashlib.sha256(Path(p).read_bytes()).hexdigest()

        mine = Path(__file__).resolve()
        if sha(mine) == sha(repo_copy):
            ok("launcher is current")
            return
        try:
            shutil.copy2(repo_copy, mine)
        except OSError as exc:
            warn(f"could not copy the newer launcher ({exc.__class__.__name__}) — it stays for the next run")
            return
        ok("a newer launcher was delivered with this update — copied over")

        bat_repo = APP_DIR / "launcher" / "ACUTE.bat"
        mine_bat = LAUNCHER_DIR / "ACUTE.bat"
        if bat_repo.exists() and (not mine_bat.exists() or sha(mine_bat) != sha(bat_repo)):
            warn("ACUTE.bat also changed — please re-download it from the repo's launcher/ folder (or the latest launcher kit)")

        if os.environ.get("ACUTE_LAUNCHER_REEXEC") == "1":
            # Loop guard: the copy happened but the hashes still mismatch
            # (should be impossible in one run) — never exec twice.
            warn("launcher still differs after a re-exec — continuing with the current code")
            return
        note("restarting the launcher with the new version (same window)…")
        log("self-update: re-exec'ing the fresh launcher with args={}".format(sys.argv[1:]))
        try:
            sys.stdout.flush()
            sys.stderr.flush()
            env = dict(os.environ)
            env["ACUTE_LAUNCHER_REEXEC"] = "1"
            os.execve(sys.executable, [sys.executable, str(mine)] + list(sys.argv[1:]), env)
        except OSError as exc:
            # exec failed (rare) — the update still applies next run.
            warn(f"could not restart in place ({exc.__class__.__name__}) — the new version runs on the next double-click")


# ─────────────────────────────────────────────────────────────────────────────
# ROUND-56 (R56): the launch-mode question — app or site?
#
# The owner asked for this explicitly after the desktop engine failed and the
# launcher gave no way to choose: "in the acute.bat it should ask how to
# launch the app or the site". One question, asked once per interactive run
# AFTER the update pass (so the freshly self-updated launcher asks it — the
# re-exec above guarantees the new code is live). Enter = the last choice;
# `ACUTE.bat app` / `ACUTE.bat site` (or --app / --site) skip the question.
# ─────────────────────────────────────────────────────────────────────────────

def _load_launch_pref():
    """The remembered choice ('desktop' | 'site'), or None when never set."""
    try:
        data = json.loads(PREF_PATH.read_text(encoding="utf-8"))
        mode = data.get("mode")
        return mode if mode in ("desktop", "site") else None
    except (OSError, ValueError):
        return None


def _save_launch_pref(mode):
    """Best-effort persistence — a locked folder must never block a launch."""
    try:
        PREF_PATH.write_text(json.dumps({"mode": mode}, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def resolve_launch_mode(cmd):
    """How this run launches ACUTE-CODE: 'desktop', 'site', or None = ASK.

    Precedence: explicit command (app/desktop vs site/web — R63: reinstall
    and repair resolve to the desktop flow with a forced full reinstall) →
    explicit flag (--app/--desktop vs --site/--web/--no-desktop; R63:
    --reinstall forces the desktop flow) → non-Windows is always 'site'
    (the packaged app is Windows-only) → non-interactive stdin uses the
    remembered choice (or desktop on first contact) → interactive runs
    return None so main() asks the question.
    """
    if cmd in ("status", "update", "uninstall"):
        return None  # these never launch anything
    if cmd in DESKTOP_COMMANDS or cmd in REINSTALL_COMMANDS:
        return "desktop"
    if cmd in SITE_COMMANDS:
        return "site"
    flags = set(sys.argv[1:])
    if "--app" in flags or "--desktop" in flags or "--reinstall" in flags:
        return "desktop"
    if "--site" in flags or "--web" in flags or "--no-desktop" in flags:
        return "site"
    if not IS_WIN:
        return "site"
    if not sys.stdin.isatty():
        return _load_launch_pref() or "desktop"
    return None  # ask


def ask_launch_mode():
    """The R56 question: launch the desktop app or the site in the browser?

    Returns 'desktop' or 'site' and remembers the choice as the next Enter
    default. Unrecognized answers re-ask (three tries), then fall back to
    the default — a question can never brick a launch. EOF (closed stdin)
    takes the default.
    """
    saved = _load_launch_pref()
    default = "site" if saved == "site" else "desktop"
    default_hint = "site (your last choice)" if saved == "site" else "desktop app"
    panel(
        "How do you want to use ACUTE-CODE today?\n"
        "\n"
        "  [1]  Desktop app    the packaged window with the embedded\n"
        "                      browser + the bundled engine (recommended)\n"
        "  [2]  Site           the local servers + your browser\n"
        "                      at http://localhost:5173\n"
        "\n"
        f"Enter = {default_hint}. Your answer is remembered as the default.\n"
        "Skip this question next time:  ACUTE.bat app   or   ACUTE.bat site",
        title="launch mode",
    )
    answers_desktop = {"1", "d", "a", "app", "desktop"}
    answers_site = {"2", "s", "w", "web", "site", "browser"}
    prompt = "Launch how? [1=desktop app / 2=site] "
    for _ in range(3):
        try:
            answer = input(prompt).strip().lower()
        except EOFError:
            answer = ""
        except KeyboardInterrupt:
            print()
            warn("cancelled — launching the default ({})".format("site" if default == "site" else "desktop app"))
            answer = ""
        if answer == "":
            choice = default
            break
        if answer in answers_desktop:
            choice = "desktop"
            break
        if answer in answers_site:
            choice = "site"
            break
        warn("didn't catch that — answer 1 (desktop app) or 2 (site in the browser)")
    else:
        choice = default
    _save_launch_pref(choice)
    ok("launch mode: " + ("the desktop app (packaged, embedded browser)" if choice == "desktop" else "the site (local servers + browser)"))
    return choice


def _ask_engine_recourse():
    """R56: the packaged app's engine did not come up — what next?

    Returns 'retry' | 'site' | 'keep'. The default (Enter) retries once;
    'site' falls through to the dev-servers flow so a desktop-engine hiccup
    can never leave the owner without a working app — the exact experience
    the owner asked for when the engine kept failing with no way out.
    """
    panel(
        "The desktop app started, but its engine did not report ready.\n"
        "\n"
        "  [1]  Retry the desktop app    close it and start it again\n"
        "                                 (a cold boot can simply be slow)\n"
        "  [2]  Use the SITE instead     the browser flow at\n"
        "                                 http://localhost:5173 — same app,\n"
        "                                 local servers\n"
        "  [3]  Keep the desktop app     its offline screen shows the engine\n"
        "                                 log + Restart-engine + Copy\n"
        "                                 diagnostics — report it and keep\n"
        "                                 the window for the log\n"
        "\n"
        "Enter = retry. The engine log tail is printed above/below this panel\n"
        "— it is also saved in %APPDATA%\\acute-code\\sidecar.log.",
        style="yellow",
        title="engine did not come up",
    )
    answers = {
        "1": "retry", "r": "retry", "retry": "retry",
        "2": "site", "s": "site", "site": "site", "web": "site",
        "3": "keep", "k": "keep", "keep": "keep",
    }
    for _ in range(3):
        try:
            answer = input("What now? [1=retry / 2=site / 3=keep] ").strip().lower()
        except EOFError:
            answer = ""
        except KeyboardInterrupt:
            print()
            answer = ""
        if answer == "":
            return "retry"
        if answer in answers:
            return answers[answer]
        warn("answer 1 (retry), 2 (site in the browser) or 3 (keep the desktop app)")
    return "retry"


# ─────────────────────────────────────────────────────────────────────────────
# ROUND-51 (R51-a): the DESKTOP app path (Windows installer from GitHub)
#
# The owner's recurring "browser still broken" reports all had one root cause:
# this launcher ran the DEV stack (vite :5173) and opened the SYSTEM browser,
# where `window.__TAURI__` is undefined and the R50 native embedded browser
# (Tauri child webviews = real Chromium) can NEVER activate. The fix is the
# CI-built NSIS installer (.github/workflows/release.yml → desktop-installer
# job): one setup.exe with the app + the bundled sidecar (pinned node.exe +
# agent-core, ADR-0009). This section downloads it from the GitHub release,
# installs it silently, seeds Credential Manager with the owner's keys, and
# launches the installed exe. EVERY failure falls back to the dev-servers
# flow below — nothing the old launcher did is removed.
# ─────────────────────────────────────────────────────────────────────────────

# The tauri-bundler NSIS contract: <productName>_<version>_<arch>-setup.exe.
DESKTOP_INSTALLER_RE = re.compile(r"^ACUTE-CODE_(\d+\.\d+\.\d+)_x64-setup\.exe$")
DESKTOP_EXE_NAME = "ACUTE-CODE.exe"
# Where the tauri NSIS template (installer.nsi, verified against tauri
# 2.11.5) writes its uninstall entry: UNINSTKEY = "Software\Microsoft\
# Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" under HKCU for
# installMode=currentUser. The identifier / cargo-name variants are probed
# defensively in case a future bundler rename changes the key shape.
DESKTOP_UNINSTALL_KEYS = (
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\ACUTE-CODE",
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\com.acutecode.app",
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\acute-code",
)
DESKTOP_INSTALL_TIMEOUT_S = 600


def _version_tuple(text):
    """'0.51.0' → (0, 51, 0) for honest ordering; unparseable → (0, 0, 0)."""
    try:
        return tuple(int(p) for p in str(text).strip().split("."))
    except (ValueError, TypeError):
        return (0, 0, 0)


def _version_norm(text):
    """R63: '0.63.0.0' → (0, 63, 0) — Windows FileVersion pads a fourth
    zero component; padding zeros beyond the third are stripped so
    0.63.0 == 0.63.0.0 and version EQUALITY (as opposed to ordering) can
    be trusted while 0.63.0 ≠ 0.63."""
    try:
        parts = [int(p) for p in str(text).strip().split(".")]
    except (ValueError, TypeError):
        return (0,)
    while len(parts) > 3 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


# R63: the sticky repair note — written when a launched engine reports the
# WRONG version, read at the top of every desktop flow. It survives the run
# (unlike a variable) so the self-heal happens on the NEXT double-click even
# if this one ended with the owner keeping the app open.
REPAIR_FLAG_PATH = DOT_DIR / "desktop-repair-flag.json"


def _read_repair_flag():
    """The expected version a past launch failed to run, or None."""
    try:
        data = json.loads(REPAIR_FLAG_PATH.read_text(encoding="utf-8"))
        expected = data.get("expected")
        return expected if isinstance(expected, str) else None
    except (OSError, ValueError):
        return None


def _write_repair_flag(expected):
    """Best-effort — a locked .acute dir must never block a launch."""
    try:
        DOT_DIR.mkdir(parents=True, exist_ok=True)
        REPAIR_FLAG_PATH.write_text(
            json.dumps({"expected": expected}, indent=2) + "\n", encoding="utf-8"
        )
        log(f"repair flag set: expected engine {expected}")
    except OSError:
        pass


def _clear_repair_flag():
    """Remove the flag once an install is verified current."""
    try:
        REPAIR_FLAG_PATH.unlink(missing_ok=True)
    except OSError:
        pass


def _desktop_exe_version(exe):
    """R63: the installed EXE's real FileVersion (PowerShell VersionInfo).

    The registry's DisplayVersion is metadata the INSTALLER writes; the exe
    on disk is the truth. A silent install that ran while the app was still
    closing can bump the registry while leaving the old exe locked in
    place — exactly the "not updated properly" hybrid the owner reported.
    Returns '' when the probe fails (never crashes the launcher).
    """
    if not IS_WIN or not exe:
        return ""
    quoted = str(exe).replace("'", "''")
    ps = f"(Get-Item -LiteralPath '{quoted}').VersionInfo.FileVersion"
    code, out = probe(["powershell", "-NoProfile", "-Command", ps], timeout=25)
    if code != 0:
        return ""
    return out.strip().strip('"')


def _desktop_health_version(port, attempts=3):
    """R63: GET the running engine's token-free /health → its version.

    The sidecar reports the version of the package.json it booted from —
    the third leg of the version-truth chain (registry + exe + engine).
    Returns the version string, or None when the engine does not answer
    (honest skip, not an error: the launch verdict is the watcher's job).
    """
    url = f"http://127.0.0.1:{port}/health"
    for _ in range(attempts):
        try:
            with urlopen(url, timeout=2.5) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace") or "{}")
            version = data.get("version")
            return version if isinstance(version, str) else None
        except Exception:  # noqa: BLE001 — engine may still be binding
            time.sleep(1.0)
    return None


# R54: the two tauri resource layouts seen across bundler versions — resources
# land either directly in the install dir or under a resources/ subfolder.
def _desktop_resource_candidates(base, *relative):
    """Existing <base>/<relative> or <base>/resources/<relative>, newest-check
    order. Returns the first that EXISTS, else the last candidate (for the
    missing-file report)."""
    paths = [base.joinpath(*relative), base.joinpath("resources", *relative)]
    for path in paths:
        if path.is_file():
            return path
    return paths[-1]


def _desktop_install_files(installed):
    r"""R54: verify the install ON DISK, not just in the registry.

    The owner's post-mortem: after deleting AppData\Local\ACUTE-CODE by hand,
    the launcher still said 'installed desktop app 0.53.0 is current' (the
    NSIS uninstall entry survives folder deletion) and then silently fell
    back to the dev-servers flow because the exe was gone — instead of just
    REINSTALLING. Returns (exe_or_None, missing_labels): the exe is returned
    only when the app binary, the pinned node.exe runtime, and the sidecar
    entry all exist.
    """
    base = Path(installed["location"])
    exe = base / DESKTOP_EXE_NAME
    node = _desktop_resource_candidates(base, "sidecar", "node.exe")
    entry = _desktop_resource_candidates(base, "sidecar", "app", "dist", "main.js")
    missing = []
    if not exe.is_file():
        missing.append(DESKTOP_EXE_NAME)
    if not node.is_file():
        missing.append("sidecar/node.exe")
    if not entry.is_file():
        missing.append("sidecar/app/dist/main.js")
    if missing:
        return None, missing
    return exe, []


def _desktop_stop_running(installed):
    """R54: close every process whose executable lives inside the install dir.

    A running app locks the files the silent installer must replace (upgrades
    on top of a live instance can leave a hybrid install), and launching over
    a live instance opens a second window. Precise by design: it kills the app
    AND its bundled sidecar node.exe (their ExecutablePath is under the
    install dir) but never anyone else's node. Best-effort — failures warn.
    """
    if not IS_WIN:
        return
    location = str(installed["location"]).replace("'", "''")
    # NOTE: '\\*' in this Python literal is a single backslash + wildcard —
    # the PowerShell -like pattern '<install-dir>\*' matches every executable
    # under the install dir (the app + its bundled node.exe, nobody else's).
    ps = (
        "$procs = Get-CimInstance Win32_Process -Filter \"ExecutablePath IS NOT NULL\" | "
        f"Where-Object {{ $_.ExecutablePath -like '{location}\\*' }}; "
        "if ($procs) { "
        "$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; "
        "Write-Output 'stopped' }"
    )
    code, out = probe(["powershell", "-NoProfile", "-Command", ps], timeout=30)
    if code == 0 and out and "stopped" in out:
        ok("closed the running desktop app (relaunching it fresh)")
        time.sleep(1.0)
        return
    # Fallback: at least the app itself, by image name (no sidecar knowledge).
    code2, _ = probe(["taskkill", "/IM", DESKTOP_EXE_NAME, "/F"], timeout=15)
    if code2 == 0:
        ok("closed the running desktop app (relaunching it fresh)")
        time.sleep(1.0)


def _desktop_wait_for_exit(installed, timeout_s=20):
    """R63: Stop-Process is asynchronous — poll until the processes are GONE.

    The hybrid-install root cause: the old flow killed the app and slept a
    fixed 1s; Windows had often not released the file locks yet, the silent
    NSIS install replaced what it could, bumped the registry — and left the
    OLD exe in place. Waiting on actual process existence (not on guesses
    about lock timing) is the honest wait. Returns True when clear.
    """
    if not IS_WIN:
        return True
    location = str(installed["location"]).replace("'", "''")
    ps = (
        "$procs = Get-CimInstance Win32_Process -Filter \"ExecutablePath IS NOT NULL\" | "
        f"Where-Object {{ $_.ExecutablePath -like '{location}\\*' }}; "
        "if ($procs) { Write-Output 'busy' } else { Write-Output 'clear' }"
    )
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        code, out = probe(["powershell", "-NoProfile", "-Command", ps], timeout=15)
        if code == 0 and out and "clear" in out:
            return True
        time.sleep(1.0)
    warn(
        f"the desktop app's processes did not fully exit within {timeout_s}s — "
        "the installer may hit locked files"
    )
    return False


def _desktop_uninstall(installed):
    """R63: remove the desktop app COMPLETELY (owner directive: "if it needs
    to delete it completely, then it will delete it completely and reinstall
    if needed").

    Sequence: stop + wait for exit → run the bundled NSIS uninstaller
    SILENTLY and SYNCHRONOUSLY (the `_?=<dir>` argument pins it to the
    install dir — without it the uninstaller copies itself to %TEMP% and
    returns before removing anything) → sweep residue (an uninstaller can
    never delete the directory it is running from) → drop the uninstall
    registry entries (R54 post-mortem: a hand-deleted folder leaves them
    behind, which used to fool the launcher into "is current").

    The owner's DATA (%APPDATA%\\acute-code — agents, sessions, projects,
    settings) is never touched: only the program files go. Returns True
    when the install dir is gone.
    """
    if not IS_WIN:
        return False
    _desktop_stop_running(installed)
    _desktop_wait_for_exit(installed)
    base = Path(installed["location"])
    uninstaller = base / "uninstall.exe"
    if uninstaller.is_file():
        log(f"$ silent uninstall: {uninstaller} /S _?={base}")
        probe([str(uninstaller), "/S", f"_?={base}"], timeout=300)
    else:
        note("no bundled uninstall.exe found — removing the folder directly")
    if base.exists():
        run(["cmd", "/c", "rd", "/s", "/q", str(base)], check=False, timeout=180)
    # Belt and suspenders: stale uninstall entries must not resurrect a
    # deleted install on the next _desktop_find_installed() probe.
    for hive in ("HKCU", "HKLM"):
        for key in DESKTOP_UNINSTALL_KEYS:
            run(["reg", "delete", f"{hive}\\{key}", "/f"], check=False, timeout=15)
    if base.exists():
        warn(f"could not fully remove {base} (a file is still locked — close the app and run this again)")
        return False
    ok(f"removed the desktop app completely ({base})")
    note("your agents, sessions and settings (%APPDATA%\\acute-code) are untouched")
    return True


def _desktop_watch_engine(proc, timeout_s=75):
    r"""R54→R56→R63: watch the freshly launched app's engine through sidecar.log.

    The app's Rust shell appends every lifecycle line to
    %APPDATA%\acute-code\sidecar.log; 'listening on 127.0.0.1:<port>' means
    agent-core is up. This turns the launcher window into a first-run smoke
    test — the owner SEES the engine come up (or the log tail when it does
    not) instead of a console that went quiet while the app window shows its
    offline screen.

    R56 returns an OUTCOME so desktop_flow can offer recourse:
      'up'         — engine listening (the line every round has chased)
      'failed'     — the app logged a startup failure (tail printed)
      'timeout'    — no verdict in time — R56 now prints the log tail here
                     too (the old timeout was blind: no diagnostic at all,
                     exactly the shape that hid EISDIR for three sessions)
      'app-exited' — the desktop process itself died

    R63 ALSO returns the engine's /health version when the outcome is 'up'
    (None otherwise) — the third leg of the version-truth chain: the
    registry, the exe on disk, AND the booted engine must all agree with
    the release before the update counts as landed.
    """
    appdata = os.environ.get("APPDATA")
    if not IS_WIN or not appdata:
        return ("up" if proc.poll() is None else "app-exited"), None
    log_file = Path(appdata) / "acute-code" / "sidecar.log"
    try:
        start_size = log_file.stat().st_size if log_file.is_file() else 0
    except OSError:
        start_size = 0
    deadline = time.time() + timeout_s
    fresh_lines: list = []
    while time.time() < deadline:
        if proc.poll() is not None:
            warn(f"the desktop app exited on its own (code {proc.returncode})")
            return "app-exited", None
        time.sleep(1.5)
        try:
            if not log_file.is_file():
                continue
            size = log_file.stat().st_size
            if size < start_size:  # rotated/truncated → read everything
                start_size = 0
            with log_file.open("rb") as fh:
                fh.seek(start_size)
                fresh = fh.read().decode("utf-8", "replace")
            fresh_lines = [line for line in fresh.splitlines() if line.strip()]
        except OSError:
            continue
        match = re.search(r"listening on 127\.0\.0\.1:(\d+)", fresh)
        if match:
            port = int(match.group(1))
            ok(f"agent-core is up — sidecar listening on port {port}")
            engine_version = _desktop_health_version(port)
            if engine_version:
                ok(f"engine /health reports version {engine_version}")
            else:
                note("engine /health did not answer — the running-version check is skipped")
            return "up", engine_version
        if "startup failed" in fresh:
            warn("the app reports an engine startup failure — its log tail:")
            _print_engine_tail(fresh_lines)
            note("the same log is shown inside the app (offline screen → Copy diagnostics)")
            return "failed", None
    warn(
        f"agent-core did not report ready within {timeout_s}s — the engine's last output:"
    )
    _print_engine_tail(fresh_lines)
    note("the app window shows the live status (its offline screen has Restart-engine + Copy diagnostics)")
    return "timeout", None


def _print_engine_tail(lines, limit=14):
    """R56: the engine's own last words, capped and one line each. Empty when
    the log has nothing fresh (install the tail — silence is itself a clue)."""
    if not lines:
        note("(no fresh engine log lines — the engine produced no output at all)")
        return
    for line in lines[-limit:]:
        note(line.strip()[:200])


def _desktop_find_installed():
    """Probe the HKCU/HKLM uninstall registry for the installed desktop app.

    Returns {'version': str, 'location': str} or None. Uses `reg query`
    (stdlib subprocess — this launcher never grows dependencies). The tauri
    NSIS template writes InstallLocation QUOTED ("$INSTDIR"), so quotes are
    stripped before the path is used.
    """
    for hive in ("HKCU", "HKLM"):
        for key in DESKTOP_UNINSTALL_KEYS:
            code, out = probe(["reg", "query", f"{hive}\\{key}"], timeout=15)
            if code != 0 or not out:
                continue
            values = {}
            for line in out.splitlines():
                m = re.match(r"\s+(\w+)\s+REG_SZ\s+(.*)$", line)
                if m:
                    values[m.group(1)] = m.group(2).strip()
            if "InstallLocation" not in values:
                continue
            location = values["InstallLocation"].strip().strip('"')
            if location:
                return {
                    "version": values.get("DisplayVersion", ""),
                    "location": location,
                }
    return None


def _pick_latest_release(releases):
    """R74: the newest installer-bearing release, chosen by MAX VERSION —
    never by list order.

    Root cause this function exists (owner round-74 report: "the installed
    desktop app version was 0.67.0 — it did not update"): GitHub's
    /releases list sorts never-published DRAFTS above every published
    release — the round-63..67 close-outs left five drafts (v0.63.0 …
    v0.67.0) sitting at list positions 1-5 — and the old first-match walk
    returned draft v0.67.0 as "latest", so an installed 0.67.0 looked
    current while v0.73.0 was already live. This function walks EVERY
    entry, parses the version out of every matching installer asset and
    returns the numerically greatest one: immune to draft placement, to
    list order and to per_page truncation alike.

    Drafts remain first-class candidates (by design since R51: the owner's
    PAT can see them, so a fresh draft is installable immediately). A
    same-version tie — a draft and a published release coexisting —
    prefers the published entry: same bytes, but the one every token can
    see.

    Returns (version, asset_id, digest, info) with info = {"tag", "draft",
    "created"} for the version-truth panel, or None when no entry carries a
    matching installer asset. Pure: no I/O, no globals — pinned by
    launcher/tests/test_pick_latest_release.py.
    """
    best = None  # (version_tuple, published_rank, version, asset_id, digest, info)
    for release in releases:
        if not isinstance(release, dict):
            continue
        for asset in release.get("assets", []) or []:
            if not isinstance(asset, dict):
                continue
            m = DESKTOP_INSTALLER_RE.match(str(asset.get("name", "")))
            if not m or asset.get("id") is None:
                continue
            version = m.group(1)
            candidate = (
                _version_tuple(version),
                0 if release.get("draft") else 1,
                version,
                asset["id"],
                str(asset.get("digest") or ""),
                {
                    "tag": str(release.get("tag_name") or ""),
                    "draft": bool(release.get("draft")),
                    "created": str(release.get("created_at") or ""),
                },
            )
            if best is None or (candidate[0], candidate[1]) > (best[0], best[1]):
                best = candidate
    if best is None:
        return None
    return best[2], best[3], best[4], best[5]


def _desktop_latest_release(pat):
    """Newest GitHub release that carries a Windows installer asset.

    Returns (version_str, asset_id, digest, info) or None — the digest is
    GitHub's own server-side sha256 of the asset (R63: every download is
    verified against it, so a truncated/corrupt setup.exe can never reach
    the silent installer); info = {"tag", "draft", "created"} feeds the
    version-truth panel. Authenticated with the owner's PAT (the CI
    creates the release as a DRAFT — drafts are only visible to tokens
    with repo access, which the owner's launcher has).

    R74: the page is fetched with per_page=100 and the winner is chosen by
    MAX VERSION in _pick_latest_release — GitHub sorts never-published
    drafts ABOVE every published release, and the old first-match walk
    over that order froze the owner at v0.67.0 while v0.73.0 was live. One
    retry on a transient error (the download step's pattern). Never
    raises: offline/404/parse issues → None.
    """
    import json as _json
    import urllib.error

    url = "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases?per_page=100"
    releases = None
    for attempt in (1, 2):
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {pat}",
                "User-Agent": "acute-launcher",
                "Accept": "application/vnd.github+json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                releases = _json.loads(resp.read().decode("utf-8", "replace") or "[]")
            break
        except (urllib.error.URLError, OSError, ValueError) as exc:
            if attempt == 1:
                note(f"GitHub release check failed once ({exc.__class__.__name__}) — retrying")
                time.sleep(2)
            else:
                note(f"GitHub release check failed twice ({exc.__class__.__name__}) — falling back to the dev flow")
                return None
    if not isinstance(releases, list):
        return None
    return _pick_latest_release(releases)


def _desktop_digest_ok(path, digest):
    """R63: verify a downloaded file against the release asset's
    'sha256:<hex>' digest (computed by GitHub when the asset uploads)."""
    if not digest or not digest.lower().startswith("sha256:"):
        return True  # no digest published — the size check is all we have
    expected = digest.split(":", 1)[1].strip().lower()
    try:
        actual = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return False
    return actual == expected


def _desktop_download(pat, asset_id, version, digest=""):
    """Stream the installer asset into .acute/downloads/ (progress shown).

    Release assets download through the API endpoint with the PAT (a DRAFT
    release's assets are only reachable that way); the token is registered
    in SECRETS_TO_REDACT and never appears in logs or panels. R63: the
    finished file is VERIFIED against the asset's sha256
    digest and a mismatch triggers ONE full re-download — a corrupt
    installer can no longer reach the silent install step. Returns the
    local Path or None.
    """
    import urllib.error

    url = f"https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/{asset_id}"
    dest_dir = DOT_DIR / "downloads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"ACUTE-CODE_{version}_x64-setup.exe"
    for attempt in (1, 2):
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {pat}",
            "User-Agent": "acute-launcher",
            "Accept": "application/octet-stream",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp, dest.open("wb") as fh:
                total = int(resp.headers.get("Content-Length") or 0)
                done = 0
                chunk_mb = 4 * 1024 * 1024
                if RICH:
                    from rich.progress import Progress, BarColumn, DownloadColumn

                    with Progress(
                        "[bold cyan]downloading",
                        BarColumn(),
                        DownloadColumn(),
                        transient=True,
                    ) as progress:
                        task = progress.add_task("installer", total=total or None)
                        while True:
                            chunk = resp.read(chunk_mb)
                            if not chunk:
                                break
                            fh.write(chunk)
                            done += len(chunk)
                            progress.update(task, completed=done)
                else:
                    last_pct = -1
                    while True:
                        chunk = resp.read(chunk_mb)
                        if not chunk:
                            break
                        fh.write(chunk)
                        done += len(chunk)
                        if total:
                            pct = int(done * 100 / total)
                            if pct != last_pct and pct % 10 == 0:
                                print(f"       {pct}% ({done // (1024 * 1024)} MB)")
                                last_pct = pct
        except (urllib.error.URLError, OSError) as exc:
            note(f"installer download failed ({exc.__class__.__name__}: {redact(str(exc))[:120]})")
            return None
        if dest.stat().st_size < 1_000_000:
            # A setup.exe is >100 MB; anything tiny is an error page/API body.
            note("downloaded file is too small to be the installer — discarding")
            dest.unlink(missing_ok=True)
            return None
        if not _desktop_digest_ok(dest, digest):
            if attempt == 1:
                warn("the downloaded installer failed its sha256 integrity check — downloading it again")
                dest.unlink(missing_ok=True)
                continue
            note("the re-downloaded installer still fails its integrity check — discarding")
            dest.unlink(missing_ok=True)
            return None
        return dest
    return None


def _desktop_install(installer_path):
    """Run the NSIS installer silently (/S) and wait for it to finish.

    installMode=currentUser → RequestExecutionLevel user, no UAC prompt. The
    tauri template ABORTS a silent DOWNGRADE, which the caller prevents by
    only installing when the release version >= the installed one.
    """
    log(f"$ silent install: {installer_path.name} /S")
    try:
        proc = subprocess.run(
            [str(installer_path), "/S"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=DESKTOP_INSTALL_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        note(f"installer did not complete ({exc.__class__.__name__})")
        return False
    if proc.returncode != 0:
        note(f"installer exited with code {proc.returncode}")
        return False
    return True


def _print_whats_new(version):
    r"""R55: print the changelog entry for the version just installed.

    The owner asked for updates to communicate better — a silent version
    bump is indistinguishable from "nothing happened". The repo (already
    pulled current before this point) carries CHANGELOG.md; the matching
    version section's summary paragraph is printed so the console answers
    "what did this update change?" without opening anything.
    """
    changelog = APP_DIR / "CHANGELOG.md"
    try:
        text = changelog.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    match = re.search(
        rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.M | re.S
    )
    if not match:
        return
    lines = [ln.strip() for ln in match.group(1).splitlines() if ln.strip()]
    # Summary paragraph only — stop at the first ### subsection.
    body = []
    for ln in lines:
        if ln.startswith("#"):
            break
        body.append(ln)
    keep = body[:6]
    if len(body) > 6:
        keep.append("… full details: CHANGELOG.md in the repo")
    if keep:
        panel("\n".join(keep), style="cyan", title=f"What's new in {version}")


def desktop_flow(pat, force_reinstall=False):
    """Install + launch the packaged desktop app. True = it is running.

    Any failure prints a warning and returns False — the caller falls back
    to the dev-servers flow, so a desktop hiccup can never leave the owner
    without a working app.

    R54 hardening (owner post-mortem: 'installed desktop app 0.53.0 is
    current' followed by 'ACUTE-CODE.exe not found — using the dev-servers
    flow'): the registry is no longer trusted alone — the install is verified
    ON DISK (exe + pinned node.exe + the sidecar entry) and a broken install
    is REPAIRED by reinstalling instead of falling back; running instances
    are closed before install and launch; and the launched app's engine
    startup is watched through sidecar.log so this console shows the real
    engine state (or its error tail) instead of going silent.

    ROUND-63 — the version-TRUTH chain (owner: "the desktop application
    was not reinstalled properly, not updated properly"). The decision no
    longer trusts any ONE signal: the uninstall REGISTRY version, the
    installed EXE's FileVersion on disk, and — after launch — the running
    ENGINE's /health version are each compared with the latest GitHub
    release. A hybrid install (registry bumped, exe stale — what a silent
    install over a still-closing app leaves behind), a stale repair flag,
    or `ACUTE.bat reinstall` triggers a FULL removal (NSIS uninstaller +
    folder residue + stale registry entries) followed by a fresh install,
    which is then verified the same three ways. The app is closed AND
    process-waited before any install, and the download is sha256-checked
    against GitHub's asset digest. Data in %APPDATA% is never touched.
    """
    with step("Desktop app (packaged ACUTE-CODE)"):
        release = _desktop_latest_release(pat)
        if release is None:
            warn("no Windows installer published on GitHub yet — using the dev-servers flow")
            note("the installer ships with the next tagged release (round 51+)")
            return False
        version, asset_id, digest, rel_info = release
        installed = _desktop_find_installed()
        exe, missing = (
            _desktop_install_files(installed) if installed is not None else (None, [])
        )
        exe_version = _desktop_exe_version(exe)
        repair_expected = _read_repair_flag()

        # R63: the version-check panel the owner asked for — every signal
        # on the table BEFORE any decision is made. R74: the release line
        # names the tag it picked (and says when it is still a draft), so a
        # freeze like round-74's is visible on the owner's screen, not
        # silent.
        rel_src = ("draft " if rel_info.get("draft") else "") + (rel_info.get("tag") or "release")
        panel(
            "  latest installer on GitHub    " + version + f"  [{rel_src}]" + "\n"
            "  uninstall registry says       " + (installed["version"] if installed else "(not installed)") + "\n"
            "  installed exe on disk is      " + (exe_version or "(not found)") + "\n"
            "  install files                 " + ("complete" if not missing else "MISSING: " + ", ".join(missing))
            + ("\n  repair flag                   expects " + repair_expected if repair_expected else ""),
            title="desktop app version check",
        )

        exe_matches = bool(exe_version) and _version_norm(exe_version) == _version_norm(version)
        registry_current = (
            installed is not None
            and _version_tuple(installed["version"]) >= _version_tuple(version)
        )
        # The owner's app is NEWER than the newest release this token can
        # see (e.g. an unpublished draft) AND its exe agrees with the
        # registry — keep it; silently downgrading is never the policy.
        newer_than_release = (
            installed is not None
            and _version_tuple(installed["version"]) > _version_tuple(version)
            and bool(exe_version)
            and _version_norm(exe_version) == _version_norm(installed["version"])
        )

        uninstall_first = False
        reason = ""
        if force_reinstall:
            uninstall_first = True
            reason = f"reinstall requested — deleting the app completely and installing {version} fresh"
        elif repair_expected is not None:
            uninstall_first = True
            reason = (
                f"the last launch ran engine {repair_expected or 'unknown'} instead of "
                f"{version} — deleting the app completely and reinstalling"
            )
        elif installed is None:
            reason = f"installing the desktop app {version} (first time)"
        elif missing:
            uninstall_first = True
            reason = (
                "registry says {} is installed, but files are missing ({}) — reinstalling".format(
                    installed["version"], ", ".join(missing)
                )
            )
        elif newer_than_release:
            reason = (
                f"installed desktop app {installed['version']} is NEWER than the visible "
                f"release {version} — keeping it"
            )
        elif not exe_matches and registry_current:
            # THE hybrid case: the registry claims the new version but the
            # exe on disk is older (or unprobed) — the classic leftover of a
            # silent install that raced a closing app. Only a full delete +
            # reinstall can fix a half-replaced install.
            uninstall_first = True
            reason = (
                "hybrid install detected: the registry says {} but the exe on disk is {} "
                "— deleting it completely and reinstalling".format(
                    installed["version"], exe_version or "missing/unprobed"
                )
            )
        elif not registry_current:
            reason = f"upgrading the desktop app {installed['version']} → {version}"
        else:
            reason = ""

        if not reason:
            ok(f"installed desktop app {installed['version']} is current ({installed['location']})")
            note("verified: registry, exe on disk and the latest release all agree")
            _clear_repair_flag()
        else:
            ok(reason)
            if uninstall_first and installed is not None:
                if not _desktop_uninstall(installed):
                    warn("the old install could not be fully removed — installing over it now")
                installed = None
                exe = None
            # R63: close AND WAIT — a live instance locks the files the
            # installer must replace; the wait polls actual process
            # existence instead of guessing at lock timing.
            if installed is not None:
                _desktop_stop_running(installed)
                _desktop_wait_for_exit(installed)
            installer = _desktop_download(pat, asset_id, version, digest)
            if installer is None:
                warn("could not download the installer — using the dev-servers flow")
                return False
            if not _desktop_install(installer):
                warn("the silent installer failed — using the dev-servers flow")
                note("(download kept in .acute/downloads/ — you can run it by double-click)")
                return False
            installed = _desktop_find_installed()
            if installed is None:
                warn("the installer finished but no installed app was found — using the dev-servers flow")
                return False
            exe, missing = _desktop_install_files(installed)
            if missing:
                warn(
                    "the install is incomplete ({} missing) — using the dev-servers flow".format(
                        ", ".join(missing)
                    )
                )
                return False
            # R63 POST-INSTALL VERIFICATION: the registry AND the exe on disk
            # must both report the release version — anything else is a
            # hybrid install and gets one full delete-and-reinstall retry.
            exe_version = _desktop_exe_version(exe)
            registry_version = installed["version"] or ""
            verified = (
                (not exe_version or _version_norm(exe_version) == _version_norm(version))
                and (not registry_version or _version_norm(registry_version) == _version_norm(version))
            )
            if not verified:
                warn(
                    "the fresh install does not verify: registry {} / exe {} vs release {}".format(
                        registry_version or "(none)", exe_version or "(unprobed)", version
                    )
                )
                ok("deleting the app completely and reinstalling it once more")
                if _desktop_uninstall(installed) and _desktop_install(installer):
                    installed = _desktop_find_installed()
                    if installed is None:
                        warn("the second install left no installed app — using the dev-servers flow")
                        return False
                    exe, missing = _desktop_install_files(installed)
                    if missing:
                        warn(
                            "the second install is incomplete ({} missing) — using the dev-servers flow".format(
                                ", ".join(missing)
                            )
                        )
                        return False
                    exe_version = _desktop_exe_version(exe)
                    registry_version = installed["version"] or ""
                    verified = (
                        (not exe_version or _version_norm(exe_version) == _version_norm(version))
                        and (not registry_version or _version_norm(registry_version) == _version_norm(version))
                    )
                if not verified:
                    warn(
                        "the desktop install still does not verify after a full reinstall — "
                        "using the dev-servers flow (the next run will retry the repair)"
                    )
                    _write_repair_flag(version)
                    return False
            ok(f"installed {installed['version']} → {installed['location']}")
            note(f"verified: the exe on disk reports {exe_version or version}")
            # R55: tell the owner what actually changed — a silent version
            # bump reads as "nothing happened".
            _print_whats_new(version)
            _clear_repair_flag()

    # Credentials BEFORE launch: the app's Rust shell reads Credential
    # Manager at boot, so the keys must be in place before the exe starts.

    # R54: never launch a second instance on top of a live one.
    _desktop_stop_running(installed)

    # R56: launch + watch + RECOURSE. When the engine does not come up the
    # owner chooses what happens next (retry / switch to the site / keep the
    # app) instead of a launcher that silently waits on a dead console while
    # the app window shows its offline screen — the exact dead-end that
    # prompted "in the acute.bat it should ask how to launch the app or the
    # site".
    proc = None
    outcome = "app-exited"
    engine_version = None
    for attempt in range(1, 3):  # initial launch + one retry round
        with step("Starting the desktop app" if attempt == 1 else "Restarting the desktop app (retry)"):
            try:
                # DETACHED_PROCESS: the GUI app gets no console of ours and
                # survives this launcher window; we keep a handle to report
                # when it closes.
                creationflags = 0x00000008 if IS_WIN else 0  # DETACHED_PROCESS
                # R90-B1: hand the resolved token to the app via the
                # environment — the sidecar's update check (GET
                # /system/updates → readLauncherGithubPat) honors
                # ACUTE_GITHUB_PAT FIRST, so "Check for updates" works even
                # when the home file is missing or unreadable (the env layer
                # is the belt to the home-file suspenders; the Tauri shell
                # passes its environment down to the agent-core sidecar it
                # spawns). Only set when a token exists: env=None inherits
                # ours unchanged, and an EMPTY export would shadow a valid
                # saved file with nothing.
                launch_env = {**os.environ, "ACUTE_GITHUB_PAT": pat} if pat else None
                proc = subprocess.Popen(
                    [str(exe)], cwd=str(installed["location"]), creationflags=creationflags,
                    env=launch_env,
                )
            except OSError as exc:
                warn(f"could not start the desktop app ({exc.__class__.__name__}) — using the dev-servers flow")
                return False
            ok(f"ACUTE-CODE {installed['version']} is running (pid {proc.pid})")
            # R54: first-run smoke test — watch agent-core come up (or fail)
            # so this console tells the owner what the app window is doing.
            # R63: an 'up' outcome now also carries the engine's /health
            # version — the final leg of the version-truth chain.
            outcome, engine_version = _desktop_watch_engine(proc)
        if outcome == "up":
            # R63: the booted engine must BE the release version. A hybrid
            # install (new exe, old staged engine) would pass every disk
            # check yet still run the old code — this is the one place it
            # can be caught. Flag it for a full self-healing repair on the
            # next run instead of breaking the owner's session now.
            if engine_version and _version_norm(engine_version) != _version_norm(version):
                warn(
                    f"the running engine reports version {engine_version}, expected {version} — "
                    "the install is a hybrid"
                )
                ok("flagged: the next run deletes and reinstalls the app automatically "
                   "(or run ACUTE.bat reinstall now)")
                _write_repair_flag(version)
            else:
                _clear_repair_flag()
            break
        if attempt == 1:
            recourse = _ask_engine_recourse()
            log(f"engine outcome={outcome} → owner chose: {recourse}")
            if recourse == "site":
                warn("switching to the SITE (browser) — closing the desktop app first")
                _desktop_stop_running(installed)
                return False  # falls through to the dev-servers flow
            if recourse == "keep":
                note("keeping the desktop app — its offline screen has Restart-engine + Copy diagnostics")
                break
            # retry: close the just-launched instance (its engine is wedged)
            _desktop_stop_running(installed)
        else:
            warn("the engine still did not come up after the retry — the app window's offline screen has the full log + Restart-engine")
            note("(next run you can answer 2 at the launch question to use the site instead)")
    if outcome != "up" and proc is not None and proc.poll() is None:
        note("continuing with the desktop app as the owner chose — the in-app Restart-engine button re-runs the same handshake")
    panel(
        "The desktop app is running — the agent backend is bundled inside\n"
        "(no servers to manage, no browser tab: it is a real app window\n"
        "with the embedded Chromium browser).\n\n"
        "  ➜  NEXT TIME: double-click the ACUTE-CODE shortcut on your\n"
        "     Desktop, or run ACUTE.bat again — it updates everything,\n"
        "     then asks app-or-site (Enter keeps your last choice)\n"
        "  ➜  Keep this window open while using the app (Ctrl+C just\n"
        "     closes THIS window — the app keeps running)\n"
        "  ➜  Your keys were stored in Windows Credential Manager and are\n"
        "     picked up by the app automatically on every start\n"
        "  ➜  If the app shows \"Can't reach agent-core\", its offline\n"
        "     screen shows the engine log + Restart-engine + Copy\n"
        "     diagnostics; you can also run ACUTE.bat and choose the SITE",
        style="green",
        title="▲ ACUTE-CODE desktop app",
    )
    log(f"=== desktop launch {time.strftime('%Y-%m-%d %H:%M:%S')} exe={exe} ===")
    try:
        proc.wait()
        ok(f"desktop app closed (session {int(time.time() - STARTED)}s)")
    except KeyboardInterrupt:
        warn("launcher closed — the desktop app keeps running in its own window")
    wait_close()
    return True


# ─────────────────────────────────────────────────────────────────────────────
# modes
# ─────────────────────────────────────────────────────────────────────────────

def mode_status(pat, env):
    rule("status (read-only)")
    lines = []
    for name, cmd in (("git", ["git", "--version"]), ("Node.js", ["node", "--version"]),
                      ("Python", [sys.executable, "--version"])):
        code, out = probe(cmd)
        lines.append(f"{name:<10} {(out.splitlines() or ['?'])[0] if code == 0 else 'not found'}")

    code, out = probe(["pnpm", "--version"])
    lines.append(f"{'pnpm':<10} {(out.splitlines() or ['?'])[0] if code == 0 else 'not active yet (activated during setup)'}")

    lines.append("")
    if (APP_DIR / ".git").exists():
        state = repo_state(pat, env)
        if state:
            lines.append(f"app commit   {state['head']}"
                         + ("  (up to date)" if state["behind"] == 0
                            else f"  ({state['behind']} behind GitHub)" if state["behind"] > 0
                            else "  (GitHub unreachable)"))
            # R94-A: a diverged checkout (behind>0 AND ahead>0 — e.g. after
            # the public-migration history rewrite) says so up front: the
            # next update REALIGNS instead of pulling.
            if state["behind"] > 0 and state.get("ahead", 0) > 0:
                lines.append(f"             {state['ahead']} local commit(s) not on GitHub — the next update realigns to the published history")
            lines.append(f"app folder   {'MODIFIED locally' if state['dirty'] else 'clean'}  ·  {APP_DIR}")
            lines.append(f"dev database {'present — agents/sessions/projects persist' if (APP_DIR / '.dev' / 'acute.db').exists() else 'not created yet'}")
    else:
        lines.append("app          not downloaded yet (first run will fetch it)")
    # ROUND-51 (R51-a): the packaged desktop app, when installed (read-only
    # registry probe — never launches anything).
    # ROUND-63: the version-TRUTH status — registry, exe on disk, latest
    # release, and the repair flag, so "is my desktop app actually current?"
    # is answered read-only in one place.
    if IS_WIN:
        desktop = _desktop_find_installed()
        if desktop is not None:
            lines.append(f"desktop app  {desktop['version']} installed  ·  {desktop['location']}")
            exe, missing = _desktop_install_files(desktop)
            if missing:
                lines.append(f"  files     MISSING: {', '.join(missing)} — the next app launch reinstalls")
            elif exe:
                exe_version = _desktop_exe_version(exe)
                if exe_version:
                    agree = _version_norm(exe_version) == _version_norm(desktop["version"] or "")
                    lines.append(
                        f"  exe       {exe_version} on disk"
                        + ("" if agree else f"  ≠ registry {desktop['version']} — HYBRID, the next app launch repairs")
                    )
                else:
                    lines.append("  exe       version could not be probed")
        else:
            lines.append("desktop app  not installed (the next run will fetch the installer)")
        release = _desktop_latest_release(pat)
        if release is not None:
            release_version = release[0]
            rel_state = "draft, not yet published" if release[3].get("draft") else "published"
            installed_version = desktop["version"] if desktop is not None else "none"
            if desktop is None or _version_tuple(installed_version) < _version_tuple(release_version):
                lines.append(f"  release   {release_version} on GitHub ({rel_state}) — UPDATE PENDING (the next app launch installs it)")
            else:
                lines.append(f"  release   {release_version} on GitHub ({rel_state} — installed is current)")
        else:
            lines.append("  release   GitHub unreachable or no installer published")
        repair_expected = _read_repair_flag()
        if repair_expected:
            lines.append(f"  repair    flagged — the next app launch reinstalls (expects engine {repair_expected})")
    # R56: the remembered launch choice + the engine's last words — the two
    # facts that turn a vague "it failed" report into a diagnosable one.
    pref = _load_launch_pref()
    lines.append(f"launch mode  {'asks every run' if pref is None else pref + ' (saved default — ACUTE.bat app/site changes it)'}")
    if IS_WIN:
        appdata = os.environ.get("APPDATA")
        sidecar_log = Path(appdata) / "acute-code" / "sidecar.log" if appdata else None
        if sidecar_log is not None and sidecar_log.is_file():
            try:
                tail = [l for l in sidecar_log.read_text(encoding="utf-8", errors="replace").splitlines() if l.strip()]
                last_up = next((l for l in reversed(tail) if "listening on" in l), None)
                lines.append(
                    "engine log   {}  ·  last boot: {}".format(
                        sidecar_log,
                        (last_up.strip()[:100] if last_up else "no successful boot on record"),
                    )
                )
            except OSError:
                pass
        else:
            lines.append("engine log   no sidecar.log yet (the packaged app has never run)")
    lines.append(f"GitHub PAT   length {len(pat)}")
    lines.append("AI keys      saved in the app (Settings → Models & Providers)")

    busy = []
    for port in (UI_PORT, SIDECAR_PORT):
        if IS_WIN:
            code, out = probe(["netstat", "-ano", "-p", "tcp"])
            if code == 0 and out and re.search(rf":{port}\s+\S+\s+\S*\s+LISTENING", out):
                busy.append(f":{port} running")
        else:
            code, out = probe(["bash", "-c", f"lsof -t -i :{port}"])
            if code == 0 and out.strip():
                busy.append(f":{port} running")
    lines.append("servers      " + (", ".join(busy) if busy else "stopped"))
    lines.append(f"log          {LOG_PATH}")
    panel("\n".join(lines), title="ACUTE-CODE status")


def mode_uninstall():
    """R63: `ACUTE.bat uninstall` — remove the packaged desktop app cleanly.

    A dedicated removal command (owner: "maybe for deleting the application
    or the PC Windows application"): it closes the app, runs the bundled
    uninstaller, sweeps residue, and drops the stale uninstall-registry
    entries — the exact same routine desktop_flow's repair path uses. It
    needs NO credentials and NO toolchain (nothing is downloaded), and the
    owner's data (%APPDATA%\acute-code — agents, sessions, projects,
    settings) is always kept. Reinstall any time with `ACUTE.bat reinstall`
    (or just `ACUTE.bat app` — it installs on demand).
    """
    if not IS_WIN:
        panel(
            "The packaged desktop app is Windows-only — nothing to uninstall.\n"
            "(The dev flow lives in " + str(APP_DIR) + " and is removed by deleting that folder.)",
            style="yellow",
            title="uninstall",
        )
        return
    rule("uninstall (remove the packaged desktop app)")
    installed = _desktop_find_installed()
    if installed is None:
        panel(
            "The packaged desktop app is not installed (no uninstall entry found).\n\n"
            "Nothing to remove. The site/dev flow lives in:\n  " + str(APP_DIR) + "\n"
            "(delete that folder if you want it gone too)",
            style="yellow",
            title="uninstall",
        )
        log("uninstall: nothing installed")
        wait_close()
        return
    panel(
        "This removes the packaged ACUTE-CODE desktop app:\n\n"
        "  version    " + (installed["version"] or "(unknown)") + "\n"
        "  location   " + installed["location"] + "\n\n"
        "It will be closed first (if running), then fully deleted — including\n"
        "its registry entries. YOUR DATA IS KEPT: agents, sessions, projects\n"
        "and settings live in %APPDATA%\acute-code and are never touched.\n\n"
        "Reinstall any time:  ACUTE.bat reinstall   (delete + fresh install)\n"
        "or just              ACUTE.bat app      (installs on demand)",
        style="yellow",
        title="uninstall the desktop app",
    )
    if not confirm("Remove the desktop app now?", default=True):
        ok("uninstall cancelled — the app is untouched")
        wait_close()
        return
    if _desktop_uninstall(installed):
        _clear_repair_flag()
        panel(
            "The desktop app is fully removed.\n\n"
            "  ➜  Your agents, sessions and settings are kept in\n"
            "     %APPDATA%\acute-code\n"
            "  ➜  To use ACUTE-CODE again: double-click ACUTE.bat and answer\n"
            "     1 (desktop app) — it downloads and installs the current\n"
            "     release automatically — or 2 for the site in your browser",
            style="green",
            title="▲ uninstalled",
        )
    else:
        panel(
            "The app could not be fully removed — a file was still locked.\n"
            "Close the ACUTE-CODE window (and any terminal it opened), then\n"
            "run  ACUTE.bat uninstall  again — everything is idempotent.",
            style="yellow",
            title="uninstall incomplete",
        )
    wait_close()


def launch(env):
    with step("Launching ACUTE-CODE (sidecar :5178 + UI :5173)"):
        stop_live_servers("clean restart")
    panel(
        "Everything is ready. The servers are starting.\n\n"
        "  ➜  Your browser will OPEN http://localhost:5173 AUTOMATICALLY\n"
        "     as soon as the UI is up (no need to type it)\n"
        "  ➜  Keep this window open while using the app\n"
        "  ➜  Press Ctrl+C here to stop both servers cleanly\n\n"
        "Server output follows (live):",
        style="green",
        title="▲ ACUTE-CODE is starting",
    )
    log(f"=== launch {time.strftime('%Y-%m-%d %H:%M:%S')} ===")
    # ROUND-42 (owner: "add an auto-launch browser functionality. After
    # starting it will automatically launch the browser with that specific
    # URL so that I don't have to manually open up the browser"): a daemon
    # thread polls the UI port in the background while `pnpm dev:full`
    # blocks the main thread; once Vite answers it opens the user's default
    # browser at the app URL exactly once per launcher run.
    _spawn_browser_autolaunch()
    try:
        code = subprocess.call(wrap(["pnpm", "dev:full"]), cwd=str(APP_DIR), env=env)
    except KeyboardInterrupt:
        code = 0
    except FileNotFoundError:
        fail("starting the servers", "pnpm not found — rerun the launcher")
    if code == 0:
        ok(f"servers stopped cleanly (session {int(time.time() - STARTED)}s)")
        wait_close()
    else:
        fail(
            f"servers exited with code {code}",
            "Common causes:\n"
            "  • a port is still occupied (the launcher clears it on the next run)\n"
            "  • no AI provider key saved yet (Settings → Models & Providers in the app)\n"
            "  • a build step failed — see the log tail below",
        )


# ── ROUND-42: auto-open the browser once the dev servers are ready ──────────

_AUTO_LAUNCH_URL = f"http://localhost:{UI_PORT}"
_AUTO_LAUNCH_TIMEOUT_S = 240  # cold start: pnpm install + vite boot can be slow


def _http_ok(url, timeout=1.5):
    """True when the URL answers with any HTTP status (connection refused → False)."""
    try:
        urlopen(url, timeout=timeout)
        return True
    except Exception:  # noqa: BLE001 — any HTTP answer means the server is up
        # urlopen raises on 4xx/5xx too; a refused connection raises URLError.
        # Distinguish: an HTTP error still means SOMETHING is listening.
        import sys as _sys

        return "HTTPError" in type(_sys.exc_info()[1]).__name__


def _spawn_browser_autolaunch():
    """Daemon thread: poll the UI port → open the browser ONCE when ready."""

    def runner():
        deadline = time.time() + _AUTO_LAUNCH_TIMEOUT_S
        opened = False
        while not opened and time.time() < deadline:
            if _http_ok(_AUTO_LAUNCH_URL):
                opened = True
                try:
                    webbrowser.open(_AUTO_LAUNCH_URL)
                    log(f"auto-launch: opened {_AUTO_LAUNCH_URL} in the default browser")
                    print()
                    ok(f"browser opened automatically → {_AUTO_LAUNCH_URL}")
                except Exception as exc:  # noqa: BLE001 — never crash the launcher
                    warn(f"could not open the browser automatically ({exc}) — open {_AUTO_LAUNCH_URL} manually")
            else:
                time.sleep(1.0)
        if not opened:
            warn(
                f"servers did not answer on {_AUTO_LAUNCH_URL} within "
                f"{_AUTO_LAUNCH_TIMEOUT_S}s — open the URL manually once the UI is up"
            )

    threading.Thread(target=runner, name="acute-autolaunch", daemon=True).start()


# ─────────────────────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    cmd = args[0] if args else "run"

    banner()
    log(f"===== launcher start {time.strftime('%Y-%m-%d %H:%M:%S')} args={sys.argv[1:]} =====")

    # R63: `ACUTE.bat uninstall` removes the packaged desktop app — a purely
    # LOCAL operation. It needs NO credentials (nothing is downloaded), so
    # it runs before the GitHub token is needed (nothing is downloaded).
    if cmd == "uninstall":
        mode_uninstall()
        return

    pat = resolve_github_pat()
    register_secrets(pat, authed_url(pat))
    env = dict(os.environ)

    if cmd == "status":
        mode_status(pat, env)
        return

    with step("Verifying GitHub access (token + repository)"):
        validate_github_access(pat)

    # R56: the launch mode resolves AFTER the update pass (below), so the
    # freshly self-updated launcher — with its possibly-new question code —
    # is the code that asks. Explicit commands/flags never ask; non-Windows
    # is always the site; a terminal (interactive run) gets the question.
    launch_mode = resolve_launch_mode(cmd)
    # R63: reinstall/repair (command or --reinstall flag) forces the desktop
    # flow into its DELETE-and-fresh-install path.
    force_reinstall = cmd in REINSTALL_COMMANDS or "--reinstall" in sys.argv

    if launch_mode is None:
        # The ask is still pending — the plan shows BOTH possible paths so it
        # stays honest whichever way the owner answers.
        panel(
            "Here is the plan for this run:\n"
            "\n"
            "  1.  Verify GitHub access      done (above)\n"
            "  2.  Check for updates         keeps this launcher + the repo current\n"
            "  3.  Ask: app or site?         you choose (Enter keeps your last choice)\n"
            "  4.  Launch the chosen mode:\n"
            "        DESKTOP app             install/update + start the packaged\n"
            "                                window (embedded browser + engine) —\n"
            "                                the version is VERIFIED three ways\n"
            "                                (registry · exe on disk · engine)\n"
            "        SITE                    local servers + your browser\n"
            "                                at http://localhost:5173\n"
            "\n"
            "Either path falls back to the other when it fails, so a hiccup in\n"
            "one mode never leaves you without a running app. Skip the question\n"
            "next time:  ACUTE.bat app   or   ACUTE.bat site",
            title="the plan",
        )
    elif IS_WIN and launch_mode == "desktop":
        panel(
            "Here is the plan for this run:\n"
            "\n"
            "  1.  Verify GitHub access              done (above)\n"
            "  2.  Check for updates                 keeps this launcher + the repo current\n"
            + (
                "  3.  DELETE the desktop app           complete removal, then a fresh\n"
                "                                        install (reinstall requested)\n"
                if force_reinstall
                else "  3.  Check the app's version          registry · exe on disk · GitHub\n"
                "                                        release — a hybrid or stale install\n"
                "                                        is deleted and reinstalled\n"
            )
            +
            "  4.  Install / update the DESKTOP app  the packaged ACUTE-CODE with the\n"
            "                                        embedded browser + bundled backend\n"
            "  5.  Verify the install                the exe on disk + the registry must\n"
            "                                        match the release (sha256-checked\n"
            "                                        download; the engine's version is\n"
            "                                        checked after launch)\n"
            "  6.  Start the app                     a real app window — no browser tab\n"
            "  7.  Save your AI keys                in the app: Settings → Models &\n"
            "                                        Providers (once — the desktop app\n"
            "                                        stores them in Credential Manager)\n"
            "\n"
            "If the desktop install fails for ANY reason the launcher falls back\n"
            "to the site flow automatically — you always end up with a running\n"
            "app. Prefer the browser instead?  ACUTE.bat site\n"
            "Full delete + fresh install any time:  ACUTE.bat reinstall",
            title="the plan — desktop app",
        )
    else:
        if cmd in DESKTOP_COMMANDS or cmd in REINSTALL_COMMANDS:
            warn("the packaged desktop app is Windows-only — continuing with the site flow")
        panel(
            "Here is the plan for this run:\n"
            "\n"
            "  1.  Verify GitHub access              done (above)\n"
            "  2.  Check the toolchain               git · Node.js · pnpm — auto-installs when missing\n"
            "  3.  Download / update ACUTE-CODE      first run downloads it, later runs update it\n"
            "  4.  Install dependencies + build      skipped when already done\n"
            "  5.  Start the site                    open http://localhost:5173 in your browser\n"
            "     (save your AI keys in the app:     Settings → Models & Providers)\n"
            "\n"
            "Every step prints its result. If anything fails you get a red panel\n"
            "with the exact cause and the fix — the window stays open for copying.\n"
            "(Prefer the desktop window?  ACUTE.bat app)\n"
            "\n"
            "NOTE: the EMBEDDED BROWSER and COMPUTER USE are desktop-app\n"
            "features — they need the native webview and cannot run in a\n"
            "browser tab. Use  ACUTE.bat app  for those.",
            title="the plan — site in your browser",
        )

    check_toolchain()
    env = ensure_pnpm(env)

    if cmd != "start" and "--no-update" not in sys.argv:
        updated = clone_or_update(pat, env)
    else:
        with step("Update check skipped (start mode)"):
            updated = False

    self_update_check()

    if cmd == "update":
        rule()
        ok(f"update pass complete ({int(time.time() - STARTED)}s) — everything ready")
        note("double-click the launcher again — it asks app-or-site, then launches")
        wait_close()
        return

    # R56: ASK here — after the update + self-update re-exec, so the question
    # comes from the newest launcher code and reflects the current state.
    if launch_mode is None:
        launch_mode = ask_launch_mode()

    # ROUND-51 (R51-a): the DESKTOP path. Runs before install_and_build: a
    # successful desktop launch needs nothing built from the repo (the
    # installer bundles the backend). Any failure inside desktop_flow prints
    # a warning and returns False → the site flow below stays exactly as it
    # was — including the owner choosing it after an engine failure.
    # R63: force_reinstall routes desktop_flow through its delete-completely
    # + fresh-install path (ACUTE.bat reinstall / repair / --reinstall).
    if IS_WIN and launch_mode == "desktop":
        if desktop_flow(pat, force_reinstall=force_reinstall):
            return
        warn("falling back to the site flow (browser at http://localhost:5173)")

    install_and_build(env, updated)
    write_env_file()

    launch(env)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 — the window must never close silently
        import traceback

        fail("unexpected launcher error", traceback.format_exc())
