@echo off
setlocal
cd /d "%~dp0"
title ACUTE-CODE

rem ---------------------------------------------------------------
rem  ACUTE-CODE one-click launcher (coordinator).
rem  The real work happens in acute_launcher.py (rich terminal UI).
rem  Keep ACUTE.bat, acute_launcher.py and credentials.txt together
rem  in this folder. Double-click this file to run everything.
rem ---------------------------------------------------------------

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
