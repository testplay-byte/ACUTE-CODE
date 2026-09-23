<!-- last-reviewed: 2026-09-23 round-123 -->
# ROUND 123 — the updater overhaul + the mobile transcript per the owner's references

**The owner's directive (the v0.116 report, three fronts):**

1. *The updater* — "why does it even require a GitHub token? Isn't our GitHub repository public and
   can't it easily fetch the appropriate version it needs without the GitHub token?" … "the update
   system itself is not that well handled… not working that properly both on Windows and both on
   Linux" … "on the PC, the Windows side… it does not show me any kind of animation while it is
   processing… I feel like that nothing is happening and it won't auto start but it does auto start
   with some delay, which is not ideal."
2. *The self-feedback section* — "at first sight… there was no delete button or such, like I should
   be given an option to delete it completely… when the feedback actually got populated, then there
   were proper options there… it could be improved much better, much more well-handled and
   well-defined."
3. *The mobile transcript* (per the seven uploaded reference screenshots) — "the image was supposed
   to be shown at the top of the text, but it was shown below the text… there was a pulsing line
   below [the display picture] too, which I explicitly told you to remove… No tool calls were shown
   to me… No file writes were shown to me… the text looked odd, like there was no separation with
   the elements… the experience was feeling inconsistent and random." Plus the desktop quick-nav —
   "it is being shown as column view, but what I was hoping for it to be was in a row kind of view…
   the one closer to the mouse pointer is the bigger… it should not be shown above the text. There
   should be some padding… I can just directly hover near it on the right side or left side and it
   will still register it well. But there should be a limit on it properly."

## §1 The updater — anonymous-first, visible installs, the Linux .deb leg

### A. ANONYMOUS-FIRST (the token question answered structurally)

