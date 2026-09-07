<!-- last-reviewed: 2026-09-07 round-74 -->
# Round 74 — the updater-freeze round: the launcher now picks releases by MAX VERSION, not list order (the draft-order root cause; ten regression tests; five stale drafts published)

**Date:** 2026-09-07 · **Branch:** `main` · **Version:** 0.74.0 ·
**Provenance:** the owner's round-74 field report, verbatim: *"I launched
it using the acute.bat file. It went on and processed everything. It
updated the local status, meaning the GitHub pull, and I went on and
launched the application. One thing I saw was that when I launched the
application, the installed desktop app version was 0.67.0. The
application apparently did not update. … it should update the application
properly, as it used to, without any issues."* The git-pull half of the
launcher worked; the desktop-update half silently no-op'd. This round is
the root-cause hunt and the fix — plus the one-time remediation that
un-freezes every straggling install, not just the code path.

| ID | Workstream | Files owned |
|---|---|---|
| a | Research: map the entire update pipeline (ACUTE.bat → acute_launcher.py → the release list walk → the decision ladder → the silent install → the /health verify), the release workflow's draft/publish ritual, and the git history of both — then the empirical proof of the root cause against the live GitHub API | read-only (the R74-a report in the sandbox worklog) |
| b | The fix: NEW pure `_pick_latest_release` (max version, never list order) + `_desktop_latest_release` rewritten onto it (per_page=100, one retry) + both call sites + the version-truth panel naming the tag it picked | `launcher/acute_launcher.py`, NEW `launcher/tests/test_pick_latest_release.py`, `.github/workflows/ci.yml`, `.github/workflows/release.yml` |
| verify | Hostile independent verification (9 tasks: diff review, tests, py_compile, the LIVE smoke against the real API, ACUTE.bat byte-identity, kit-assembly leak check, YAML validity, old-launcher downgrade simulation, self-update delivery proof) | read-only (the R74-b report in the sandbox worklog) |
| docs | The docs round (this file + MAINTENANCE recipe g + the launcher README + CHANGELOG + HANDOFF + status.json + the docs index + TESTING) + the version bump ×4 | `docs/**`, `CHANGELOG.md`, `HANDOFF.md`, the four version files |
| fixup | The out-of-band remediation: publishing the five never-published drafts v0.63.0–v0.67.0 (the R69+ close-out step those rounds never got) | GitHub API only — zero repo files |

## Why this round (the report, read precisely)

The owner's report has three facts and each one mattered:

1. **"It updated the local status, meaning the GitHub pull"** — the
   launcher's clone/update path (`clone_or_update`) worked; the repo on
   the owner's disk sat at the 0.73.0 tip.
2. **"the installed desktop app version was 0.67.0"** — the DESKTOP
   update path (`desktop_flow`) no-op'd, silently, without an error panel.
3. **"as it used to"** — the freeze began somewhere between the 0.67 era
   and 0.73.

The third fact is the diagnostic key. What changed between those eras
wasn't the launcher (last touched at R63, commit `6902206` — byte-stable
through every kit since) and wasn't the release workflow (last touched at
R57). It was the **release list's composition**: R69's close-out
introduced the publish-the-draft ritual, and the five R63–R67 drafts were
never given it.

## A — the root cause, proven twice (a)

`_desktop_latest_release` (the pre-R74 code) fetched
`/releases?per_page=20` and walked the list **in raw API order**,
returning the FIRST entry whose asset matched
`^ACUTE-CODE_(\d+\.\d+\.\d+)_x64-setup\.exe$`. GitHub's release list
sorts **never-published DRAFTS above every published release** — the
live API, fetched 2026-09-07, served exactly this order:

| position | tag | state | published |
|---|---|---|---|
| 1 | v0.67.0 | **draft** | NEVER |
| 2 | v0.66.0 | **draft** | NEVER |
| 3 | v0.65.0 | **draft** | NEVER |
| 4 | v0.64.0 | **draft** | NEVER |
| 5 | v0.63.0 | **draft** | NEVER |
| 6 | v0.73.0 | published | 2026-09-07 |
| … | v0.72.0 … v0.60.0 | published | … |

