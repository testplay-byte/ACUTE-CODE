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
#   • reads credentials.txt next to itself (GITHUB_PAT + OPENROUTER_KEY, plus
#     the optional OPENROUTER_SUB1..3_KEY sub-agent pool keys; you fill it
#     once — the launcher never injects keys of its own — rotate/clear
#     values whenever you like)
#   • checks the toolchain and AUTO-INSTALLS what is missing
#     (git / Node.js via winget on Windows, with your confirmation;
#      pnpm is activated through corepack — no global installs)
#   • keeps your folder clean: launcher files stay at the top level, and
#     everything downloaded lives inside ./ACUTE-CODE (the app) and
#     ./.acute (credentials cache + logs) in the SAME directory
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
# Commands:  (default) update-check then launch   · start = no update pass
#            update = update only, then exit      · status = read-only report
# Flags:     --no-update   --verbose

import hashlib
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
CRED_PATH = LAUNCHER_DIR / "credentials.txt"
ENV_PATH = APP_DIR / ".env.development"
REPO_URL = "https://github.com/testplay-byte/ACUTE-CODE.git"
GIT_USER = "testplay-byte"
UI_PORT = 5173
SIDECAR_PORT = 5178
NODE_MIN_MAJOR = 20
STARTED = time.time()

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
# credentials
# ─────────────────────────────────────────────────────────────────────────────

SETUP_INSTRUCTIONS = """\
FIRST-TIME SETUP — 4 steps, about 2 minutes:

  1.  Create a folder anywhere (e.g.  C:\\ACUTE  )  — done, you are here.
  2.  Put exactly THREE files in it (from the private GitHub repo,
      folder  launcher/  → click each file → Raw → right-click → Save as):
        • ACUTE.bat            (the file you double-click)
        • acute_launcher.py    (the program doing all the work)
        • credentials.example.txt
  3.  Rename  credentials.example.txt  →  credentials.txt ,
      open it in Notepad, and paste your two values on the marked lines:
        GITHUB_PAT=...        (your GitHub token, starts with github_pat_)
        OPENROUTER_KEY=...    (your OpenRouter key, starts with sk-or-)
      Save. That file stays on YOUR PC only — never uploaded anywhere.
  4.  Double-click  ACUTE.bat . Watch the pretty terminal do the rest.

Later runs: just double-click ACUTE.bat — it checks GitHub for updates,
restarts the servers, and keeps all your data (agents/sessions/projects).
"""


# ─────────────────────────────────────────────────────────────────────────────
# credentials.txt
# ─────────────────────────────────────────────────────────────────────────────

# ROUND-44 introduced the three OPTIONAL sub-agent pool keys,
# OPENROUTER_SUB1_KEY / OPENROUTER_SUB2_KEY / OPENROUTER_SUB3_KEY. They map to
# keyring pool slots 2/3/4 (ACUTE_PROVIDER_OPENROUTER_SLOT{2,3,4}) — the exact
# slots Settings → Sub-agents shows and the orchestrator prefers for child
# runs, so the owner never pastes them into the UI by hand.
#
# ROUND-47 (owner directive 2026-08-29: "It should not be for you to paste in
# the Open Router API keys by default in it"): the R44 baked-in key defaults
# were REMOVED — the launcher must never ship or write real key material.
# ensure_subagent_keys() below now only keeps the three placeholder LINES
# present in credentials.txt so there is always an obvious place to paste
# pool keys; it never writes or rewrites values.
SUB_KEY_NAMES = ["OPENROUTER_SUB1_KEY", "OPENROUTER_SUB2_KEY", "OPENROUTER_SUB3_KEY"]
SUB_KEY_PLACEHOLDER = "sk-or-v1-PASTE_YOURS_HERE"


