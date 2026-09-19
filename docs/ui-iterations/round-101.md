<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 101 — the update hand-off calm + the chat timeline + Mermaid honesty + Linux ARM64 (v0.98.0 → v0.99.0)

The twelfth-walkthrough round. The owner installed v0.98.0 on Windows, lived
through the one-click update, and filed the honest report this round answers.
The UI references the owner promised ("next time I'll give you proper
references") have NOT arrived yet — this round fixes everything fixable
without them; the visual language stays within the R100 TOKENS contract.

## §0 The owner's v0.98.0 report, itemized (the round's contract)

1. **The update install's ugly exit.** "I checked for an update and it
   properly showed me that the update is available. I installed it and after
   installing it showed me the error that the environment may be running or
   crashed or something like that. You should handle it properly. It should
   auto-restart after installing, properly stop the running things, and
   handle the things properly." → Root cause found and fixed (§2 B): the
   pre-install kill is DELIBERATE, but the 20s watchdog diagnosed the dead
   backend as a crash and replaced the whole UI with the offline error screen
   ("Can't reach agent-core… didn't come up") for the final seconds of the
   window. The auto-restart itself already worked (the NSIS `/R` relaunch
   leg — verified against the shipped template); what was missing was the
   CALM hand-off around it.
2. **The settings-page sidebar + the minimized state.** "I was definitely
   not satisfied with the overall look of the sidebar on the settings page…
   when the sidebar was minimized, it was apparently not handled properly.
   It was not looking pro-good." → §2 C.
3. **The chat composer's focus highlight.** "When I tried to type a
   message, it apparently selected the message entry area and highlighted
   it and the area around it, which was definitely not good." → The R100
   focus idiom (1.5px border + a 2px outline ring floating AROUND the whole
   composer) was the culprit — §2 D.
4. **Borders.** "I was hoping for the things to have borders around them." →
   The border inventory was verified across the chat surfaces (window card
   1.5px, bubbles/tool rows/code blocks/composer 1px) — the timeline rail
   (next) is the structural answer that makes the edges read.
5. **The timeline.** "I was hoping to see a timeline on the very left side
   of the chat window area to see the timeline of the things." → A real
   feature, not a polish: the transcript now rides a left timeline rail —
   §2 D.
6. **Mermaid.** "In the chat area it was not showing me the properly
   rendered flow diagrams as I hoped for it to be." → Four defects found
   and fixed — §2 F.
7. **Linux ARM64.** "I wanted another architecture of it… the ARM 64
   version but you apparently gave me the normal AMD 64 version." → §2 E:
   the arm64 build ships alongside amd64, native-runner-built.
8. **Meta.** "For now let's continue and improve the things which we can
   and then focus on the other things as needed." → This round is exactly
   that scope.

## §1 Sandbox state (the round opened here, per the owner's directive)

The workspace had been partially cleared: the base environment survived but
the repo needed re-verification. `/home/z/repos/acute-code` was found intact
at the R100 close-out (`main @ e2f2009`, clean, current with origin,
v0.98.0 published); `shared/` needed its deps + build restored
(`pnpm install` + `shared`/`agent-core` builds). Baseline re-verified green
BEFORE any work: **root suite 207 files / 3,798 passed (12 env-skips)** —
byte-identical to the R100 close-out count. No restore-from-remote was
needed beyond the dependency rebuild.

## §2 The workstreams

**A — sandbox verification** (above).

**B — THE UPDATE HAND-OFF CALM** (`update.rs`, `config-store.ts`,
`sidecar-connection.ts`, `ConnectionGate.tsx`, `AboutTab.tsx`). The contract
is a new `updateInFlight` store flag + a `update-installing` Tauri event
emitted by `run_update_installer` BEFORE the pre-install kill:
- the watchdog and the connect loop suppress the offline flip for a backend
  the app killed on purpose (phase=stopped mid-update holds the line;
  phase=failed still fails honestly — a real spawn failure is never masked);
- the ConnectionGate renders a calm branded **Restarting splash**
  ("Restarting into v0.99.0… installing the update — your data is kept, the
  app comes back by itself") instead of the app tree — unmounting the
  children also cancels every in-flight query, so NO error banner can flash
  during the hand-off;
- a REJECTED installer launch (the app lives on with a dead engine) now
  auto-recovers: the flag clears and `retryConnection()` restarts the
  backend — no manual "Restart engine" chore, no offline screen;
- the event is the belt-and-suspenders leg — any future entry point that
  launches an installer gets the same calm treatment even if it forgets the
  flag.

**C — THE SIDEBAR RAIL + THE SETTINGS NAV** (`Sidebar.tsx`,
`NotificationBell.tsx`, `SettingsPage.tsx`). The minimized 48px rail gains:
CSS-only hover/focus **label chips** (a `RailLabel` primitive — the full
untruncated project name is the point), the **2px leading accent bar** on
active Dashboard/Usage (mirroring the full sidebar's grammar), a **+N
overflow tile** when >10 projects (expand-first, no navigation), and the
enabling overflow fix (the rail drops its scroll; the chips must paint past
the 48px column). The collapsed bell's JS hover pair retired for the
standard CSS wash. The settings page's nav column is now a proper bordered
**pane** (`rounded-xl border`, search docked under a hairline, kickers
inside) — the IA (tabs, search, `?tab=` state) untouched.

**D — THE CHAT TIMELINE RAIL + THE COMPOSER** (`AgentChatPanel.tsx`,
`Composer.tsx`, `index.css`). The owner's two chat asks:
- **The timeline**: every transcript item (user | queued | turn | error)
  now rides a two-column grid — a 28px rail cell (20px under 560px) + the
  content. A single continuous **spine** (1px hairline, gradient-faded at
  both ends, `aria-hidden`) runs the rail's axis; each item carries a **node
  dot** (solid accent = you, hollow accent = a turn, red = error, muted
  hollow = queued) with a punch-out ring so the spine terminates AT the
  dot, an `sr-only` label, and a native `title` (hover timestamp). The
  spine's offset mirrors the content column's graduated padding by
  construction (a shared `CONTENT_H_PAD_CLASS`).
- **The composer**: the JS focus state is DELETED. Focus answers with a
  subtle border-color swap only (`.composer-shell:focus-within` — accent at
  55%, 1px width never changes, `transition-colors`): no ring, no halo, no
  layout shift. Keyboard users keep the global `:focus-visible` rule on the
  textarea itself. Drag keeps its real accent state.

**E — THE LINUX ARM64 RELEASE** (`release.yml`, `ci.yml`,
`stage-sidecar.mjs` comments, `README.md`, `SETUP.md`). A new
`linux-bundles-arm64` job on GitHub's **native `ubuntu-24.04-arm` runner**
(step-for-step twin of the x64 job — proven by a programmatic per-step diff;
the only deltas: `--platform linux-arm64`, the `node-v24.20.0-linux-arm64`
tarball, and the name verification), producing the ARM64 `.deb` +
`.AppImage` wired into `github-release` (needs, downloads, tag-verify, the
files list). Native — not cross — because node-pty has NO Linux prebuilds
and builds for the HOST arch (the stale comments claiming otherwise are
fixed). A `rust-linux-arm64` CI compile gate rides every push. **The first
push proved the runner works: `rust-linux-arm64` → SUCCESS on c35da04.**
Downstream safety verified: the launcher regex and the in-app updater
matcher both ignore non-x64-setup assets. THE FIRST TAG RUN caught the
naming asymmetry (see §3): the deb lands as `_arm64` (dpkg's name) while
the AppImage lands as `_aarch64` (the Rust triple's name) — each matches
its ecosystem's convention; the expectations + docs were corrected on the
re-tag.

**F — MERMAID, HONEST AND RESILIENT** (`MermaidDiagram.tsx`,
`WorkingSection.tsx`, `ChatMarkdown.tsx` comment, `check-mermaid-chunk.mjs`
+ the `build` chain, ADR-0030 addendum). Four defects:
1. the silent `catch {}` — errors now surface (`console.warn` + a mono
   detail line INSIDE the amber note, the cause-chain walked ≤5 hops);
2. the lazy dynamic import failing ONCE in the packaged app degraded every
   diagram forever — now one bounded retry (400ms), and a final failure
   shows its actual message ("Failed to fetch dynamically imported module"
   is finally diagnosable);
3. transient first-paint render failures — one bounded `mermaid.render`
   retry with a FRESH id (registered ids are never reused);
4. **thinking/work-section mermaid fences rendered as source forever** —
   exactly when the owner would see "not rendering" — they now render as
   diagrams (the same mount ChatMarkdown uses).
   Plus a build gate: `check-mermaid-chunk.mjs` fails every build if the
   lazy chunk stops shipping (proved live: `mermaid.core-*.js`,
   667.8 KiB — the gate caught its own initial wrong glob on the first run
   and was corrected).

## §3 The verification numbers

- **Root suite: 207 files / 3,818 passed / 0 failed** (12 env-skips) — from
  the 3,798 baseline, +20 new tests across B/C/D/F, ZERO existing pins
  broken beyond documented re-pins.
- eslint clean · both typechecks clean · `design:audit` clean at baseline
  (R1 101/101, R2 1519/1519, R3 0/0, R4 18/18, R5 31/31 — re-pinned DOWN
  by the C wave) · `docs:check` 219/0/0 · `pnpm build` green end-to-end
  with the mermaid chunk gate passing.
- **Wave-1 CI on c35da04: SUCCESS** — including `rust-linux` AND the new
  `rust-linux-arm64` (the update.rs Emitter edit compiles on both
  platforms; the ARM64 runner is live for this account).
- Version ×4 at 0.99.0; tag v0.99.0 → the Release dispatch carries the
  first arm64 bundles. **Two CI-caught hotfixes on the first tag run (the
  R100 pattern repeating, cheaper every time):** (1) the ARM64 boot gate
  PASSED and both bundles BUILT — but the AppImage lands as
  `_aarch64.AppImage` (the Rust triple) while the deb lands as `_arm64.deb`
  (dpkg), so the verify step's `_arm64.{deb,AppImage}` expectation failed
  loudly exactly as designed — the expectations + docs corrected; (2) the
  r89-updates test's hardcoded "future" tag pin (`v0.99.0`, set in R99-C)
  aged out the moment the engine reached 0.99.0 — `updateAvailable`
  flipped false in CI. The file now derives its mocked tag live from the
  engine's own manifest (patch+1, forever-green). The lesson: a version
  bump is a CODE CHANGE — run the suite after it, not just the fast gates.

## §4 The round's lessons (also AGENT-MEMORY #102)

- **A deliberate kill must be announced.** The R96-I pre-install kill was
  correct engineering; the failure was SOCIAL — every watcher of the killed
  process (the watchdog, the connect loop, every in-flight query) reached
  the honest conclusion "it crashed" because nobody told them the death was
  planned. The `update-installing` event + the suppression flag is the
  general pattern: coordinated shutdowns need a broadcast, not just an
  ordering.
- **"Auto-restart" verification needs the WHOLE arc.** The NSIS `/R`
  relaunch worked all along — but the 7 seconds around it told the owner a
  crash story. When verifying a lifecycle hand-off, verify what the USER
  SEES at every second, not just the end state.
- **A silent catch is a defect amplifier.** Mermaid never "failed" — it
  degraded silently through four different defects, three of which produced
  no diagnostics at all. Surfaced errors would have made the owner's report
  one line long instead of a guess.

## §5 The owner's TEST CHECKLIST (v0.99.0)

1. **The update arc** (the round's headline): Settings → About → Check for
   updates → Update now. Expected: the calm full-screen "Restarting into
   v0.99.0… — your data is kept, the app comes back by itself" splash; NO
   error screen at any point; the app closes, installs silently, and comes
   back by itself on the new version. (If a machine rejects the silent
   launch: the error + "Run the setup wizard manually" — and the engine
   restarts itself instead of leaving a dead app.)
2. **The composer**: click into the message box and type — only the border
   color subtly shifts to the accent; no ring, no highlight around the
   area, no size change. Keyboard users still see the focus ring on the
   textarea itself.
3. **The timeline**: open any conversation — a vertical timeline runs down
   the very left of the chat area with a node at every message/turn (solid
   = you, hollow = the agent, red = errors); hover a dot for the timestamp.
4. **The sidebar**: minimize it — hover any rail button for the styled
   label chip (project tiles show the FULL project name); active
   Dashboard/Usage carries the accent bar; with >10 projects a "+N" tile
   expands the sidebar. On the settings page, the left nav is a proper
   bordered pane with the search docked on top.
5. **Mermaid**: ask the agent for a flowchart/sequence diagram — it renders
   as a real diagram in the answer AND inside thinking/work sections. If a
   diagram genuinely fails, the note now shows WHY (the actual error line).
6. **Linux ARM64**: from the release page on an aarch64 machine (Pi
   5-class, ARM laptop, Snapdragon X dev box): `ACUTE-CODE_0.99.0_arm64.deb`
   or the `ACUTE-CODE_0.99.0_aarch64.AppImage` (the two formats name the
   arch differently — dpkg's `arm64` vs the kernel/Rust `aarch64`, each
   matching its ecosystem's convention) — same app, same agent, WebKitGTK
   panel. The amd64 builds remain for typical desktops.

## §6 Round-cumulative design audit

R1 hex 254→103 · R2 arbitrary-px 1935→1519 · R3 sub-10px 101→0 (held at
zero for the second round) · R4 heavy weights 474→18 · R5 JS hovers
243→31. This round ADDED structure (the rail grid, the label chips) inside
the token contract — every count at or below the R100 baseline, the ratchet
intact.
