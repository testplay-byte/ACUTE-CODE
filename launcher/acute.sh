#!/usr/bin/env bash
# ACUTE-CODE one-click launcher for Linux/macOS (twin of ACUTE.bat).
# Run:  bash acute.sh            (or make it executable and double-click in
#                                 a file manager that offers "run in terminal")
# Requires: python3 on PATH. The launcher handles everything else.
set -u
cd "$(dirname "$0")" || exit 1

echo "=========================================================="
echo "  ACUTE-CODE — launcher"
echo "=========================================================="

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 is not installed."
  echo "  Ubuntu/Debian: sudo apt install python3 python3-pip"
  echo "  Fedora:        sudo dnf install python3"
  read -r -p "Press Enter to close..." _
  exit 1
fi

exec python3 acute_launcher.py "$@"