So the launcher's "latest installer on GitHub" line read **0.67.0**, the
owner's registry said 0.67.0, the exe on disk said 0.67.0 — three
versions agreed, the decision ladder correctly concluded *"installed
desktop app 0.67.0 is current — verified: registry, exe on disk and the
latest release all agree"*, and launched. No error, no warning, nothing
to see. **The owner was frozen at the newest draft, not the newest
release.** In the 0.63–0.67 era every release was a draft, so
first-match landed on the newest anyway — that is exactly why it "used
to work" and why the R69+ publish ritual silently broke it.

Two design assumptions died in the audit: (1) the R51 design note
claimed the walk "scans newest-first" — an ordering GitHub does not
guarantee, and demonstrably false the moment drafts coexist with
published releases; (2) `per_page=20` with the repo at exactly 20
releases was one release away from silent truncation.

## B — the fix: MAX VERSION, never list order (b)

**NEW `_pick_latest_release(releases)`** (pure: no I/O, no globals,
unit-testable): walks EVERY entry on the page, parses the version out of
every matching installer asset, and returns the **numerically greatest**
one — `_version_tuple`'s integer tuples, so `0.10.0 > 0.9.0` (the
lexicographic trap), `1.0.0 > 0.99.99`. Drafts remain first-class
candidates by design since R51 (the owner's PAT sees them — a fresh
draft is installable on the very next double-click, the
MAINTENANCE-recipe-g contract). A same-version tie — a draft and a
published release coexisting — prefers the published entry: same bytes,
but the one every token can see. Returns
`(version, asset_id, digest, info)` with `info = {tag, draft, created}`
for the panel; `None` when nothing matches. Malformed entries (non-dict
releases, `assets: null`, assets without ids) are skipped, never raised
— the new code is strictly MORE defensive than the old walk, which
raised `TypeError` on a `null` asset name.

**`_desktop_latest_release(pat)`** rewritten onto it: `per_page=100`
(one page covers the repo's entire release history for years; the
newest entry is on page 1 under every sort GitHub uses), **one retry**
on a transient network error (the download step's own pattern — first
failure warns + 2s pause, second failure falls back to the dev flow
exactly as before), then the pure picker. The never-raise contract, the
PAT authentication, and the None-fallback semantics are byte-identical
to the old behavior.

**Both call sites** updated for the 4-tuple: `desktop_flow` unpacks
`rel_info` and the version-truth panel's first line now names the
release it picked — `latest installer on GitHub    0.74.0  [v0.74.0]`,
or `[draft v0.75.0]` — so a freeze like this round's is **visible on
the owner's screen, not silent**; `mode_status`'s release line
annotates `published` / `draft, not yet published`. Everything
downstream is untouched: the decision ladder (force/repair/missing/
hybrid/upgrade/current), the never-downgrade guard, the sha256-verified
download, the silent `/S` install, the post-install registry+exe+engine
verification, the self-update mechanism, and `ACUTE.bat` —
**byte-identical, CRLF verified** (golden rule 1; the only file that
self-update can never fix, and it didn't need fixing).

**NEW `launcher/tests/test_pick_latest_release.py`** — the repo's first
Python test suite (stdlib `unittest`, zero dependencies, loads the real
module via importlib — its module level is constants-only by
construction): **10 tests** pinning the exact owner-freeze scenario
(the real 2026-09-07 API order, five drafts above the published
releases → must pick 0.73.0, with the chosen asset's id and digest —
the sha256 install verification depends on the passthrough), order
immunity in the other direction, the lexicographic trap, major-beats-
minor, the all-drafts era (updates still flow), the tie preferring
published in BOTH list orders, no-installer-assets → None, empty list →
None, malformed entries never crashing, and non-matching asset names
(arm64 / two-component / suffixed) ignored.

**CI wiring:** the suite runs in `ci.yml`'s verify job (`python`, the
push gate) and in `release.yml`'s launcher-kit job (`python3`, the
release gate) — and because `github-release` has
`needs: [launcher-kit, desktop-installer]`, the picker's regression
tests gate **every tag**. The kit assembly copies seven named files
only — `launcher/tests/` cannot leak into the shipped zip (verified).

## C — the one-time remediation (fixup)

The five drafts **v0.63.0–v0.67.0 were published** via the GitHub API
(releases 381461843, 381577121, 382282125, 383173421, 383247624 — all
HTTP 200): the R69+ close-out step those rounds never got, now given.
This is non-destructive (their assets and notes were already attached
and are unchanged), reversible (one API PATCH), and aligns the releases
page with the standing publish policy. It also immediately un-freezes
any install whose launcher is still the pre-fix code: the settled list
order now carries v0.73.0 first, so even the OLD first-match walk
returns 0.73.0 → *"upgrading 0.67.0 → 0.73.0."*

