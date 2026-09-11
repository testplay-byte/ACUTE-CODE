#!/usr/bin/env bash
# ============================================================================
#  ACUTE-CODE — one-click launcher for Linux/macOS (twin of ACUTE.bat)
# ============================================================================
#  Run:   bash acute.sh            (or make it executable and double-click in
#                                  a file manager that offers "run in terminal")
#  Needs: python3 on PATH — the launcher handles everything else.
#
#  Files that belong in THIS folder:
#      acute.sh                <- you are here
#      acute_launcher.py       <- the workhorse (never needs editing)
#  No secrets live here (R87): the GitHub token is asked once on first
#  run and saved in your user home at ~/.acute/github.pat (R90-B1 — the
#  app's update check reads it there; a pre-round-90 copy in this folder
#  is moved over automatically), or set ACUTE_GITHUB_PAT; provider
#  API keys are saved inside the app (Settings -> Models & Providers).
#
#  Useful commands:   bash acute.sh status    read-only health report
#                     bash acute.sh update    update everything, don't start
#                     bash acute.sh start     start without the update check
# ============================================================================
set -u
cd "$(dirname "$0")" || exit 1

echo "=========================================================="
echo "  ACUTE-CODE — launcher"
echo "=========================================================="

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 is not installed."
  echo "  Ubuntu/Debian: sudo apt install python3 python3-pip"
  echo "  Fedora:        sudo dnf install python3"
  echo "  macOS:         brew install python3   (or use the official installer)"
  read -r -p "Press Enter to close..." _
  exit 1
fi

exec python3 acute_launcher.py "$@"