The R89-era order (PAT attached first, anonymous retry on 401/403 — R120-U's patch) still made the
token the DEFAULT leg: the owner's machine carried a launcher-era `~/.acute/github.pat`, every check
burned a round trip on it, and the About tab carried an always-present "GitHub token" row that read
like a REQUIREMENT. R123 inverts the order in `routes/system.ts`:

| leg | before (R120-U) | after (R123) |
|---|---|---|
| 1st fetch | PAT-bearing (when saved) | **ANONYMOUS** — always |
| retry | anonymous, on 401/403 from the PAT leg | **token-bearing**, only on anonymous 403/404 AND a token is saved |
| happy path | `tokenWarning` could ride a success | NO warning can ride a success — a dead token can no longer degrade anything |
| rate-limit answer | reason `"github"`, generic copy | reason **`"rate-limited"`**, the one case a token genuinely helps |
| every answer | — | carries **`tokenSaved: boolean`** (the About tab's row visibility truth) |

The dead-PAT 401 that killed the v0.113.0 check is now unreachable on the first leg by construction
(nothing attached to reject). The DOWNLOAD route mirrors the inversion (anonymous first, the token
only on the retry). The About tab renders the token row ONLY when `tokenSaved === true` or the check
rate-limited — the default public-repo experience shows no token UI anywhere, and the row's own first
line now says "Optional — the repository is public…".

### B. THE TOKEN'S FULL LIFE CYCLE (the remove affordance)

An optional credential must be removable in-app: `DELETE /system/updates/token` clears BOTH layers
(the `~/.acute/github.pat` file + the sidecar's env snapshot) and answers idempotent-honest
(`{removed:false}` when none was saved — never a 404). The removal SURVIVES the next launcher start
(the launcher re-exports from the file, which no longer exists). The About tab's row gains the
"Remove token" button beside Save; the note ("GitHub token removed — checks run anonymously") renders
outside the conditional row so it stays readable after the row retires on the re-run answer.

### C. WINDOWS — THE OVERLAY INSTALL (no more dark period)

The R99-C flow exits the app 1.5s after launching the silent NSIS installer, so the 10-40s install
runs COMPLETELY invisibly (the owner's "nothing is happening… auto start with some delay"). R123's
overlay flow in `src-tauri/src/update.rs`:

1. **THE SELF-RENAME** — the app renames its own exe to `<exe>.old` (the Chrome/VS Code trick: a
   running exe CAN rename itself, freeing the install path for NSIS to write the new exe while this
   process lives on). A refusing rename (AV/filesystem lock, or a stale `.old` from a prior crash
   that cannot be cleared) is NOT an error — the R99-C `/S /R` flow runs verbatim as the fallback.
2. **CreateProcessW with an OWNED handle** — `"<installer>" /S` (NO `/R`: the relaunch is OURS now,
   not the template's timer), `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`.
3. **THE WINDOW STAYS OPEN** — the animated Restarting splash (the ConnectionGate's `updateInFlight`
   surface) covers the whole install; the new `update-overlay` event tells the splash which flow is
   live so its subline says "this window stays open while the update installs" (the fallback keeps
   the honest "the window will close for a moment" line).
4. **The watcher thread** waits on the handle (budget 10min). On success: the `update-installed`
   event swaps the splash to "vX is installed — restarting now…", the watcher relaunches the NEW exe
   at the original path (ShellExecuteW, the R91 detachment family), and exits this process 700ms
   later — the fresh instance's R118-F "Setting up vX" splash takes over seamlessly. On
   timeout/failure: the `update-install-failed` event (payload = the honest message) and the app
   LIVES ON — ConnectionGate's listener clears the flag, removes the update-restart marker, restarts
   the engine, and parks the message in the config store where the About tab's card renders it
   exactly like a rejected invoke.
5. A launch failure after a successful rename RESTORES the exe's name before erroring. The `.old`
   file left by a crash mid-flow is cleaned up best-effort at every startup
   (`update::cleanup_renamed_exe`, wired in lib.rs's setup).

### D. LINUX — THE .DEB LEG + the pid-wait relauncher

A .deb install's "Restarting into vX… → Connecting to Agent Core → still the old version" symptom
was the AppImage replace refusing ("the app is not running from an AppImage") + the R101-B recovery
restarting the engine over an un-updated app — the v0.100.0 report's shape, recurring on the packaged
install. R123:

- **The asset pick is install-type-aware** (`updaterAssetSuffixForPlatform`): the sidecar inherits
  the app's `APPIMAGE` env, so an AppImage-launched Linux picks the AppImage (the R104 atomic
  replace) and a packaged install (no `APPIMAGE`) picks the arch-matched **`.deb`** (`_amd64.deb` /
  `_arm64.deb` — dpkg's own spellings; the staged-name + plausibility-floor gates learn the kind,
  20MB floor).
- **The .deb install is VISIBLE** (`mod deb`): `pkexec dpkg -i <staged.deb>` (polkit's own GUI
  prompt is the only interaction) runs while the app STAYS OPEN on the Restarting splash — Linux can
  replace a running binary's file, so this process is never at risk — and a watcher thread waits on
  dpkg, then relaunches the exe at its now-updated path + exits. A failed dpkg (cancelled prompt,
  dependency error, timeout) emits `update-install-failed` and the app LIVES ON over the
  still-running old binary.
- **The AppImage relauncher waits for the old PID** — the R104 fixed 3s guess (which could lose the
  race to a slow WebKitGTK teardown: two instances briefly alive, cache/data contention) is retired
  for `while kill -0 <pid>; do sleep 0.2; done; sleep 1; exec <path>` — deterministic, ever.

### E. THE PROCESSING ANIMATION (the About card itself)

Every async state in the Version card now carries real motion (the owner's "no animation while it is
processing"): the Check button renders a spinner while checking; the verify state carries a spinner
+ an honestly-indeterminate pulsing bar (`motion-reduce:animate-none`); the installing line carries
the spinner. The card's honest byte-true download bar was already right and stays.

## §2 The self-feedback viewer — the parsed view + per-entry delete

The owner's first-sight complaint ("no delete button") was the CONDITIONAL Clear — the affordance
appeared only after data existed. R123's SelfFeedbackTab:

- **Clear is ALWAYS PRESENT** — disabled with the honest "Nothing to clear yet…" tooltip when empty;
  it never appears/vanishes with the data.
- **The PARSED view is the default** — `parseFeedbackEntries` (pure, exported, pinned by tests)
  splits the file on its own `\n---\n\n## Entry — ` grammar and renders one structured card per
  entry: the `#N` + timestamp + outcome chip (ok = success tone, fail/error = danger), the placement
  meta (session · project · agent, mono, ellipsized, the transcript size on the title), and the six
  sections as labeled blocks. A **Raw toggle** keeps the R122 file-as-is monospace view one click
  away (the owner's "see the raw file" contract stands).
- **The PER-ENTRY DELETE** — each card's trash button opens its own styled ConfirmDialog, then
  `DELETE /feedback/file/entry/:index` (the storage's `deleteFeedbackEntry`: the split/splice/join
  round-trip on the ledger's write chain — the survivors stay byte-identical; an out-of-range index
  is the idempotent `{removed:false}`, never a 404). Shell-only like the whole-ledger Clear (the
  same route-local device-token guard — the wipe-class split).

## §3 The mobile transcript — the reference grammar, the pulse line, the image order

Per the seven uploaded reference screenshots (the VLM analysis distilled the grammar: compact tool
rows with icon + verb + mono path + green diff chips + expand chevron; user bubbles subtle-tinted
with the image ABOVE the text; flat assistant text; honest separation between elements):

- **The pulsing line is GONE** — `LiveHeaderLine` (the 2px breathing accent bar under the identity
  bar) is deleted from the session screen; the AvatarLiveEdge ring (the glowing DP the owner
  described approvingly) is now the running turn's single chrome tell.
- **Images render ABOVE the text** in the user bubble — the pure `userBubbleBodyPlan` (images →
  text → file chips) pins the ordering the PC already had.
- **Tool rows stay VISIBLE in settled turns** — the R119 TurnBlock's activity well auto-collapsed on
  settle (the owner watched every tool row vanish behind the one-line rail: "No tool calls were
  shown to me. No file writes were shown to me."). `wellDefaultOpen(live, toolRowCount)` keeps
  tool-carrying turns OPEN through the live→settled transition; thinking-only wells keep the
  R119 collapse; the user's tap still wins.
- **The web/browser tool families render honestly** — `WEB_TOOLS`/`BROWSER_TOOLS` classifications +
  `webTargetSegment`/`browserTargetSegment` extractors (the PC's tolerance ported): rows read
  `web search · {query}`, `web fetch · {url}`, `browser control · {action url}`; the live rail
  breathes `Searching {query}…` / `Fetching {url}…` / `Browsing {url}…`.
- **The rhythm pass** — consecutive assistant segments carry a consistent gap (the "no separation
  with the elements" complaint); the block's regions keep one visual idea each.

## §4 The desktop quick-nav — rows, the gutter, the corridor

MessageTimeline (R120's bar strip) is redesigned per the owner's words: each exchange renders as a
horizontal ROW chip (10×6px at rest, 12×8 current; magnified 22×24) stacked vertically; the
dock-magnification grammar ports to BOTH legs (height + width, linear 56px falloff, 200ms CSS
transitions, reduced-motion collapse). The rail sits at `left-3` (the always-present left gutter)
and the rows right-anchor their chips so growth extends LEFTWARD into the gutter — the chip's right
edge (facing the transcript text) never moves. The pointer surface is an invisible 32px corridor
(hovering NEAR a row on either side registers — the owner's "I can just directly hover near it"),
bounded by the corridor's pointerleave + the falloff radius (the "limit"). The pointer-owned preview
popover, click-to-scroll, keyboard focus, and the R5 no-hover-pairs law all carry over.

## §5 Verification

- **agent-core**: tsc clean; vitest **153 files / 2833 tests** (was 2825) — the r89-updates suite
  rewritten to the anonymous-first contract (46 tests: the dead-token-never-degrades pin, the
  token-retry matrix, the `rate-limited` reason, the download inversion, the DELETE-token route, the
  install-type asset matrix incl. the .deb rows); the r122-feedback-routes suite +3 (the per-entry
  split/splice/join, the stale-index no-op + the 400, the device-token 403 on the entry delete).
- **root**: tsc clean; eslint 0; vitest **268 files / 4676 tests** (was 4661) — AboutTab 27 (the
  anonymous-first row visibility, the rate-limited auto-open, the Remove flow, the flow-aware
  fallback assertions) + SelfFeedbackTab 12 (the parser pins, the per-entry delete with the survivor
  re-render, the always-present-but-disabled Clear) + ConnectionGate 13 + MessageTimeline 10 (the
  row grammar, the corridor, the gutter, the magnification math). Design audit: the four genuine
  violations fixed first (3× `text-[10.5px]`, 1× `text-[11.5px]`, `max-h-[480px]`, `tracking-[0.06em]`
  → snapped to the ladder/scale), the remaining +15 are ALL TOKENS §2 documented ladder steps
  (11 label / 12 ui / 10 micro / the AboutTab's existing `max-w-[420px]` idiom) — baseline re-pinned
  1611→1626 via the tool's sanctioned path, the math recorded here. Build green (mermaid chunk ok);
  e2e 12/12; license clean (299 deps).
- **mobile**: tsc clean; jest **44 suites / 969 tests** (was 43/959) — the new
  transcript-turn suite (the body plan + the well law), the turn-block/streaming-args family
  extensions.
- **LIVE PROOF** (the dist booted on a scratch DB): `GET /system/updates` against REAL GitHub
  answered the new contract verbatim — the anonymous leg rate-limited (this sandbox's shared IP),
  the route answered `reason:"rate-limited"` + `tokenSaved:false` + the optional-token copy;
  `DELETE /system/updates/token` answered `{removed:false}` with no token and `{removed:true}` with
  a planted file (the file verified gone, the next check `tokenSaved:false`); the feedback
  entry-delete answered `{removed:true, entries:2}` for the middle of three entries (ONE and THREE
  kept byte-identical, TWO gone), the stale index `{removed:false}`, the garbage index the honest
  400.
- **Rust**: no local toolchain (the sandbox discipline — CI is the gate); the code is
  review-verified against windows-sys 0.59's signatures and the repo's own FFI precedents
  (wincred.rs/silent_launch.rs), and the push triggers ci.yml's Windows cargo check + the
  rust-checks.yml Linux legs on the src-tauri/** change.

## §6 The honest deferred list

- The Windows overlay + the .deb leg need REAL installs to fully verify (the rename trick under real
  AV, pkexec's prompt on a real desktop) — the sandbox cannot run Windows or install debs; the
  flows carry explicit fallback ladders and honest failure events for exactly that reason.
- The reference screenshots' deeper grammar (message action footers, Q&A/Plan cards, the light-theme
  mobile skin) remains future surface — this round shipped the structural pieces the owner named.
- The menu-timer hover ratchet (21 pairs) and the release-flow speed round stay queued (R121's list).