def read_credentials():
    """Parse credentials.txt → (github_pat, openrouter_key, sub_keys[3]).

    The three OPENROUTER_SUBn_KEY lines are OPTIONAL: a missing or
    placeholder-looking value becomes "" and the slot simply stays empty —
    sub keys never block startup. A malformed main PAT/key still fails the
    launch with precise instructions.
    """
    if not CRED_PATH.exists():
        panel(SETUP_INSTRUCTIONS, style="yellow", title="credentials.txt not found yet")
        log("no credentials.txt")
        wait_close()
        sys.exit(1)

    values = {}
    try:
        for raw in CRED_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            # ROUND-47 BUG FIX: the old pattern ^([A-Za-z_]+) could not match
            # names containing digits — OPENROUTER_SUB1/2/3_KEY lines were
            # silently NEVER parsed (the R44 pool keys only ever reached the
            # app through the baked-in defaults, and the owner's own file
            # values were ignored). Names: letter/underscore, then word chars.
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$", line)
            if m:
                values[m.group(1).upper()] = m.group(2).strip().strip('"').strip("'")
    except Exception as exc:
        fail("reading credentials.txt", f"{exc}\nPath: {CRED_PATH}")

    pat = values.get("GITHUB_PAT") or values.get("GITHUB_TOKEN") or ""
    key = values.get("OPENROUTER_KEY") or values.get("OPENROUTER_API_KEY") or ""

    def sub_value(name):
        v = (values.get(name) or "").strip()
        if not v or "PASTE_YOURS" in v.upper() or "YOUR_" in v.upper() or not v.startswith("sk-or-"):
            return ""
        return v

    sub_keys = [sub_value(name) for name in SUB_KEY_NAMES]

    def is_placeholder(v, kind):
        v = v.strip()
        if not v:
            return True
        if "PASTE_YOURS" in v.upper() or "YOUR_" in v.upper() or "XXX" in v.upper():
            return True
        return kind == "pat" and not v.startswith(("github_pat_", "ghp_", "gho_")) or \
               kind == "key" and not v.startswith("sk-or-")

    problems = []
    if is_placeholder(pat, "pat"):
        problems.append("GITHUB_PAT is missing/placeholder — paste your real token (starts with github_pat_).")
    if is_placeholder(key, "key"):
        problems.append("OPENROUTER_KEY is missing/placeholder — paste your real key (starts with sk-or-).")
    if problems:
        fail(
            "credentials.txt is incomplete",
            "\n".join(problems)
            + f"\n\nFile: {CRED_PATH}\nOpen it in Notepad, fill both lines, save, run again.",
        )

    log("credentials loaded (values never logged)")
    return pat, key, sub_keys


