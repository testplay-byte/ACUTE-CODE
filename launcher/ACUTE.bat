@echo off
rem ============================================================================
rem  ACUTE-CODE — one-click launcher for Windows (coordinator)
rem ============================================================================
rem  This tiny file is the ONLY thing you double-click. It sets up a clean
rem  UTF-8 console, then hands off to acute_launcher.py (the workhorse with
rem  the full terminal UI — panels, spinners, auto-install, self-update).
rem
rem  THE LAUNCH QUESTION (round 56): every run ASKS how you want to launch —
rem      [1] the DESKTOP app  (the packaged window, recommended)
rem      [2] the SITE         (local servers + your browser)
rem  Enter keeps your last choice. Skip the question with a command:
rem
rem      ACUTE.bat            ask app-or-site, then launch (default)
rem      ACUTE.bat app        the desktop app, no question
rem      ACUTE.bat site       the site in your browser, no question
rem
rem  If the desktop app's engine fails to start, the launcher asks what to
rem  do next (retry / use the site / keep) — you are never stuck.
rem
rem  R63 — the desktop app's UPDATE is VERIFIED, not assumed: the launcher
rem  checks the version in the registry, the exe ON DISK, and the running
rem  engine's /health, against the newest GitHub release. Anything stale,
rem  missing or half-replaced (a "hybrid" install) is deleted completely
rem  and reinstalled from a sha256-verified download. Nothing to click,
rem  nothing to trust — every run ends with the real newest app.
rem
rem  Files that belong in THIS folder:
rem      ACUTE.bat              <- you are here (double-click me)
rem      acute_launcher.py      <- the workhorse (self-updates from the repo)
rem  No secrets live here (R87): the GitHub token is asked once on first
rem  run and saved in your USER HOME at ~\.acute\github.pat (R90-B1 — the
rem  app's update check reads it there; a pre-round-90 copy in this folder
rem  is moved over automatically), or set ACUTE_GITHUB_PAT; provider
rem  API keys are saved inside the app (Settings -> Models & Providers).
rem
rem  Useful commands:   ACUTE.bat status   read-only health report
rem                     ACUTE.bat update   update everything, don't start
rem                     ACUTE.bat start    skip the update check (still asks)
rem  R63 commands:      ACUTE.bat reinstall   delete the desktop app completely,
rem                                         download + install the newest release,
rem                                         verify it (registry + exe + engine),
rem                                         then launch it
rem                     ACUTE.bat uninstall  remove the packaged desktop app
rem                                         cleanly (your data is always kept)
rem ============================================================================

rem --- UTF-8 console so the rich-UI panels render correctly (fixes borders) --
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set PYTHONDONTWRITEBYTECODE=1
cd /d "%~dp0"
title ACUTE-CODE

rem --- run the workhorse via the py launcher, falling back to plain python ---
rem     errorlevel 9009 = "command not found": try the next interpreter, and
rem     if none exists, offer to install Python automatically via winget.
py -3 acute_launcher.py %*
if not errorlevel 9009 goto done

python acute_launcher.py %*
if not errorlevel 9009 goto done

echo.
echo  Python was not found on this computer.
echo.
echo  I can install it for you automatically with winget.
echo  A Windows security window may appear - please allow it.
echo.
pause
winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
echo.
echo  When the installer finishes: CLOSE this window and
echo  double-click ACUTE.bat again. Everything continues.
echo.
:done
echo.
pause
