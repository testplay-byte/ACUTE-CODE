<!-- last-reviewed: 2026-09-23 round-122 -->
# ROUND 122 — the self-feedback ledger + the GitHub Actions economy

**The owner's directive (two letters in one):**

1. *The self-feedback system* — "add a functionality in the settings, and that functionality is
   self-feedback generation. And how this functionality will work is that when it is turned on,
   then the AI agent itself will be able to give its feedback on the whole project… after each
   one of the sessions, after it has been completed, it will update the feedback file properly…
   it will tell what it was trying to do, what issue it ran into, what the problems were, what it
   expects, and everything like that. So that when I finally provide you with the feedback report
   after some time, like maybe a day or maybe a month or so, you can look at it and you can
   understand each and every single one of the things… you might think that it is similar to the
   debug functionality, but it is not… it will be for the feedbacks, like improvements, which it
   would suggest, any errors or any glitches which it found while doing the tasks, like in some
   toolcards or maybe using the browser… the agent which will be doing this will have full context
   of the whole main conversation… the feedback will not be affecting the overall normal
   functionality… it will just stop, and then if I chat, then the normal conversation will go and
   the feedback info will not be included anywhere… in the settings there will be a dedicated
   section for it, and in that section I will be able to see the raw file there too… all the
   agents will be given this single file."
2. *The workflows economy* — "some other improvements… in terms of our whole GitHub repository, its
   overall workflows, its overall GitHub actions… a lot of GitHub Actions are run even though they
   are not needed."

## §1 The design (what the owner's contract became, exactly)

### A. The trigger — what "a completed session" means in this app