def ensure_subagent_keys(sub_keys):
    """ROUND-47: keep the three OPTIONAL sub-key lines present in the file.

    The owner asked for the pool keys to live INSIDE credentials.txt so they
    never paste them into the app — and (R47) for the launcher to never ship
    or inject key values of its own. So this now only appends clearly-marked
    placeholder lines when the file predates the sub-agent pool, giving the
    owner an obvious place to paste pool keys. Existing lines are NEVER
    touched — fill, rotate, or delete them at will. Returns sub_keys exactly
    as parsed. Skipped entirely for read-only modes (status) — the caller
    decides.
    """
    try:
        current = CRED_PATH.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        warn(f"could not read credentials.txt for sub-key check ({exc}) — skipping")
        return sub_keys

    missing = [
        name for name in SUB_KEY_NAMES
        if not re.search(rf"^{name}\s*=", current, re.MULTILINE)
    ]
    if not missing:
        set_count = sum(1 for k in sub_keys if k)
        ok(f"sub-agent key slots present in credentials.txt ({set_count}/3 set)")
        return sub_keys

    block = (
        "\n"
        "# ─── sub-agent pool keys (OPTIONAL — ROUND-47, safe to edit/remove) ───\n"
        "# Sub-agents use these first so your main key is not burdened.\n"
        "# Shown as pool slots 2/3/4 in Settings → Sub-agents.\n"
        "# Leave the placeholders to opt out (children fall back to the main key).\n"
    )
    block += "".join(f"{name}={SUB_KEY_PLACEHOLDER}\n" for name in missing)

    try:
        if current and not current.endswith("\n"):
            current += "\n"
        CRED_PATH.write_text(current + block, encoding="utf-8")
        ok(
            "sub-agent key slots added to credentials.txt "
            f"({', '.join(missing)}) — fill them or leave the placeholders"
        )
        note("placeholders are ignored — remove those lines any time")
    except Exception as exc:
        warn(f"could not add sub-key slots to credentials.txt ({exc})")
    return sub_keys


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
        if body.get("private") is False:
            warn("GitHub reports this repository as PUBLIC — please flag this to the owner (closed-source repo)")
        ok(f"token accepted  ·  repository visible ({'private' if body.get('private') else 'public'})")
        return True
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            fail(
                "GitHub token rejected",
                f"GitHub answered HTTP {exc.code}: the GITHUB_PAT in credentials.txt is invalid,\n"
                "expired, or revoked.\n\n"
                "How to fix (2 minutes):\n"
                "  1. Go to github.com → Settings → Developer settings →\n"
                "     Personal access tokens → Generate new token\n"
                "  2. Give it read access to the private repo testplay-byte/ACUTE-CODE\n"
                f"  3. Paste the new token into {CRED_PATH}  (the GITHUB_PAT= line)\n"
                "  4. Save and double-click the launcher again",
            )
        if exc.code == 404:
            fail(
                "repository not visible to this token",
                "The token itself is valid, but GitHub hides testplay-byte/ACUTE-CODE from it.\n"
                "It needs read access to that private repository\n"
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
            "Fix: open credentials.txt, replace the GITHUB_PAT line with a fresh",
            "token (github.com → Settings → Developer settings → Personal access",
            "tokens → it needs read access to the private repo), save, re-run.",
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
        return {"head": head, "behind": -1, "dirty": dirty}
    count = run(["git", "rev-list", "--count", "HEAD..FETCH_HEAD"],
                cwd=APP_DIR, env=genv, check=False).stdout.strip()
    return {"head": head, "behind": int(count or 0), "dirty": dirty}


def clone_or_update(pat, env):
    if not (APP_DIR / ".git").exists():
        with step("Downloading ACUTE-CODE from GitHub (first run)"):
            check_disk_space()
            if APP_DIR.exists():
                shutil.rmtree(APP_DIR)
            r = run(["git", "clone", authed_url(pat), str(APP_DIR)],
                    env=git_env(env), timeout=1800, check=False)
            if r.returncode != 0 or not (APP_DIR / ".git").exists():
                fail("downloading the ACUTE-CODE repository", explain_git_failure(r))
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
        r = run(["git", "pull", "--ff-only", authed_url(pat), "main"],
                cwd=APP_DIR, env=git_env(env), timeout=600, check=False)
        if r.returncode != 0:
            fail("updating ACUTE-CODE to the latest version", explain_git_failure(r))
        new_head = run(["git", "rev-parse", "--short", "HEAD"],
                       cwd=APP_DIR, env=git_env(env)).stdout.strip()
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


def distribute_key(key, sub_keys=("", "", "")):
    with step("OpenRouter key → secure store"):
        shown = f"length {len(key)}"
        if IS_WIN:
            script = APP_DIR / "scripts" / "credential.ps1"
            run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                 str(script), "Write", "ACUTE-CODE/provider/openrouter", "api-key", key],
                check=False, timeout=60,
            )
            ok(f"stored in Windows Credential Manager ({shown})")
        else:
            kf = Path.home() / ".acute" / "openrouter.key"
            kf.parent.mkdir(parents=True, exist_ok=True)
            kf.write_text(key + "\n", encoding="utf-8")
            try:
                os.chmod(kf, 0o600)
            except OSError:
                pass
            ok(f"stored at {kf} ({shown}, chmod 600)")
        note("the key is also injected directly into the servers at launch")

    # ROUND-44 (R44-d): the three sub-agent pool keys ride along — same secure
    # stores, slot-suffixed names. Absent keys are skipped silently (the pool
    # simply stays smaller and children fall back to the main key).
    if not any(sub_keys):
        return
    with step("Sub-agent keys → secure store (pool slots 2/3/4)"):
        for i, sub in enumerate(sub_keys):
            if not sub:
                continue
            slot = i + 2  # sub1 → slot 2, sub2 → slot 3, sub3 → slot 4
            shown = f"length {len(sub)}"
            if IS_WIN:
                script = APP_DIR / "scripts" / "credential.ps1"
                run(
                    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                     str(script), "Write", f"ACUTE-CODE/provider/openrouter-slot{slot}", "api-key", sub],
                    check=False, timeout=60,
                )
                ok(f"slot {slot} → Windows Credential Manager ({shown})")
            else:
                kf = Path.home() / ".acute" / f"openrouter-slot{slot}.key"
                kf.parent.mkdir(parents=True, exist_ok=True)
                kf.write_text(sub + "\n", encoding="utf-8")
                try:
                    os.chmod(kf, 0o600)
                except OSError:
                    pass
                ok(f"slot {slot} → {kf} ({shown}, chmod 600)")


