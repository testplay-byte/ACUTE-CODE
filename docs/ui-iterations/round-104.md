<!-- last-reviewed: 2026-09-18 round-104 -->
# Round 104 — the update hand-shake (download, then confirm) + the Linux AppImage updater made real (v0.100.0 → v0.101.0)

The fourteenth-walkthrough round. The owner ran v0.100.0 on Windows AND
Linux and filed the report this round answers — with both halves of the
update experience named explicitly:

- **Windows:** "If I download the new version, it automatically updates it
  rather than waiting for my confirmation to give me the update button. It
  downloads it and then, after downloading it, directly updates it. I don't
  want it. I want the ability to download it then confirm to update it, or
  click the update button in the About section to update it."
- **Linux:** "It properly detects the new version and downloads it too but
  after downloading it, it automatically goes to the updating functionality
  too… It was saying 'Restarting into 0.100.0' and then it said 'Connecting
  to Agent Core' but apparently it did not get updated… It was version
  0.99.0 in the About section. Even when I tried closing it and opening it
  again, it was exactly the same."

The round also honors the standing directive that opened the session: the
sandbox had been cleared of `/home/z/repos` (the workspace was re-cloned
from the remote at the R103 close-out commit and re-verified against
origin before any work began), and the standing meta-ask — "handle them
much better, much more properly, and much more well managed… Do not rush
anything" — shaped the round's method: every defect root-caused in the
code before a line was written, every layer tested at its own boundary,
and the failure paths designed as carefully as the happy path.

## §0 The owner's report, itemized (the round's contract)

