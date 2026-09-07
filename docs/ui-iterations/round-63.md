<!-- last-reviewed: 2026-09-07 round-75 -->
# Round 63 — The desktop-update round: the release pipeline gap closed + the launcher's version-truth chain

**Date:** 2026-09-02 · **Branch:** `main` · **Version:** 0.63.0 · **Owner directive (verbatim):** "the computer use was not there and also… the desktop application was not reinstalled properly, not updated properly, or anything like that… whenever I run the acute.bat file, it asks me how I want to run it. If I select the application, then it will check the application version, then it will properly update the application on my desktop. If it needs to delete it completely, then it will delete it completely and reinstall it if needed. It will handle each and every single thing properly, because a lot of the features do not work on the website. The computer browse functionality, the computer use, and various other things are apparently not that well suited for the site."

## The round's shape — a diagnosis round, not a UI round

The owner's report ("features added to the site but the desktop app never updated") was investigated from the ground up and had **one root cause upstream and one hardening gap downstream**:

1. **THE ROOT CAUSE — rounds 61 and 62 shipped no installer at all.** The release workflow (`.github/workflows/release.yml`) builds `ACUTE-CODE_<v>_x64-setup.exe` **only on a `v*` tag push**. R61 and R62 bumped the versions, committed, and pushed — but **never pushed the tags**, so no v0.61.0/v0.62.0 release was ever created and no installer was ever built. The GitHub release list's newest installer was **v0.60.0**. The launcher was *correctly* reporting "installed desktop app 0.60.0 is current" — there was simply nothing newer to install. This ALSO explains "a lot of the features do not work on the website": the site/dev flow serves the repo tip (all new features, minus the desktop-only ones), while the owner's packaged app was frozen at 0.60.0.
   - Fix: this round ships **0.63.0 with the tag pushed** (the tag is now a required close-out step — see the MAINTENANCE.md release recipe added this round). The owner's next `ACUTE.bat` run picks it up: repo pull → launcher self-update → desktop update 0.60.0 → 0.63.0, verified.

2. **THE HARDENING GAP — the launcher's update decision trusted one signal.** "Is current" compared the *uninstall-registry* version (metadata the installer writes) against the release, and only checked that files *exist*. A silent install that raced a still-closing app (R54's fixed-1s sleep) could bump the registry while leaving the OLD exe locked in place — a **hybrid install** that then reports "current" forever. And there was no delete-completely-and-reinstall path at all. This is fixed with the **version-truth chain** below — exactly the "check the application version, then properly update… delete it completely and reinstall if needed" the owner asked for.

| ID | Workstream | Files owned |
|---|---|---|
| R63-main | agent-core `/health` truth, the launcher version-truth chain + uninstall/reinstall + digest verify, docs, release | `agent-core/src/server.ts`, `agent-core/tests/server.test.ts`, `launcher/acute_launcher.py`, `launcher/ACUTE.bat` (CRLF preserved), `launcher/README.md`, `docs/runbooks/MAINTENANCE.md`, this doc, CHANGELOG, HANDOFF |

No new vitest suites (the launcher is a Python zero-dependency script outside the vitest workspaces) — instead the new logic is verified by a **12-scenario simulation battery** (below) + `py_compile` + a live `status` smoke run.

## 1. `/health` tells the truth now (the engine side of the chain)

`GET /health`'s `version` was a hardcoded `"0.3.0"` — stale for 60+ rounds (the value the smoke scripts and any future updater would compare against). `VERSION` now **derives at boot from the package.json next to the compiled code** (`agent-core/package.json` in dev; `sidecar/app/package.json` inside the installed desktop app — the staging step copies the exact version field, verified in `scripts/release/stage-sidecar.mjs`). A missing manifest degrades to `"0.0.0"` rather than taking the engine down. Test updated: `server.test.ts` pins VERSION == the package.json version + the semver shape, and the health payload asserts against `VERSION`.

## 2. The version-TRUTH chain (the launcher side)

`desktop_flow` no longer trusts any single signal. Before any decision it prints a **version-check panel** (the owner asked to *see* the version check) and compares the newest GitHub release against:

1. **the uninstall registry's DisplayVersion** (what the installer claims),
2. **the installed exe's real FileVersion on disk** — a new PowerShell `VersionInfo` probe (the registry can lie; the exe cannot),
3. **after launch, the running engine's `/health` version** — captured from the sidecar's "listening on" line's port, probed token-free, compared with the release (a hybrid install with a new exe but an old staged engine is caught exactly here).

Decision matrix (all covered by the simulation battery):