MAIN sessions live `queued ⇄ running` across turns (only orchestrator CHILDREN ever reach a
terminal status), so the app's real "the session's work is completed" moment is **the turn's
terminal frame**. The reporter hooks there — one entry per completed turn (the whole streamed
exchange including queue continuations; the transcript always carries the FULL main conversation,
which is the owner's "full context of the whole main conversation" requirement).

### B. The separation — structural, not conventional

| The owner's words | The implementation's guarantee |
|---|---|
| "it will just stop" | the phase runs DETACHED in the route's `finally` — after the terminal frame, after the turn registry + heartbeat close, never awaited |
| "the feedback info will not be included anywhere" | ZERO SSE frames, ZERO session events — the ledger FILE is the only persistence; `assembleHistory` is untouched by construction (there is nothing to skip) |
| "the feedback will not be affecting the overall normal functionality" | the phase never throws (total try/catch); every failure logs to stderr and vanishes; the reporter is skipped when the setting is OFF, the dataDir is absent, the transcript is empty, or resolution fails |
| "all the agents will be given this single file" | ONE `<dataDir>/feedback.md` for every session on the machine; appends are SERIALIZED on a module-level promise chain so concurrent turns can never interleave entries |

### C. The entry format (the cold-read contract)

The file opens with a fixed self-explaining header (written once, at the first append). Every
entry is a machine-written metadata block — `## Entry — <ISO>` + Session / Project / Agent ·
provider/model / **Turn outcome** / Transcript size — followed by the model's six sections, the
exact headings the owner enumerated: **What I was trying to do · What actually happened ·
Issues & problems encountered · Glitches & anomalies noticed · Expectations vs reality ·
Suggested improvements.** The system prompt (the "highly detailed, well built" demand) frames
each section's brief, the raw-facts/no-politeness rules, and the cold-read audience ("a developer
of ACUTE-CODE… weeks or months from now, with no other context").

### D. The gate — the debug analyst's exact discipline

The reporter fires on ok turns, on real failures (status ≥ 500 — the transcript carries the
persisted ERROR line, so failure sessions are the MOST valuable feedback), and on route crashes.
A deliberate stop (ABORTED) and validation conflicts (404/409) never report — a turn that never
ran has nothing to say. The reporter's model/provider mirror the final turn's (the R82 override
rules — one shared `resolveSidePhaseModel()` now serves both post-turn phases), and its spend is
metered with origin `"feedback"` (the R83 discipline: side model calls must appear in the usage
surfaces).

### E. The surfaces

- **Backend**: `GET/PUT /settings/feedback` (the domain registry + the R113 broadcast), `GET
  /feedback/file` (the raw content + honest meta; **phone-reachable** — the R109 view trust), `DELETE
  /feedback/file` (the settings viewer's Clear; **shell-only** — the route-local guard, because the
  PATH blocklist cannot split verbs on one path). The app-wide reset purges the ledger beside
  vapid.json.
- **Desktop**: the dedicated **Settings → Self-Feedback** section (id `feedback`, the System group,
  deep-link `?tab=feedback`, keyword-searchable) — the master switch card (the DebugModeCard
  pattern) + the ledger viewer card (the RAW file as-is, read-only mono block with the app-wide
  floating-pill scrollbar, the honest meta line, Refresh/Copy/Clear-with-styled-confirm). A
  settings-domain bus frame fires on every PUT and every append/clear, so an open tab
  live-refreshes both cards (the R113 invalidation pattern applied to a file).

## §2 The GitHub Actions economy

**The evidence** (the GitHub API, the last 50 runs at round start): 18 CI + 18 Mobile APK runs on
pushes to main — docs-only close-out commits included (`9ba185e`, `213e283` touch only `docs/**`;
this repo's round rhythm makes such commits FREQUENT). The owner's own registered direction
(r110-feedback #8): "Mobile APK per-push → only on tag + manual dispatch (the per-push arm64
artifact is rarely consumed; CI already gates the desktop)" + "Consider path filters on CI (skip
full verify when only docs/ changed)".

**The changes** (all four workflows YAML-validated):

| Workflow | Before | After |
|---|---|---|
| `ci.yml` | every push to main pays the full Windows verify chain + BOTH Linux Rust compile gates | `paths-ignore` (docs/**, *.md, **/*.md, shots/**) on push + PR — docs-only pushes run NOTHING; the verify job keeps the Windows `cargo check` |
| `rust-checks.yml` (NEW) | (the two Linux compile gates lived in ci.yml, running on every push) | `paths: [src-tauri/**, itself]` — a Rust-shell change still compiles on all THREE platforms; a TS/docs/mobile-only push skips both |
| `mobile.yml` | every push to main paid the full Android release build (~20 min) for an artifact rarely consumed | tags `v*` + manual dispatch ONLY — a release can never miss its APK |
| `mobile-ci.yml` (NEW) | (no cheap per-push mobile gate existed) | `paths: [mobile/**, itself]` — version consistency + the jest suite (~3 min, no JDK/gradle/expo) |

**The two-file mobile split is deliberate** (documented in-file): GitHub applies a trigger's
`paths` filter to TAG pushes too — an in-place `paths: mobile/**` on mobile.yml could let a
docs-only `v*` tag SKIP the release APK build entirely. Tags stay unconditional by construction.

**The per-push economy after this round**: docs-only push → 0 workflows; desktop-only push → CI
only; mobile-only push → CI + Mobile CI (jest, ~3 min); src-tauri push → CI + both Rust gates.
`release.yml` is untouched (tag-only + dispatch by design; the release-speed restructuring
stays a dedicated future round — it needs its own careful verification).

### §2.1 The `branches: ain]` phantom (recorded so it cannot fool another round)

The R122 plan initially "found" `branches: ain]` as long-lived YAML corruption in ci.yml (it has
rendered that way in this sandbox's terminal output since the repo's first commit, blob
`c559bd0`). **Byte-level verification (od -c) disproved it**: the filter always read
`branches: [main]` — the display pipeline eats the literal `[m` of `[main]` (an ANSI-fragment
interpretation). The repo's own history documents this exact artifact twice
(ORCHESTRATION-WORKLOG R43-2 and R97). The R122-W3 subagent refused to write the false
"fixed the corruption" provenance comment and documented the artifact instead — the right call;
ci.yml now carries the note in-file. (The real waste — 18+18 runs on main including docs-only —
was unaffected by the phantom and is fully addressed by the path filters above.)

## §3 Verification

**Gates (all re-run fresh on the merged r122 tree):**
- agent-core: `tsc` clean · vitest **153 files / 2825 tests** (was 150/2799 — the three r122 suites add 26)
- root: `tsc` clean · eslint **0** · vitest **268 files / 4661 tests** (was 261/4609 — SelfFeedbackTab 10 + the events-stream domain pin) · design-audit **clean at the re-pinned R2 1611** · build green (mermaid chunk ok) · e2e **12/12** · license clean (299 deps)
- docs:check **268/0/0** after the docs wave
- All four workflow files YAML-parsed (`yaml.safe_load`) + tab/CRLF/trailing-whitespace checked

**The design-audit re-pin (honest math):** the new tab introduced +25 R2 bracket-px instances.
Two were genuine violations and were FIXED (the `text-[11.5px]` half-pixel → 12, TOKENS "no
half-pixel steps"; the inline kicker spelling → THE ONE `Kicker` primitive). The remaining +23
are all TOKENS §2 documented ladder steps — 11px label / 12px ui / 13px section, the settings-card
idiom (93 existing `text-[12px]` across the tabs, zero `text-xs` in any settings tab) — re-pinned
1588 → 1611 via the audit's sanctioned documented-growth path. Every other rule held: R1 101/101,
R3 0/0, R4 16/16, R5 21/21 (unchanged).

**The LIVE proof** (the R121 discipline): agent-core's dist booted on a scratch DB —
`GET /settings/feedback` → `{enabled:false}` (the honest default) → `PUT {enabled:true}` → the
round-trip; `GET /feedback/file` → the honest empty state; a real entry written through the real
dist module into **the sidecar's own dataDir** (the first attempt taught the derivation:
`dirname(ACUTE_DB_PATH)`) → the live route served `exists:true, entries:1, bytes:902` with the
self-explaining header; `DELETE` → `{cleared:true, entries:1}` (the honest count) → the empty
state again. The bad-PUT 400 and the no-auth 401 legs answered live too.

**The phase contract pinned at the route level** (r122-feedback-phase.test.ts, the real
buildServer + only the AI SDK mocked): OFF → no ledger, no extra model call; ON + ok turn → ONE
entry after the stream closes, **zero feedback frames in the SSE body, zero feedback-shaped
session events**, the usage row with origin `feedback`, and the `done` frame still LAST; ON +
a provider-500 turn → the entry still lands with the failed outcome and the ERROR line in the
transcript; unknown-session → no phase at all.

## §4 Close-out

- **The self-feedback system is complete and verified at every level**: module (13 tests),
  routes (9 tests incl. the real-TLS device-token auth split), phase (4 tests), desktop (10
  tests + the events-stream pin), live boot. The owner's contract is enforced structurally —
  the conversation CANNOT see feedback because no feedback-shaped persistence exists outside
  the file.
- **The Actions economy is live**: docs-only pushes now run zero workflows; the expensive APK
  build rides tags + dispatch only; the mobile gate survives as the cheap jest leg.
- **Deferred honestly**: the release-flow speed round (the r110-feedback #8 "45–60 min → <20 min"
  target — restructuring the release pipeline deserves its own round with real-run verification);
  the menu-timer hover ratchet (21 remaining R5 pairs, the exact surface recorded in
  round-121.md §3); a MOBILE mirror of the Self-Feedback viewer (the routes are phone-reachable
  by design — the phone's tab can ride a future round); the updater round (needs a real Linux
  install).
- **The stale-reference sweep** (the W3 subagent's find-list, fixed in the docs wave):
  SETUP.md's rust-gate pointer → rust-checks.yml; ADR-0031's two ci.yml mentions carry the R122
  pointer note; TESTING.md's CI paragraph states the paths-ignore economy; release.yml's two
  in-file comments updated (behavior-free). review-phase-1.md's "no path filters" line is a DATED
  REVIEW RECORD (2026-08-21) and stays untouched as history.
