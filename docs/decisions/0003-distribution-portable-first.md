# ADR-0003: Portable, easy-run distribution first; installer optional

- **Status:** ACCEPTED (owner decision, 2026-08-21)
- **Date:** 2026-08-21

## Context

The original brief's Phase 6 exit required an MSI installer validated on a clean machine. The owner stated the real requirement: "I should be able to run it easily… a folder I could get an .exe file or maybe a server setup file which I can start… I don't necessarily require a full-fledged application." The value is a fully functional, self-managing, remembering system — not installation polish.

## Options considered

- **A. Installer-first (NSIS/MSI as the primary artifact)** — conventional, but adds signing/installer maintenance before the product earns it.
- **B. Portable-first** — a distributable folder: `acute-code.exe` (+ sidecar binary); double-click starts the shell, which auto-starts the sidecar, runs SQLite migrations on first run, and manages lifecycle. Installer produced later as optional polish.

## Decision

**Option B.** The Phase 6 exit criterion becomes: the portable build runs on a clean Windows 11 machine within the performance budget, verified hands-on by the orchestrator. NSIS/MSI remains available as an optional Tauri bundler output, not a gate.

## Consequences

Dev and release builds must keep relative-path integrity (sidecar next to the exe; data directory under the user profile, not the install dir). No admin rights required. The spec's §F11 and phase table reflect this. Reversal cost: none — an installer can be added anytime on top of the same bundle.