| Situation | Action |
|---|---|
| registry + exe both match the release | current — launch (flag cleared) |
| registry claims current but exe is older/missing (**hybrid**) | **full uninstall → fresh install → verify** |
| files missing (deleted folder, stale registry) | **full uninstall → fresh install → verify** |
| older version everywhere | plain silent upgrade, then verify |
| newer than the visible release (exe agrees with registry) | keep it — never silently downgrade |
| a repair flag exists (last launch ran the wrong engine) | **full uninstall → fresh install → verify** |
| `ACUTE.bat reinstall` / `--reinstall` | always **full uninstall → fresh install → verify** |

**Post-install verification** is the same chain: the registry AND the exe on disk must report the release version; anything else triggers ONE more full delete-and-reinstall, and a failure after that is an honest fallback to the site flow **plus a sticky repair flag** so the next run self-heals.

## 3. "Delete it completely and reinstall" — the uninstall path

`_desktop_uninstall` (new): stop the app → **wait for the processes to actually be gone** (a process-existence poll, not the R54 fixed 1s sleep — the lock-timing guess is what created hybrids) → run the bundled NSIS uninstaller **synchronously** (the `_?=<dir>` argument pins it to the install dir; without it the uninstaller copies itself to %TEMP% and returns before removing anything) → sweep residue with `rd /s /q` (an uninstaller can never delete the directory it runs from) → **drop the stale uninstall-registry entries** (the R54 post-mortem: a hand-deleted folder leaves them behind, which used to fool "is current"). The owner's data (`%APPDATA%\acute-code` — agents, sessions, projects, settings) is never touched.

New commands wired through `ACUTE.bat`:
- **`ACUTE.bat reinstall`** — delete completely + fresh install + verify + launch.
- **`ACUTE.bat uninstall`** — clean removal (confirm prompt, data kept, **needs no credentials** — it runs before the credentials gate).
- `ACUTE.bat status` — now shows the whole truth: registry version, exe-on-disk version (+ a `≠ registry` HYBRID warning), latest release on GitHub with **UPDATE PENDING**, and the repair-flag state.

## 4. The download is verified too

The installer download (35 MB+) was guarded only by a ">1 MB" size heuristic. It now verifies the file's **sha256 against the release asset's `digest`** (GitHub computes it server-side on upload — present on all current assets), and a mismatch triggers **one full re-download** before giving up. A corrupt installer can no longer reach the silent-install step.

## 5. The honest site-mode note

The owner's "features do not work on the site" is inherent, not a bug: the embedded Chromium browser and computer use need the native webview. The site-flow plan panel now says so explicitly (pointing at `ACUTE.bat app`), and the launcher README documents it. The desktop app remains the full-experience default.

## Verification

- **agent-core:** `server.test.ts` health/VERSION tests green (updated), full suite run in close-out.
- **Launcher logic (py_compile + a 12-scenario simulation battery** against the real module with mocked Windows probes): current pass-through, hybrid repair, plain upgrade, newer-kept, forced reinstall, repair-flag self-heal (+ flag cleared after verified install), engine-version mismatch → flag, missing-files reinstall, first-time install, post-install verify retry (uninstall + one retry), unrepairable → honest fallback + sticky flag, and the **real `_desktop_uninstall` against a real temp dir** (uninstaller called, residue swept, registry cleaned, True returned).
- **Live smoke:** `python3 acute_launcher.py status` boots the real module cleanly (Linux path; the desktop section is Windows-only) — banner → status panel, exit 0.
- **ACUTE.bat CRLF check:** the file is committed with CRLF (cmd.exe requirement; the release kit re-verifies in CI) — 77 CRLF lines preserved after the edit, `file` reports `DOS batch file … with CRLF`.
- **The release itself:** tag `v0.63.0` pushed → the Release workflow builds the installer (with its R57 boot gate) and opens the draft release carrying `ACUTE-CODE_0.63.0_x64-setup.exe` — the artifact the owner's launcher will fetch on the next double-click. Verified in the close-out via the GitHub API.

## Honest caveats

- The launcher's Windows paths (FileVersion probe, uninstaller orchestration, process wait) are code-complete and simulation-verified but **live-verified only on the owner's machine** (this sandbox is headless Linux — no Windows registry, no NSIS, no WebView2). The scenarios pin the exact decision matrix so the first owner run is the last unverified step.
- The engine `/health` probe assumes the sidecar's log line port (the same source the engine watcher already trusts); if `/health` is unreachable the check is skipped honestly, never fatal.
- macOS/Linux remain dev-flow-only (the installer is Windows-only) — unchanged.
