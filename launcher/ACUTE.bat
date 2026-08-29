@echo off
rem ============================================================================
rem  ACUTE-CODE — one-click launcher for Windows (coordinator)
rem ============================================================================
rem  This tiny file is the ONLY thing you double-click. It sets up a clean
rem  UTF-8 console, then hands off to acute_launcher.py (the workhorse with
rem  the full terminal UI — panels, spinners, auto-install, self-update).
rem
rem  Files that belong in THIS folder:
rem      ACUTE.bat              <- you are here (double-click me)
rem      acute_launcher.py      <- the workhorse (never needs editing)
rem      credentials.txt        <- your secrets (rename from
rem                                 credentials.example.txt and fill it in)
rem
rem  Useful commands:   ACUTE.bat status   read-only health report
rem                     ACUTE.bat update   update everything, don't start
rem                     ACUTE.bat start    start without the update check
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