1. **The Windows auto-install after download** (the quote above) → §2 C:
   the one-click "Update now" (R99-C's directive, faithfully built then)
   is RETIRED in favor of the two-stage hand-shake — Download (byte-true
   progress + sha256 verify) **stops** at a verified staged file; only the
   explicit "Restart and update now" confirmation installs; "Discard
   download" walks it back; the About tab re-adopts a staged download on
   every visit (the "click the update button in the About section" ask,
   days later, without a re-check).
2. **The Linux "update" that never updated** (the quote above) → root
   cause found in TWO layers (§1), fixed in both: the sidecar offered the
   WINDOWS `setup.exe` asset on every platform, and the Rust shell had no
   Linux install path at all — the `.exe` launch rejected, the R101-B
   recovery restarted the engine ("Connecting to Agent Core"), and the
   app lived on un-updated after the calm "Restarting into 0.100.0"
   splash. §2 A (the platform-aware asset pick) + §2 B (the AppImage
   replace leg).
3. **"In the future I am thinking about improving the update system…
   rather than installing the whole application again"** → deliberately
   NOT this round (disclosed): the AppImage replace IS the incremental
   update for Linux (the user's data never moves; only the image swaps);
   a true delta-patch system for the NSIS leg remains future work — the
   two-stage hand-shake is the contract any future mechanism will plug
   into (the confirm step is the seam).

## §1 The diagnosis — both defects, root-caused before any fix

**The Windows defect was a UX decision whose time passed.** R99-C's
directive was literally "I click the update button… and everything else
happens automatically afterwards by itself" — and `updateNow(silent)`
implemented exactly that: download → verify → `run_update_installer`
(silent) in one click. Nothing was broken; the contract changed. The fix
is a re-shaping of the same machinery (the download, the verify, the
launch leg, the R101-B calm hand-off all stand).

**The Linux defect was two missing halves.** Verified in the code, not
guessed:

1. `agent-core/src/routes/system.ts`'s `findInstallerAsset` matched
   `_x64-setup.exe` — unconditionally. On the owner's ARM64 Linux machine,
   "Update now" downloaded the **Windows installer** (38.7 MB of
   `ACUTE-CODE_0.100.0_x64-setup.exe` — the download "worked", exactly as
   the owner reported).
2. `src-tauri/src/update.rs`'s `run_update_installer` then walked the
   Windows path: the `.exe` extension check passed, the pre-install kill
   ran, and the silent launch hit the non-Windows stub —
   `"the silent installer launch is only available in the packaged
   Windows app"` — a REJECTED invoke. The frontend's R101-B recovery
   (built for exactly this shape) cleared `updateInFlight` and called
   `retryConnection()` — which is the literal "Connecting to Agent Core"
   the owner saw. The app survived on v0.99.0, having killed and
   resurrected its own engine for nothing. There was **no Linux install
   implementation anywhere** — no AppImage handling in the Rust shell at
   all.

The splash ordering the owner described ("Restarting into 0.100.0" THEN
"Connecting to Agent Core") maps one-to-one onto this sequence — the
ConnectionGate renders the Restarting splash the moment `updateInFlight`
is set (before the invoke), then the rejection flips it to the connecting
splash while the About tab rendered the honest error beneath (the owner
read the splash, not the card).

## §2 The workstreams

### A — the sidecar's platform-aware updater asset (R104-A)

`agent-core/src/routes/system.ts`:

- **`updaterAssetSuffixForPlatform(platform, arch)`** (exported, pure):
  `win32 → _x64-setup.exe (windows-setup)`, `linux+arm64 →
  _aarch64.AppImage (linux-appimage)` — the Rust triple's arch name, the
  R101 naming asymmetry (the deb carries dpkg's `_arm64`; the AppImage
  carries `aarch64`) — `linux+x64 → _amd64.AppImage` (tauri-bundler names
  both x86_64 bundles `amd64`), anything else → `null` (macOS is not
  shipped; the Releases page remains the answer there).
- **`findUpdaterAsset`** (was `findInstallerAsset`) picks THIS machine's
  asset from the release; the R94-B both-URL-forms preference (API `url`
  first, `browser_download_url` fallback) is unchanged. The response's
  `asset` now carries **`kind`** (the frontend gates its
  interactive-wizard escape hatch on it — there is no wizard for an
  AppImage) and **`name`** (the REAL asset filename).
- **The download route** derives the staged file's name from the posted
  `name`: basename-only (every separator stripped, no `..`, no leading
  dot), and the extension must be one of the updater's two real kinds
  (`.exe` / `.AppImage`, case-insensitive) — anything else falls back to
  the platform's conventional name. The plausibility floor is now
  EXTENSION-AWARE: 10 MB for a setup.exe (unchanged since R91-E), 50 MB
  for an AppImage (the real one is ~130 MB; v0.100.0's aarch64 build is
  132.7 MB).
- **`DELETE /system/updates/download`** (new): the walk-back half of the
  hand-shake — unlinks a STAGED (ready) file and returns the
  single-flight state to idle; a download IN FLIGHT is refused honestly
  (409 CONFLICT — the live download's state is not the caller's to cancel
  out from under); from idle it is the idempotent reset.

### B — the Rust shell's AppImage replace leg (R104-B)

`src-tauri/src/update.rs` — `run_update_installer(path, silent?)` now
dispatches on the staged file's extension, platform-coherently:

- **Validation**: absolute path, exists, regular file, and the platform's
  OWN update kind — `.exe` on Windows only ("the Windows setup.exe cannot
  install on this platform — run Check for updates to pick this machine's
  update, or use the Releases page"), `.AppImage` on Linux only; the size
  floor rides the kind. The pre-R104 Linux failure mode (a Windows
  installer accepted deep into a Windows-only launch) is now impossible
  to reach silently.
- **The Linux replace** (`mod appimage`, `#[cfg(target_os = "linux")]`):
  1. Resolve the CURRENT AppImage from the `APPIMAGE` environment
     variable (the AppImage runtime's own export — `current_exe()` is
     useless inside the mounted squashfs). A missing/relative value (a
     .deb install, a dev checkout) → the honest Releases-page error.
  2. **Stage** the verified download BESIDE the current AppImage
     (`.ACUTE-CODE-update-<pid>.AppImage`): same directory = same
     filesystem = the final rename is ATOMIC (a cross-FS rename degrades
     to copy+delete and can tear mid-move). The copy PROVES the directory
     is writable BEFORE anything is killed. chmod 0755 + a best-effort
     fsync (a power-cut after the rename must never leave a half-written
     image owning the name).
  3. **Kill** the sidecar tree — the same
     `shutdown_before_install` ordering contract as the Windows leg
     (graceful ask → 5s bounded wait → force-kill → reap + 300ms grace),
     so the replacement instance's engine never contends with the dying
     one's SQLite.
  4. **Rename** the staged file over the AppImage path — the atomic
     directory-entry swap: the old inode stays alive through the running
     process's open mount (the app keeps working for its last seconds),
     the new inode takes the public name. Never torn, never half-old. On
     failure: the staged file is cleaned up and the Err maps to the
     frontend's R101-B recovery — the RUNNING app is untouched.
  5. **Relaunch** through a detached `sh -c 'sleep 3; exec <path>'` with
     null stdio — the old app's exit timer fires at 1.5s, so the new
     instance starts only after the old one is gone (no WebKitGTK
     cache/data contention, no double window).
  6. The caller schedules the app's exit (the shared `schedule_exit`,
     1.5s — the reply lands first, so "Restarting into vX" shows).
- **Failure honesty, every leg mapped** (also in the module docs): a
  stage-copy failure (read-only directory, disk full) errors BEFORE the
  kill — the app lives on untouched; a rename failure cleans up and
  recovers; a relaunch-spawn failure AFTER a successful replace returns
  the honest "the update is installed, reopen the app by hand" error and
  the recovery restarts the engine (the current process keeps serving
  from its still-alive old mount; the next manual start runs the new
  version).
- The Windows legs are byte-for-byte the R99-C/R96-I machinery (the
  ShellExecuteW `/S /R` silent launch, the interactive shell-open
  fallback, the pre-install kill); `silent` is deliberately ignored on
  Linux — the replace IS the install (documented in the module header).

### C — the frontend's two-stage hand-shake (R104-C)

`src/components/settings/AboutTab.tsx` (+ `src/lib/api.ts`):

- **Stage 1 — "Download update"** (was "Update now"): the reuse check
  (an already-verified download for the same version goes straight to
  ready — no re-download), any settled-but-stale state discarded first,
  then the stream with byte-true progress + the verify poll. **"ready"
  STOPS the flow** — the old code called `launchInstaller` from inside
  the poll loop; that call is gone.
- **Stage 2 — the staged row**: "Downloaded and verified — vX is ready to
  install" + the primary **"Restart and update now"** + the quiet
  **"Discard download"** (the sidecar DELETE). The row renders inside
  the available-update card AND standalone (below).
- **The mount-resume**: on the VersionCard's mount (desktop only), the
  card polls the sidecar's single-flight state once — a READY download
  for a newer version is re-adopted (the staged row renders with NO
  check run: the owner's "click the update button in the About section to
  update it", days later); a ready download the app has moved past is
  DISCARDED silently (the `pendingVersion` self-heal pattern); a
  downloading/verifying state re-attaches to the live progress.
- **The re-check staleness sweep**: a manual check that answers "no
  update" or a DIFFERENT version retires the staged file — the install
  button can never install something the badge did not announce.
- **The install-phase states (installing / launched / error) moved to a
  SHARED block** below the update-state line — they used to render only
  inside the available-update card, which would have left a
  mount-resumed confirm showing NOTHING between the click and the
  Restarting splash (caught by the mount-resume test during the round).
- **The wizard escape hatch is now kind-gated**: `offerWizard` requires
  the staged file to be a `.exe` (`stagedAssetKind(path)`) — an AppImage
  rejection offers no wizard because there is none; the honest error +
  the R101-B engine recovery stand on their own.
- `api.ts`: the check's `asset` type gains `{kind, name}`; the download
  POST gains `name`; **`discardUpdateDownload()`** (DELETE) joins the
  surface. The startup auto-check (`lib/update-checker.ts`) is
  deliberately unchanged — it checks, badges, and toasts; it never
  downloads.

## §3 The verification numbers

All run in-sandbox on the restored workspace, before any commit:

- **agent-core**: `vitest run` → **2,392 / 2,392** (was 2,385 at the R101
  close-out; the r89-updates suite grew 14 → 22 tests: the pure platform
  matrix, the four-platform route pick against a real six-asset release
  shape, the basename-only name derivation, the extension-aware floor,
  and three DELETE-discard tests). `tsc --noEmit` clean.
- **root (frontend)**: `vitest run` → **3,823 passed / 12 skipped** (the
  AboutTab suite grew 13 → 19: the two-stage stop-at-ready pin — the
  install invoke asserted ABSENT at the staged row — the Linux AppImage
  leg with the no-wizard pin, the mount-resume, the stale self-heal, the
  discard, the staleness sweep, and the re-pinned two-stage
  rejected-invoke journey). `tsc --noEmit` clean.
- **eslint .** clean; **license-audit** clean (247 production
  dependencies); **design-audit** re-pinned R2 1522→1526 — four
  documented ladder steps (the StagedDownloadRow's four text elements,
  each the About card's established 11px chrome step every sibling line
  uses); **docs:check** 223 docs, 0 failures, 0 warnings; **version ×4**
  at 0.101.0 (`version.mjs check` green); the update suites re-run GREEN
  after the version bump (the R102-addendum discipline — a bump is a code
  change).
- **CI-caught hotfix #1 (the R100 pattern, live again):** the first
  push's `verify` job failed on exactly the design-audit ratchet — R2
  +4 — because the in-sandbox gate had been checked through a pipe
  (`node scripts/design-audit.mjs | tail -3; echo $?`) whose `$?`
  captured TAIL's exit code, not the audit's (the audit had been failing
  red the whole time). Fixed by the honest re-pin above + the lesson
  below; the tag was then moved to the fixed commit and both workflows
  re-dispatched (the R101 hotfix re-tag pattern; the resumable publisher
  skips the byte-identical assets it already banked).
- **The Rust leg**: no local toolchain survives the sandbox reset (the
  R102 rustup was lost with `/home/z/repos`), so CI's cargo check is the
  compile gate — the R100 pattern. The round's discipline applied: the
  cfg-attribute balance sweep (0 unbalanced, the R100-hotfix lesson), a
  brace-balance check on the rewritten file, and a line-by-line
  compile-review of every `use`, cfg arm, and type before the commit.

## §4 The owner's TEST CHECKLIST (v0.101.0)

1. **Windows — the headline:** Settings → About → Check for updates →
   **Download update** — the progress bar fills, the checksum verifies,
   and then it STOPS: "Downloaded and verified — v0.101.0 is ready to
   install" with **Restart and update now** + **Discard download**.
   Nothing installs until you click the restart button. Click it → the
   calm "Restarting into v0.101.0…" splash → the app comes back by
   itself on 0.101.0 (About confirms).
2. **Windows — the staged download persists:** Download the update, then
   navigate away (or close and reopen the app) → Settings → About shows
   the ready-to-install row immediately — click the button, install.
   Also try Discard: the row disappears; a later Download starts clean.
3. **Linux — the round's second headline:** on the AppImage install,
   Settings → About → Check for updates → **Download update** — the
   progress bar fills with the AppImage (~130 MB) → the ready row →
   **Restart and update now** → "Restarting into v0.101.0…" → the app
   closes and comes back BY ITSELF on v0.101.0 — About now says
   v0.101.0, and closing/reopening keeps saying it. (The v0.100.0
   report's exact arc, answered.)
4. **Linux — a .deb install (if that's the install form):** the ready row
   appears, the confirm answers with the honest "the app is not running
   from an AppImage — a .deb install updates through the Releases page"
   error, the engine recovers by itself, and the app lives on — no
   silent nothing-updated.
5. **The badge honesty:** with a staged download sitting ready, run Check
   for updates again — the same version keeps the staged row; a
   different version (or "up to date") retires the old file and offers
   the fresh Download button.
6. **The startup auto-check is unchanged:** one toast + the Settings dot
   when a release is available — it never downloads anything by itself.

## §5 The round's lessons (also AGENT-MEMORY #105)

- **A UX directive can expire.** R99-C's "everything happens
  automatically afterwards by itself" and R104's "download it then
  confirm to update it" are contradictory owner asks separated by five
  weeks and one bad experience — both were right for their moment. The
  lesson is not "the owner changed his mind" but that ONE-CLICK
  automation over a RESTART (a destructive-feeling act) ages badly; the
  two-stage shape (prepare → confirm) is the durable contract, and the
  staged state is the seam any future update mechanism plugs into.
- **The splash is not the truth.** The owner's Linux report read
  "Restarting into 0.100.0 → Connecting to Agent Core" as an update that
  tried and failed quietly. Both screens were HONEST UI — the lie was in
  the gap between them (a rejected invoke that looked like progress).
  When a calm surface masks a failure, the failure must surface in the
  same calm surface, not beneath it.
- **Test the state that survives the screen.** The mount-resume test
  caught a real render bug the happy-path tests could not see: the
  install-phase states lived inside the available-update card, so a
  resumed confirm would have shown NOTHING mid-install. Persistence
  surfaces (state that outlives its originating screen) need tests that
  enter from COLD — no check, no click, just the adopted state.
- **The sandbox reset lost the R102 rustup install** — the Rust leg rode
  CI's cargo check again (the R100 pattern). The compensations that held
  the line: the cfg-paren sweep, the brace-balance check, and writing
  every failure path as a named, mapped case before the happy path. Both
  rust jobs (x64 + arm64) were green on the FIRST push — the compile
  gamble paid off.
- **`cmd | tail; echo $?` reports TAIL's exit code** — the round's own
  CI-caught miss: the design-audit gate "passed" in-sandbox because the
  pipe swallowed the audit's exit 1 (the audit's failure text was
  printed, read as informational, and the `EXIT:0` came from `tail`).
  Every gate check that matters must read the command's own exit code —
  `set -o pipefail`, a temp variable, or no pipe at all. The audit
  ratchet also proved (again) its worth as the ratchet: +4 px-literal
  steps cannot slip through CI even when the human review did.

## §6 What ships to the owner

- v0.101.0 — the two-stage update hand-shake on every platform, and the
  first Linux update that actually updates (the arch-matched AppImage
  pick + the atomic replace + the automatic relaunch).
- The staged download that survives the About tab (and the app session),
  the Discard walk-back, and the badge/install agreement enforced by the
  staleness sweep.
- No other surface changed: the chat, the browser, the key store, the
  diagram viewer, and the composer are exactly v0.100.0's.
