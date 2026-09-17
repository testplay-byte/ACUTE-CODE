<!-- last-reviewed: 2026-09-17 round-102 -->
# Round 102 — the Linux key store made real + the settings sidebar restored + the Mermaid viewer + the quiet composer (v0.99.0 → v0.100.0)

The thirteenth-walkthrough round. The owner ran v0.99.0 on Windows AND
Linux and filed the honest report this round answers — with the headline
defect on the Linux side: the API keys "were not being properly saved at
all … nothing was happening at all."

## §0 The owner's v0.99.0 report, itemized (the round's contract)

1. **Linux API keys never save.** "The Linux version worked properly and
   installed properly without any problems … but I was having issues with
   saving the API keys. The API keys were not being properly saved at all
   in the Linux version. I tried saving them but apparently nothing was
   happening at all." → Root cause found, live-verified, and fixed at the
   ROOT (§2 A): the key shell commands were SYNC, and Tauri runs sync
   commands on the MAIN thread — a Secret Service D-Bus call that blocks
   (the keyring crate's `sync-secret-service` backend rides the C libdbus,
   whose round-trips have no deadline) froze the window with the invoke
   never resolving: literally "nothing was happening at all." Plus a
   classification defect (no-daemon errors arrive as `PlatformFailure`,
   not `NoStorageAccess`) and an honesty dead-end (the env-var hint is not
   an answer for a desktop app user).
2. **The minimized sidebar reads squished.** "The left sidebar apparently
   looks a little bit squished when it is minimized." → §2 B: the rail
   widens 48→56px with 40px buttons and 8px side insets (the 48px rail's
   36px buttons left 4.5px of breathing room per side after the borders
   and corner radii).
3. **The settings page doubles the sidebar.** "If I try to go to the
   settings page, then apparently the left sidebar does not change and the
   settings sidebar shows on the right side of the left sidebar, which is
   not perfect … handle it just like how it was handled previously." →
   §2 C: the ROUND-34 settings mode is RESTORED — on /settings the LEFT
   sidebar becomes the settings nav (back pill + search + the grouped
   section list); the settings page's own nav column (R100-E1) is deleted.
4. **Mermaid has no editing options.** "The mermaid flow diagram shows
   properly now … but apparently I don't have any editing options for it.
   I cannot zoom in on it, move it right or left, or see the raw code of
   it or anything like that." → §2 D: the diagram card is now an
   interactive viewer — zoom (toolbar + ctrl/pinch wheel, 50–300%), pan
   (drag + arrow keys), View source / View diagram, reset (button +
   double-click), all dependency-free.
5. **The composer still paints a border on click.** "When I click on the
   area, the whole area where I can paste in the message gets a border
   around it, which is not good, not perfect." → §2 E: the R101-D
   border-color swap still read as a border popping around the paste area;
   focus now paints NOTHING — the caret is the indicator (the
   Slack/ChatGPT/Discord idiom, WCAG's text-entry exception).
6. **Meta.** "Make sure to check out the sandbox environment too … make
   sure that the documentation is up to date." → §1 (intact, verified
   before any work) + this report + the ADR addendum + the CHANGELOG +
   status.json + AGENT-MEMORY #103 + the HANDOFF header.

## §1 Sandbox state (the round opened here, per the owner's directive)

The workspace was found INTACT — no restore needed: `/home/z/repos/acute-code`
at `main @ 2befe8c` (the R101 close-out), clean, current with origin,
`shared/` + `agent-core/` builds present. The baseline was re-verified
green BEFORE any work: **root suite 207 files / 3,818 passed** —
byte-identical to the R101 close-out count. One environment addition: a
minimal local Rust toolchain (1.98.1, user-local rustup — no sudo) so the
Linux key-store leg could be compiled and LIVE-verified in-sandbox (§2 A)
instead of waiting on CI round-trips.

## §2 The workstreams

### A — the Linux key store, made real (R102-A, ADR-0031 addendum)

The owner's headline defect, answered at the root with THREE fixes plus a
disclosed fallback:

