@echo off
setlocal
chcp 65001 >nul
title ACUTE-CODE launcher
cd /d "%~dp0"

echo ==========================================================
echo   ACUTE-CODE - one-click launcher
echo   First run: installs everything. After that: updates + runs.
echo ==========================================================
echo.

where git >nul 2>nul
if errorlevel 1 goto :nogit
where node >nul 2>nul
if errorlevel 1 goto :nonode

if exist "ACUTE-CODE\scripts\acute-desktop.mjs" goto :run

echo First run: cloning the private ACUTE-CODE repository from GitHub.
echo Git will ask for your credentials ONCE and Windows stores them
echo safely in Windows Credential Manager (you never retype them).
echo.
echo   Username: testplay-byte
echo   Password: your GitHub PAT (paste it - it will not show)
echo.
git config --global credential.https://github.com.helper ""
git config --global credential.https://github.com.helper wincred
git clone https://github.com/testplay-byte/ACUTE-CODE.git ACUTE-CODE
if errorlevel 1 goto :clonefail
echo.

:run
cd /d "%~dp0ACUTE-CODE"
rem The runner shows its own progress/errors; this file owns the final pause.
set ACUTE_RUNNER_NO_PAUSE=1
node scripts\acute-desktop.mjs %*
set RUNNER_RC=%errorlevel%
echo.
if not "%RUNNER_RC%"=="0" (
  echo [launcher] The runner stopped with an error - the full message above
  echo [launcher] is copyable, and everything is also in acute-runner.log
  echo [launcher] inside the ACUTE-CODE folder.
)
pause
exit /b %RUNNER_RC%

:nogit
echo.
echo [ERROR] git is not installed.
echo Install it from https://git-scm.com/downloads
echo or from a terminal:  winget install Git.Git
goto :end

:nonode
echo.
echo [ERROR] Node.js is not installed (need version 20 or newer, 24 recommended^).
echo Install it from https://nodejs.org
echo or from a terminal:  winget install OpenJS.NodeJS.LTS
goto :end

:clonefail
echo.
echo [ERROR] Clone failed. Most likely causes:
echo   - Wrong credentials (username: testplay-byte  password: your PAT^)
echo   - No internet connection
echo Fix it and double-click this file again - the clone retries.
goto :end

:end
echo.
pause