The R74-b verification simulated the old launcher against every list
state it could see (current, pre-fix, and single-draft-visible) and
proved the never-downgrade guard holds in all three — **no state of the
world can make the owner's machine go below 0.67.0.**

**The owner's next double-click, spelled out:** git pull brings the
repo (with this fix) to tip → `self_update_check` sees the kit's
0.63-era `acute_launcher.py` differ from the repo's fixed file → copies
it over and re-execs (`os.execve`, the R56 mechanism) → the FIXED
launcher runs the desktop flow → the picker picks the max version
(0.73.0 now; 0.74.0 once this round's tag lands) → *"upgrading 0.67.0
→ 0.74.0"* → sha256-verified download → silent install → registry +
exe + engine verified → launch. Nothing for the owner to do but
double-click, exactly as before.

## D — the anomalies, flagged per the owner's standing rule

- **v0.68.0 never existed.** No tag, no release — R68 bumped the
  version files and shipped the round but the tag push was skipped (the
  exact R61/R62 failure class MAINTENANCE recipe g was written for; the
  sandbox reset that ate the R67–R69 worklog entries hid it). Left as a
  documented gap: versions 0.69.0+ supersede it and a retro release
  would build CI on a stale commit for no user value. If the owner
  wants the history complete, a `v0.68.0` tag on the R68 commit would
  fill it in one workflow run.
- The per_page=20 → 100 bump covers the repo's whole history on one
  page, but the picker still trusts page 1 rather than paginating —
  documented NOT-claim, not silently assumed.

## Test counts

| suite | R73 | R74 |
|---|---|---|
| root vitest (`pnpm test`) | 2558 (2546 + 12 e2e env-gated) | **2558 — unchanged, re-run green** (launcher is Python; no TS surface touched) |
| **launcher python (NEW)** | — | **10/10** (`launcher/tests/`, wired into both CI workflows) |
| agent-core / frontend / e2e | 1637 / 909 / 12 | 1637 / 909 / 12 (unchanged) |
| lint / typecheck | exit 0 | **exit 0, re-run this round** |
| live smoke | — | the REAL `/releases` JSON through the picker → **0.73.0** (the exact data that froze the owner) — run twice, by the orchestrator and independently by R74-b |

## Live gates for the owner (this round's field questions)

1. Double-click `ACUTE.bat` (normal flow) → the version-truth panel's
   first line reads `latest installer on GitHub 0.74.0 [v0.74.0]` —
   the tag NAMED, not just a bare version.
2. The upgrade line `upgrading the desktop app 0.67.0 → 0.74.0` prints,
   the download+install+verify completes, and the app's About/onboarding
   badge shows **v0.74.0**.
3. `ACUTE.bat status` → the `release` line reads
   `0.74.0 on GitHub (published — installed is current)`.
4. If the app is ever NEWER than every visible release again, the
   panel now SAYS so (with the tag) instead of silently launching.

## NOT-claims (honest limits of this round)

- The picker trusts ONE page (`per_page=100`) — it does not paginate;
  100 releases is years of headroom, and the newest entry is on page 1
  under every sort GitHub uses.
- ci.yml uses the windows runner's system `python` (preinstalled, not
  pinned via setup-python) — pinning is future hardening, not this
  round's risk.
- The draft→publish ritual itself is unchanged (the workflow still
  opens DRAFTs; publishing remains the close-out step) — the picker
  made a forgotten publish harmless for the owner, and MAINTENANCE
  recipe g now teaches the sweep; it did not auto-publish.
- No Tauri updater plugin was introduced — the launcher remains the
  single update authority (the architecture this repo has shipped since
  R51; adding a second updater would be a policy change, not a fix).
- The old launcher on the owner's machine is fixed by the SELF-UPDATE
  path only after this commit reaches `main` — drafts published before
  the push already un-freeze it, but the code fix rides the pull.

## What's next

The R75 queue (unchanged from R73, this round inserted ahead of it by
the field report): `delegate_task` task_id/background/resume (the
deliberate R73 deferral), external plugin ctx enrichment (cline's
appendContext seam), the lessons-ledger affordance as the reminder
injector's third consumer, ratings-driven prompt tuning — plus this
round's follow-ups: the owner's live gates above, optionally the
v0.68.0 backfill tag, and the standing R69–R73 live gates.