- **The freeze.** The pre-R102 key commands (`store_provider_key` & co.)
  were SYNC, and Tauri runs sync commands on the MAIN thread. The
  `keyring` crate's `sync-secret-service` backend rides the **C libdbus**
  (`dbus-secret-service` → `libdbus-sys` — the round also corrected
  Cargo.toml's comment, which had claimed zbus), whose D-Bus round-trips
  block WITHOUT a deadline: a locked keyring whose unlock prompt cannot
  display, a half-dead daemon, or a slowly-probed missing session bus
  froze the whole window while the invoke never resolved. Every key
  command in `keys.rs` is now `async` (the runtime, never the main
  thread), and EVERY keyring Entry operation runs on its own thread under
  a **20-second deadline** (`wincred::imp::bounded`) — a hang costs one
  detached, bounded thread + one honest error, never the window.
- **The classification defect (live-caught).** A standalone harness
  compiled the REAL `wincred.rs` against the real `keyring` 3.6 +
  libdbus stack on this daemon-less Linux sandbox and exercised the flow
  live: the no-daemon error arrives as `PlatformFailure` ("Unable to
  autolaunch a dbus-daemon without a $DISPLAY for X11"), NOT the
  `NoStorageAccess` the round-100 code treated as "no store" — so reads
  ERRORED on every keyless provider and the write path never engaged its
  fallback. The fix: only `NoEntry` proves the service ANSWERED; every
  other verdict memoizes the service DOWN for the process (one probe per
  boot, not 20s × 12+ targets) and routes to the key file. The harness
  caught this before it could ship — the exact defect class the R100
  "sandbox cannot compile Rust" note had written off as unverifiable.
- **The disclosed key-file fallback (ADR-0031's round-102 addendum).** A
  key the Secret Service cannot take lands in
  `~/.acute/provider-keys.json` — one JSON map keyed by the canonical
  credential target, 0600 from birth (atomic tmp+rename), `~/.acute`
  tightened to 0700, lock-serialized writes, empty map → no file. Reads
  consult it whenever the Secret Service holds nothing; deletes clear
  both stores; a later successful Secret Service write RETIRES the file
  copy (migration on the next re-save). This bends SPEC §7's
  "never on disk" hard rule deliberately — owner directive + the AWS CLI
  / kubectl / gh CLI precedent (plaintext creds file, strict perms, loud
  disclosure; a hardcoded-key "encryption" would be theater).
- **The UI tells the truth.** The save commands return a `KeyStoreReport`
  (`store`: `credential-manager` | `secret-service` | `key-file`, plus the
  note); Settings renders a key-file save as an AMBER disclosure — the
  path, the perms, and how to move the key into the encrypted store —
  never a green "saved to the secure store", never a silent catch. The
  spawn loop's env injection reads through the same unified path, so a
  key-file key is injected on the next boot exactly like a keyring key;
  `purge_provider_keys` clears the file too.

Verification: the harness (a throwaway crate that `#[path]`-includes the
real `wincred.rs` against a stub `keys` module, with the libdbus dev files
relocated into a user-local prefix) ran the full matrix — **10/10 green**,
including the LIVE headless cycle: write → PlatformFailure (fast, logged)
→ key file → read-back → keyless read is `Ok(None)` (not an error) →
delete → both stores cleared → empty map removes the file.

### B — the rail geometry (R102-B)

The minimized rail widens **48→56px** (`w-12`→`w-14`) with **40px
buttons** (`w-9`→`w-10`), `px-2` side insets (8px of breathing room per
side — the squished 48px rail left 4.5px after the 1.5px borders and
16px corner radii), the rail divider `w-8`→`w-9`, the skeleton tiles and
project/overflow tiles swept to the same 40px geometry. Same expanded
240px, same 200ms width transition, label chips and selection grammar
untouched.

### C — the settings sidebar restored (R102-C)

The owner asked for the pre-R100 behavior back ("handle it just like how
it was handled previously"), and the ROUND-34 settings mode is restored
with the current design grammar:

- **ONE section list, by construction.** The section list + search
  keywords moved to `src/components/settings/settings-sections.ts`; the
  sidebar's settings mode AND the SettingsPage's `?tab=` machine render
  from the same module — the R44 id-sync discipline (the missing
  Sub-agents entry lesson) is now enforced by the compiler instead of by
  mirror-comments.
- **The sidebar's settings body:** the R95-A "← Dashboard" labeled back
  pill + the minimize control at the top; the R100-E1 search box (the VS
  Code settings-search pattern, label + keyword filtering, honest
  no-match note) below it; the grouped section list (Kicker cluster
  headers + the NavButton row grammar: 32px rows, active = accent text +
  soft bg + the 2px leading accent bar); the About row carries the
  update-pending dot.
- **The rail's settings variant (R66's behavior restored):** minimizing on
  a settings route shows back-to-dashboard + the section icons (active by
  `?tab=`) + the bell — never the projects tiles ("it shows me the wrong
  sidebar").
- **The settings page is the content pane alone:** the R100-E1 nav column
  (and R101-C's pane treatment) is deleted; the header (Kicker + title)
  and every tab mount unchanged; every `?tab=` deep link keeps working —
  the URL contract was never touched.

### D — the Mermaid viewer (R102-D)

The rendered diagram card is now an interactive viewer, dependency-free:

- **Zoom:** the toolbar's − / live-% / + buttons (25% steps, clamped
  50–300%) and ctrl/cmd+wheel (the trackpad pinch) — attached as a
  NON-passive native listener so the browser's page-zoom never fights the
  diagram zoom. Plain wheel deliberately does nothing (the transcript
  keeps scrolling through the card — no scroll traps).
- **Pan:** pointer drag (grab/grabbing cursors, pointer capture) and the
  arrow keys on the focused viewport (48px steps; shift = 4×) — fully
  operable without a pointer.
- **View source / View diagram:** the toggle swaps the rendered card for
  the raw fence in a CodeBlock (and back); the header badge row carries a
  `source` indicator while the raw view shows.
- **Reset:** the reset button and double-click restore 100% + center. A
  `code`/theme re-render resets the view (a fresh diagram starts at 100%,
  centered, diagram-side).
- The transform carries NO transition (MOTION §5 — manipulation must
  track the pointer 1:1, not animate); the R101-F render pipeline
  (laziness, retries, honest failures) is byte-untouched beneath the new
  chrome.

### E — the quiet composer (R102-E)

The R101-D treatment (a `:focus-within` border-color swap to accent@55%)
still read as "a border around the whole paste area" — the resting
hairline is nearly invisible, so the swap's first frame is a whole-box
accent border appearing. The `:focus-within` leg is deleted from
`.composer-shell`; the composer now answers focus with NOTHING: the border
stays the quiet resting hairline in every state, the TEXT CARET is the
focus indicator (the Slack/ChatGPT/Discord idiom; WCAG's text-entry
exception), and dragActive keeps its inline accent border (a REAL state).

## §3 The verification numbers

- **Root suite: 208 files / 3,823 passed / 0 failed** — from the 3,818
  baseline, +6 Mermaid-viewer tests + 5 restored-settings-mode sidebar
  tests + 2 key-store disclosure tests + the rewritten page-side and
  rail-variant pins, net +5 files' worth of growth with every documented
  re-pin accounted for above.
- **The Rust harness: 10/10 green** against the real keyring 3.6 + libdbus
  stack on a daemon-less Linux (§2 A) — including the live headless
  write→read→keyless-read→delete cycle.
- eslint clean · typecheck clean · `design:audit` re-pinned R2 1519→1522
  (three documented ladder steps: the settings-mode sidebar's 13px title +
  12px search/empty-note, the mermaid toolbar's 11px zoom label; R4 18
  HELD by fixing the new `font-bold` to `font-semibold` rather than
  re-pinning) · `docs:check` clean after the stamp refresh · `pnpm build`
  green end-to-end with the mermaid chunk gate passing (667.8 KiB) · e2e
  12/12 · license audit clean (247 deps).
- Version ×4 at 0.100.0; tag v0.100.0 → the Release dispatch carries the
  Windows setup + the amd64 pair + the arm64 pair + the launcher kit.
  CI references: see the status.json `ci` field (both workflows verified
  green before this round was declared done).

## §4 The round's lessons (also AGENT-MEMORY #103)

- **A fallback nobody can use is not honesty.** ADR-0031's round-100
  "honest fallback" for headless Linux — error + point at
  `ACUTE_PROVIDER_<ID>` env vars — was honest about the LIMIT and useless
  to the user: a desktop app owner cannot live in env vars. The round's
  real fix stores the key SOMEWHERE with loud disclosure instead of
  refusing. When a hard rule ("never on disk") collides with the product's
  core promise on some machine class, the answer is a DOCUMENTED,
  DISCLOSED exception with the rule's intent preserved — not a dead end.
- **"Cannot compile the platform" is usually "cannot compile the APP."**
  The R100 note wrote off local Rust verification because the full Tauri
  build needs WebKitGTK. But the risky NEW code (wincred's Linux imp)
  needed only keyring + libdbus + a stub `keys` module — a throwaway
  `#[path]`-include harness compiled it natively (the sandbox IS Linux)
  and caught the `PlatformFailure` classification defect that reading
  never would have. Prefer a scoped harness over no verification.
- **Sync Tauri commands run on the MAIN THREAD.** Any command touching an
  OS API with unbounded latency (D-Bus, keyrings, shells) must be `async`
  AND wrap the call in a bounded worker. The freeze the owner reported was
  not a keyring bug — it was our command shape.
- **The owner's "handle it just like how it was handled previously" is a
  spec.** R100-E1 retired the ROUND-34 settings mode to satisfy a research
  pattern (the VS Code settings-local nav); the owner rejected the result
  outright. Research patterns inform; the owner's lived preference
  decides. Restorations are cheap when the history is in git (the R98
  sidebar was one `git show` away).

## §5 The owner's TEST CHECKLIST (v0.100.0)

1. **Linux — the headline:** Settings → Models & Providers → save an API
   key. Expected: either the green "Key saved to the secure store." (a
   working Secret Service) OR the AMBER note naming
   `~/.acute/provider-keys.json` (no reachable keyring — the key STILL
   saves and works). Either way: restart the app and send a message — the
   key survives. Repeat once in the setup wizard, once in Image Analysis
   (the vision key), and once with a second pool key (Key 2) — every
   surface discloses the same way. And the app must never freeze on a
   save, even on a locked keyring.
2. **The minimized sidebar:** minimize it — the rail reads roomy now
   (wider column, bigger buttons, breathing room to the borders); hover
   for the label chips still works.
3. **Settings:** open Settings — the LEFT sidebar itself becomes the
   settings nav (← Dashboard pill, the search box, the grouped sections);
   the page is the content pane ALONE — no second column beside the
   sidebar. Minimize on a settings page → the section icons. Search
   filters the list; every `?tab=` deep link still lands.
4. **Mermaid:** ask for a flowchart — zoom with the toolbar buttons
   (the % label follows) or ctrl+scroll/pinch; drag to move it (or focus
   it and use the arrow keys); "View source" shows the raw code and
   "View diagram" returns; the reset button (or a double-click) restores
   100%.
5. **The composer:** click into the message box — NOTHING paints (no
   border, no ring, no highlight); the caret blinks; the border stays the
   quiet resting hairline.
6. **The update arc holds:** Settings → About → Check for updates →
   Update now (v0.99.0 → v0.100.0) — the calm "Restarting…" splash, no
   error screen, the app comes back by itself.

## §6 Round-cumulative design audit

R1 hex 101 (held) · R2 arbitrary-px 1519→1522 (three documented ladder
steps added with the restored settings nav + the mermaid toolbar —
13px/12px/11px, each the TOKENS §2 spelling for its tier) · R3 sub-10px 0
(held) · R4 heavy weights 18 (HELD — the round's one new heavy weight was
fixed to semibold instead of re-pinned) · R5 JS hovers 31 (held). The
ratchet intact; every delta documented above.
