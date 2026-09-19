<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 103 — the release pipeline made bounded, retrying, and resumable + the stealth/union-alpha evaluation (v0.100.0's delivery unblocked)

The round the owner's report opened with a delivery failure, not a product
defect: "The GitHub releases are not being successful and they are not being
handled properly. It should not take more than 10 minutes to do a GitHub
release or such and we are getting stuck on things." That was exactly right —
the v0.100.0 tag run had been stuck for over an hour at the moment of the
report, and the round's headline is the pipeline rebuild that makes a stuck
release structurally impossible again. Alongside it, per the owner's
directives: the account/permissions audit (no account issue — the evidence
says a transient upload-path degradation met a pipeline with no defenses),
the four replacement OpenRouter keys verified, and the new
`stealth/union-alpha` model evaluated end to end. **No application code
changed this round** — v0.100.0's content is exactly what round 102 shipped;
only its delivery pipeline (and the docs) were touched.

## §0 The owner's report, itemized (the round's contract)

1. **"The GitHub releases are not being successful… we are getting stuck on
   things"** — diagnosed to the root (§1), fixed at the root (§2), and the
   fix proven against the live GitHub API before the real tag was trusted to
   it again (§2, the rig).
2. **"Don't just think about one thing… maybe some account issues or maybe
   some GitHub release issues"** — the audit ran wide: repo visibility and
   Actions billing (public repo → unlimited free Actions, ARM runners
   included), the PAT's permissions (admin: full), the workflow `permissions:`
   blocks (explicit `contents: write` where needed), account standing (four
   of five jobs in the stuck run completed normally — no account-level
   blockage is consistent with that), and GitHub's own status history for
   the window (no active incident; the nearest prior one resolved a day
   earlier). Verdict: **no account issue** — a transient degradation of the
   asset-upload path met a pipeline with zero defenses against it.
3. **"I have also updated the API keys as the old ones were deleted"** — all
   four replacement OpenRouter keys verified live (`/api/v1/auth/key`: valid,
   free tier, zero usage) and used for the model evaluation; the NVIDIA key
   is unchanged. No repo change needed (keys are entered in-app, never
   committed — the standing no-secrets rule held).
4. **"I would prefer for you to check out this new model, stealth/union-alpha
   … it has two thinking modes on and off"** — evaluated across 23 live
   calls: both thinking modes, streaming, tool calling, vision, JSON mode,
   latency, and per-key sanity. Full evidence + verdict:
   `docs/research/model-eval-union-alpha-round-103.md` (§3 summarizes).

## §1 The diagnosis — the v0.100.0 tag run, reconstructed

Timeline (UTC, from the Actions API, the job logs, and the session notifier
log — run 35243431119, final state: **cancelled, attempt 3 of 3**):

- **15:44:37** — CI run 35242208934 (main @ 0cc727d, the R102 close-out):
  all jobs **SUCCESS**. The tag discipline held — the code was verified
  green before tagging.
- **15:56:09** — the `v0.100.0` tag push creates Release run 35243431119.
  All four build jobs (launcher-kit, desktop-installer, linux-bundles,
  linux-bundles-arm64) run 15:56:12→16:03:47 and finish **SUCCESS** — both
  Linux arches, the Windows installer, and the kit all built green. Nothing
  was wrong with the round's code.
- **~16:03→16:5x** — the `github-release` job's first two attempts die on
  **"Headers Timeout Error"** while uploading the 135 MB
  `ACUTE-CODE_0.100.0_amd64.AppImage` (the notifier log, 16:56:21Z:
  "the final 135MB amd64.AppImage upload hit GitHub-side upload timeouts
  twice (Headers Timeout Error). Re-running the upload job; draft currently
  5/6 assets"). Five of six assets were already on the draft at this point.
- **16:56:25** — the re-run (attempt 3) starts. The log shows the whole
  failure cascade in six lines: it finds TWO drafts for the tag (the
  original 390864360 + a duplicate 390899349 minted by an earlier attempt),
  deletes the duplicate, then **deletes all five previously-uploaded
  assets** ("♻️ Deleting previously uploaded asset…" ×5) and starts
  re-uploading from scratch — hanging silently on the AppImage upload.
- **17:23:57** — after **27+ minutes of zero progress**, the job is
  cancelled (the owner's report was written in this window). The draft is
  left with **0 assets**. Total elapsed: **1 h 28 m** for a release whose
  healthy norm is ~10–12 m (v0.98.0: 10 m; v0.99.0: 12 m, with its
  `github-release` job taking 23 seconds end to end).

The three structural defects, named:

1. **No bounds anywhere.** The `github-release` job (and `launcher-kit`,
   and every CI job) carried no `timeout-minutes`; the softprops action
   configures no client-side timeout on its uploads. A stalled TCP
   connection therefore hangs FOREVER — undici's headersTimeout eventually
   fires (the "Headers Timeout Error" deaths) or nothing fires at all (the
   27-minute stall). GitHub's own 6-hour job limit is the only backstop.
2. **Non-idempotent retries.** Every re-run deleted the five healthy
   assets before re-sending everything — so each retry re-paid the full
   ~440 MB and re-exposed the one flaky asset, turning a 2-minute resume
   into a 30-minute gamble. One bad asset held six good ones hostage.
3. **Draft-state entropy.** Multiple attempts minted duplicate drafts for
   the same tag (the action found and "resolved" two of them on attempt 3);
   nothing owned the invariant "one draft per tag."

## §2 The fix — `scripts/release/publish-github-release.sh` (+ the workflow wiring)

The softprops action is **gone** from `release.yml`. Its replacement is a
single stdlib-only script (bash + curl + python3, both preinstalled on
`ubuntu-latest`) whose contract is the three properties the incident
proved necessary:

- **BOUNDED** — every network call has an explicit timeout. JSON API
  calls: `--connect-timeout 20 --max-time 60`. Asset uploads:
  `--connect-timeout 30 --max-time 420` **plus the stalled-transfer
  detector** (`--speed-limit 1024 --speed-time 60`: less than 1 KB/s for
  60 s = the connection is dead, abort NOW — the exact signature of the
  27-minute hang). The step carries `timeout-minutes: 15`, the job
  `timeout-minutes: 25` — a wedged upload now FAILS LOUDLY in minutes,
  with `::error::` annotations, instead of hanging for hours.
- **RETRYING** — per-asset curl retries (`--retry 3 --retry-delay 10
  --retry-all-errors`, which covers transient 5xx AND connection resets)
  plus one script-level re-attempt with a fresh connection.
- **RESUMABLE** — uploads are keyed by **(name, size)**: an asset already
  on the draft with the matching byte count is SKIPPED; a size-mismatched
  stale asset is deleted and re-sent individually. Re-running the job
  re-sends only what is missing. The six assets upload smallest-first, so
  the flaky giants go last with the small wins already banked.

Draft hygiene (the §1 cascade, owned): one draft per tag — duplicates are
deleted (oldest kept); a draft orphaned by a re-tag (its tag deleted →
GitHub reports `tag_name` as `untagged-<sha>`) is matched by name and
**re-pointed at the freshly pushed tag** in the same PATCH that refreshes
its body; a PUBLISHED release for the tag fails loudly (the re-tag
discipline: delete the release before re-tagging). The script ends with a
**byte-exact final verification** (every expected asset present, size on
the draft == size on disk, no extras, still a draft) and leaves the
release as a DRAFT — publishing stays a deliberate, verified act.

Workflow wiring: `release.yml`'s `github-release` step now calls the
script with `GH_TOKEN`/`REPO`/`TAG`/`VERSION` from the job context;
`launcher-kit` gained `timeout-minutes: 15` and `github-release`
`timeout-minutes: 25`. `ci.yml` gained `timeout-minutes` on all three
jobs (verify 30, rust-linux 20, rust-linux-arm64 20) — **every job in
both workflows is now bounded.**

**The rig — proven against the live API before the real tag trusted it.**
Four passes with a throwaway draft (`v0.999.0-r103test`, six tiny assets
with the exact contract names, all artifacts under `/tmp`):

1. **Fresh create + upload** — draft created, 6/6 uploaded and
   byte-verified. Mid-pass, the rig caught a REAL stall — curl's detector
   fired ("Operation too slow. Less than 1024 bytes/sec transferred the
   last 60 seconds") and the retry recovered transparently: the exact
   incident signature, handled live.
2. **Pure resume** — 6/6 SKIPs, draft reused, body refreshed.
3. **Stale replace** — a size-changed asset: 5 SKIPs + 1 delete/re-upload.
4. **The re-tag regression** — two drafts for the tag (one `untagged-`,
   the newest; one named, the oldest): the oldest was reused, the
   duplicate deleted, the reused draft re-tagged via PATCH, 5 SKIPs + 1
   stale replace, 6/6 verified.

Both rig drafts and the incident's emptied v0.100.0 draft were deleted
afterward — the release list held only published releases when the tag
was re-dispatched. The rig also found and fixed two script bugs before
they could ship (heredoc/pipe stdin conflicts; the untagged-draft
matching + ascending-order sort).

**The first real dispatch (run 35256890314) caught one more — exactly as
designed.** All four build jobs went green, and the new uploader FAILED
LOUDLY IN TWO SECONDS (no hang, no half-emptied draft) on a bug no
tiny-fixture rig could catch: the release body was passed as a curl `-d`
**argument**, and the real CHANGELOG.md is ~200 KB — past the kernel's
128 KB single-argument ceiling ("Argument list too long", MAX_ARG_STRLEN).
The fix: the notes payload is now WRITTEN TO A FILE and passed with
`-d @file`. The same investigation exposed a latent pre-existing defect
worth fixing in passing: GitHub silently truncates release bodies at
125,000 characters — the v0.99.0 release body is exactly that truncation
signature (124,996 chars, mid-history cut) — so the script now truncates
DELIBERATELY at a paragraph boundary with an "older entries live in
CHANGELOG.md" pointer. A fifth rig pass with the REAL 200 KB CHANGELOG
proved the fixed path end-to-end (draft created, 6/6 assets, body at a
121,432-char clean cut), and the rig fidelity lesson went into
AGENT-MEMORY #104(g): fixtures must match the real payload's SHAPE, not
just its names.

**The second real dispatch (run 35258020425) met the real enemy — and the
design held.** With the argv fix in, the uploader banked the kit, the
Windows setup, and the amd64.deb (catching and recovering from one real
mid-upload stall on the way) — and then hit **uploads.github.com's
intermittent 500 window**: the arm64.deb got HTTP 500 nine times in a row
for ~5 minutes (each after the FULL 67 MB was sent), while other assets
succeeded; the window healed, and the re-run uploaded that same asset
fine 3 minutes later — only for the amd64.AppImage to take its turn
(attempt 2: nine 500s; attempt 3: a zero-byte stall that the detector
caught at 60 s and the 420 s max-time then bounded; the endpoint was so
degraded that a 30-byte probe took 17.7 s). Every failure was LOUD and
BOUNDED — 2 s, 8 min, 8 min, 15 min — never a hang, never a
half-emptied draft (the incident's 0-asset ending never recurred; every
attempt left the banked assets intact and the re-runs SKIPped them).

**The finish — operator banking + the resumable contract.** With the
endpoint too sick for the runner's 15-minute ceiling but healthy from
the operator's sandbox (a 5 MB probe flew at 2.2 MB/s), the last two
AppImages were uploaded MANUALLY: the run's own artifacts were
downloaded (201 MB + 199 MB at ~1.9 MB/s), extracted, byte-matched
against the runner's own log numbers, and uploaded with a patient
retry loop — both landed on the FIRST attempt. Then the job was re-run
one last time: **6 SKIPs + the byte-exact final verification, GREEN in
nine seconds of script time** (run attempt 4). CI 35258001371 green on
the same commit; the release was PUBLISHED (id 390953974, latest) with
all six assets. The 500-window defenses learned on the way (the
500-COMMIT-RACE landed-check — a failed upload may still have committed
server-side; the 30/60/120 s backoff ladder; `Expect:` dropped to skip
the 100-continue round-trip; failure-body logging; state-aware asset
rows — a non-"uploaded" row is deleted, never trusted; step/job
ceilings raised to 20/30 min to let the ladder ride out a window) are
in the script on main for every FUTURE release.

## §3 The model evaluation — `stealth/union-alpha` (the short version)

Full evidence, response fragments, and the 23-call latency table:
`docs/research/model-eval-union-alpha-round-103.md`. The essentials:

- **The "two thinking modes" are not at the API level.** OpenRouter lists
  no `reasoning` in the model's supported parameters; empirically the
  object form (`{"reasoning": {...}}`) is accepted-and-silently-dropped
  (`message.reasoning` always `null`, `reasoning_tokens` always 0, token
  counts identical to baseline), the legacy boolean form is **rejected
  with HTTP 400** ("expected object, received boolean" — OpenRouter's own
  schema validation), and there is no `:thinking` variant (404). Any
  thinking on/off toggle for this model must be client-side prompt
  engineering.
- **What genuinely works:** tool calling (non-streaming AND streaming —
  textbook OpenAI-style deltas, valid JSON arguments, proper call ids),
  enforced JSON mode (`response_format: json_object` held even against an
  adversarial "plain prose, do not use JSON" instruction), vision (a
  4×4 red PNG correctly described), and SSE streaming with `[DONE]`.
- **What doesn't:** latency — 1.4 s to 40.1 s on *identical* trivial
  prompts (the same one-liner took 2.6 s, 9.1 s, 11.4 s, and 40.1 s on
  four runs), ~10 s typical TTFB, sentence-sized stream chunks, and
  unreliable token accounting. Free (0/0 pricing), 256K context, all
  four replacement keys work with it, no rate-limit headers observed.
- **Verdict:** not a primary-model candidate for an agentic coding
  assistant (the latency variance compounds across multi-step tool
  chains); reasonable as a **free experimental/vision fallback** where
  10–40 s turns are tolerable. No catalog change made this round — the
  owner's call with the evidence in hand. The app already supports it
  today via the BYO-key OpenRouter provider with a custom model id.

## §4 The verification numbers

- **v0.100.0 PUBLISHED** — release 390953974, latest, six assets:
  `ACUTE-CODE_0.100.0_x64-setup.exe` 38,746,943 B + `amd64.deb`
  67,291,130 B + `amd64.AppImage` 134,990,328 B + `arm64.deb`
  67,240,846 B + `aarch64.AppImage` 132,729,352 B + the launcher kit
  125,148 B — every asset byte-verified on the draft by the workflow
  itself before publication.
- **Release run 35258020425: SUCCESS** (attempt 4 — the resumable
  contract: 6 SKIPs + byte verification after the operator banked the
  last two AppImages through the 500 window). **CI run 35258001371:
  SUCCESS** on the same commit (322304e; the earlier CI 35256890313 was
  also green on 3c125ab).
- **The rig: 5/5 passes green against the live GitHub API** (§2) — the
  original four plus the real-CHANGELOG argv regression pass; one pass
  caught a real mid-upload stall and recovered transparently.
- **Both workflows YAML-validated; every job in both carries a
  `timeout-minutes`** (release: 15/30/30/30/30; CI: 30/20/20).
- `bash -n` clean on the script; executable bit set; stdlib-only (bash,
  curl, python3).
- **No application code touched** — the root suite is byte-identical to
  the R102 close-out (208 files / 3,823 passed); lint, typecheck,
  `version:check` (×4 at 0.100.0), and `docs:check` (223 docs / 0
  failures) green on the round's tree.
- The release list was verified clean (published releases only) before
  each tag re-dispatch; the incident's two zombie drafts, the rig's
  drafts, and the argv-pass draft are all gone.

## §5 The round's lessons (also AGENT-MEMORY #104)

- **A release pipeline is production infrastructure — bound it.** "Green
  but slow" must fail loudly in minutes, not hang silently for hours. An
  unbounded job is an outage with a delay: the owner's 10-minute
  expectation is a REQUIREMENT on the pipeline, and `timeout-minutes` on
  every job is now law in both workflows.
- **Idempotency is the difference between a 2-minute re-run and a
  30-minute one.** Key every uploaded artifact by (name, size) and SKIP
  what is already done; one flaky asset must never hold six healthy ones
  hostage. The incident's most expensive defect wasn't the hang — it was
  the re-run DELETING the banked progress before re-gambling.
- **For the one step that moves 400 MB, raw curl with explicit bounds
  beats a popular action.** Third-party actions are black boxes in
  exactly the failure mode that matters — no timeout on the wire, no
  resumability, opaque retry policy. The 23 lines of curl that replace
  softprops here are auditable, bounded, and provable against the live
  API.
- **Prove release infra with a throwaway rig before betting the real tag
  on it.** Six tiny files + a scratch draft exercised fresh upload,
  resume, stale replace, AND the re-tag zombie-draft path — and caught
  two real bugs plus one live stall in the process. The rig cost minutes;
  the incident cost an hour and a half.
- **Drafts orphaned by a re-tag report themselves as `untagged-<sha>`** —
  match by name or every hotfix re-tag mints an invisible zombie draft.
- **Fixtures must match the real payload's SHAPE, not just its names.**
  The tiny-fixture rig proved four behaviors and still missed the argv
  ceiling, because only the real 200 KB CHANGELOG crosses the kernel's
  128 KB single-argument limit. After the first real dispatch caught it
  (loudly, in two seconds — the round's design working), the fifth rig
  pass ran with the REAL changelog file. Match sizes and shapes, not
  just names — and keep the loud-failure path so the rig's blind spots
  surface in seconds, not hours.
- **A failed upload may still have COMMITTED — always re-check the draft
  before re-sending.** The 500 window's nastiest property is the
  commit-race: the server can return an error AFTER accepting the full
  body. The uploader now polls the draft after every failed attempt (the
  landed-check) and counts a byte-exact asset as DONE no matter what the
  error said. Corollary: never key resume on the error path — key it on
  the observed state.
- **When the platform is sick, the operator IS the retry policy.** The
  runner's 15–30-minute ceiling cannot out-wait an hours-long endpoint
  degradation — and it should not. The resumable contract is what made
  the manual finish possible: download the run's own artifacts,
  byte-match them against the runner's log numbers, bank the missing
  assets from anywhere with a patient loop, then re-run the job to get
  the formal green (6 SKIPs + verification in 9 seconds). Every failure
  stayed loud, bounded, and non-destructive — so finishing by hand took
  minutes instead of another hour of gambling.

## §6 What ships to the owner

- **v0.100.0 PUBLISHED** (release 390953974, latest) — content unchanged
  from round 102: the Linux key-store fix, the restored settings sidebar,
  the Mermaid viewer, the quiet composer, the roomy rail. The owner's TEST
  CHECKLIST remains `round-102.md` §5. The delivery itself is part of
  this round's story: three dispatches through a degraded
  uploads.github.com, every failure loud and bounded, the assets banked
  to completion (runner + operator), and the release published only
  after the workflow's own byte-exact verification went green.
- **A release pipeline that cannot hang silently**: bounded, retrying,
  resumable, one-draft-per-tag, byte-verified before the draft is left —
  plus the 500-window defenses (landed-check, backoff ladder, state-aware
  asset rows, failure-body logging) on main for every future release.
- **The union-alpha answer** (§3 + the research doc): fully functioning
  (tools/vision/JSON/streaming), genuinely free, genuinely slow — usable
  today via the BYO OpenRouter provider; the thinking on/off claim does
  not survive contact with the API, and no primary-model role is
  recommended.