def self_update_check():
    """If the repo ships a newer launcher, copy it over (takes effect next run)."""
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
        shutil.copy2(repo_copy, mine)
        ok("a newer launcher was delivered with this update — copied over")
        note("the new version takes effect on the NEXT double-click")

        bat_repo = APP_DIR / "launcher" / "ACUTE.bat"
        mine_bat = LAUNCHER_DIR / "ACUTE.bat"
        if bat_repo.exists() and (not mine_bat.exists() or sha(mine_bat) != sha(bat_repo)):
            warn("ACUTE.bat also changed — please re-download it from the repo's launcher/ folder")


# ─────────────────────────────────────────────────────────────────────────────
# modes
# ─────────────────────────────────────────────────────────────────────────────

def mode_status(pat, key, env, sub_keys=("", "", "")):
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
            lines.append(f"app folder   {'MODIFIED locally' if state['dirty'] else 'clean'}  ·  {APP_DIR}")
            lines.append(f"dev database {'present — agents/sessions/projects persist' if (APP_DIR / '.dev' / 'acute.db').exists() else 'not created yet'}")
    else:
        lines.append("app          not downloaded yet (first run will fetch it)")
    lines.append(f"GitHub PAT   length {len(pat)}")
    lines.append(f"Router key   length {len(key)}")
    # sub-agent pool presence (length only, never the value)
    sub_desc = ", ".join(
        f"slot {i + 2} {'set' if sub else '—'}" for i, sub in enumerate(sub_keys)
    )
    lines.append(f"Sub keys     {sub_desc}")

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


def launch(env, key, sub_keys=("", "", "")):
    with step("Launching ACUTE-CODE (sidecar :5178 + UI :5173)"):
        stop_live_servers("clean restart")
        if key:
            env["ACUTE_PROVIDER_OPENROUTER"] = key
        # ROUND-44 (R44-d): pool slots for sub-agents — the in-memory keyring
        # picks these up and the orchestrator prefers them for child runs.
        for i, sub in enumerate(sub_keys):
            if sub:
                env[f"ACUTE_PROVIDER_OPENROUTER_SLOT{i + 2}"] = sub
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
            "  • the OpenRouter key is missing/invalid (catalog and chats fail)\n"
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

    pat, key, sub_keys = read_credentials()
    register_secrets(pat, key, authed_url(pat), *[s for s in sub_keys if s])
    env = dict(os.environ)

    if cmd == "status":
        mode_status(pat, key, env, sub_keys)
        return

    # ROUND-47: keep the optional sub-agent key LINES present in
    # credentials.txt (placeholder appends only — values are never written).
    sub_keys = ensure_subagent_keys(sub_keys)
    register_secrets(*[s for s in sub_keys if s])

    with step("Verifying GitHub access (token + private repository)"):
        validate_github_access(pat)

    panel(
        "Here is the plan for this run:\n"
        "\n"
        "  1.  Verify GitHub access              done (above)\n"
        "  2.  Check the toolchain               git · Node.js · pnpm — auto-installs when missing\n"
        "  3.  Download / update ACUTE-CODE      first run downloads it, later runs update it\n"
        "  4.  Install dependencies + build      skipped when already done\n"
        "  5.  Store the OpenRouter key          Windows Credential Manager (once)\n"
        "  6.  Start the app                     open http://localhost:5173\n"
        "\n"
        "Every step prints its result. If anything fails you get a red panel\n"
        "with the exact cause and the fix — the window stays open for copying.",
        title="the plan",
    )

    check_toolchain()
    env = ensure_pnpm(env)

    if cmd != "start" and "--no-update" not in sys.argv:
        updated = clone_or_update(pat, env)
    else:
        with step("Update check skipped (start mode)"):
            updated = False

    install_and_build(env, updated)
    write_env_file()
    distribute_key(key, sub_keys)
    self_update_check()

    if cmd == "update":
        rule()
        ok(f"update pass complete ({int(time.time() - STARTED)}s) — everything ready")
        note("double-click the launcher again to start the app")
        wait_close()
        return

    launch(env, key, sub_keys)


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
