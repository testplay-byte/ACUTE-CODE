<!-- last-reviewed: 2026-09-10 round-83 -->
# ADR-0003: Distribution — portable "run from a folder" first, installer optional

- **Status:** ACCEPTED (owner requirement, 2026-08-21)
- **Date:** 2026-08-21

## Context

The brief's Phase 6 exit criterion was an MSI installing on a clean Windows 11 machine. The owner subsequently stated the real requirement: easy running — a folder containing an .exe (and/or a start script) that launches a fully functional system. A "full-fledged application" experience is not required.

## Options considered

- **Installer-first (NSIS/MSI)** — conventional, adds Start-menu entries; heavier to build/verify, and not what the owner asked for as the primary path.
- **Portable-first** — a directory with the Tauri executable (sidecar binaries alongside) that the owner double-clicks; SQLite database created beside it on first run.
- **Both, portable as the gate** — portable build is the Phase 6 exit criterion; installer built afterwards as optional polish only if wanted.

## Decision

Portable-first: the product must run self-contained from a folder with no admin rights, sidecar auto-started by the shell, migrations applied on first launch. Installer (NSIS or MSI) is demoted to optional Phase 6 polish.

## Consequences

Phase 6's exit criterion becomes "clean-machine portable run within the §5 performance budget" instead of "MSI installs". We must keep the app relocatable (no absolute paths in the portable layout; user data under a per-user app-data directory, workspace-relative project references). The Tauri bundler still produces the exe; we skip bundling installer formats until asked.
