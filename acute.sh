#!/usr/bin/env bash
# ACUTE-CODE one-click launcher (Linux / macOS twin of ACUTE.bat).
# Put this file in any folder and run it (double-click in a file manager with
# "run in terminal" enabled, or `bash acute.sh`). First run: installs
# everything. After that: checks GitHub for updates, restarts servers, runs.
set -u
cd "$(dirname "$0")" || exit 1

pause() { if [ -t 0 ]; then printf 'Press Enter to close... '; IFS= read -r _; fi; }

echo "=========================================================="
echo "  ACUTE-CODE - one-click launcher"
echo "  First run: installs everything. After that: updates + runs."
echo "=========================================================="
echo

if ! command -v git >/dev/null 2>&1; then
  echo "[ERROR] git is not installed."
  echo "  Ubuntu/Debian: sudo apt install git     Fedora: sudo dnf install git"
  pause; exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed (need 20+, 24 recommended)."
  echo "  Install from https://nodejs.org or your package manager."
  pause; exit 1
fi

if [ ! -f "ACUTE-CODE/scripts/acute-desktop.mjs" ]; then
  echo "First run: cloning the private ACUTE-CODE repository from GitHub."
  echo "Git will ask for your credentials ONCE and they are stored in"
  echo "~/.acute-git-credentials (permission 600)."
  echo
  echo "  Username: testplay-byte"
  echo "  Password: your GitHub PAT (paste it - it will not show)"
  echo
  git config --global credential.https://github.com.helper ""
  git config --global credential.helper "store --file=$HOME/.acute-git-credentials"
  chmod 600 "$HOME/.acute-git-credentials" 2>/dev/null
  if ! git clone https://github.com/testplay-byte/ACUTE-CODE.git ACUTE-CODE; then
    echo
    echo "[ERROR] Clone failed. Most likely causes:"
    echo "  - Wrong credentials (username: testplay-byte  password: your PAT)"
    echo "  - No internet connection"
    echo "Fix it and run this file again - the clone retries."
    pause; exit 1
  fi
  echo
fi

cd ACUTE-CODE || { pause; exit 1; }

# The runner shows its own progress/errors; this script owns the final pause.
ACUTE_RUNNER_NO_PAUSE=1 node scripts/acute-desktop.mjs "$@"
RC=$?
echo
if [ "$RC" -ne 0 ]; then
  echo "[launcher] The runner stopped with an error - the full message above"
  echo "[launcher] is copyable, and everything is also in acute-runner.log"
  echo "[launcher] inside the ACUTE-CODE folder."
fi
pause
exit "$RC"
