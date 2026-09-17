<!-- last-reviewed: 2026-09-17 round-103 -->
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

- **The rig: 4/4 passes green against the live GitHub API** (§2) —
  including one real mid-upload stall caught and recovered by the
  detector/retry pair, and the full re-tag regression (untagged match,
  dedupe, re-point, resume).
- **Both workflows YAML-validated; every job in both carries a
  `timeout-minutes`** (release: 15/30/30/30/25; CI: 30/20/20).
- `bash -n` clean on the script; executable bit set; stdlib-only (bash,
  curl, python3).
- **No application code touched** — the root suite is byte-identical to
  the R102 close-out (208 files / 3,823 passed); lint, typecheck,
  `version:check` (×4 at 0.100.0), and `docs:check` re-run green on the
  round's tree. The v0.100.0 re-dispatch references live in the
  status.json `ci` field, per the standing discipline.
- The release list was verified clean (published releases only) before
  the tag re-dispatch; the incident's two zombie drafts and the rig's two
  drafts are gone.

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

## §6 What ships to the owner

- **v0.100.0, content unchanged from round 102** — the Linux key-store
  fix, the restored settings sidebar, the Mermaid viewer, the quiet
  composer, the roomy rail. The owner's TEST CHECKLIST remains
  `round-102.md` §5. What changed is the delivery: the tag was moved to
  the pipeline-hardening commit and re-dispatched through the new
  uploader, with both workflows green before publication.
- **A release pipeline that cannot hang silently**: bounded, retrying,
  resumable, one-draft-per-tag, byte-verified before the draft is left.
- **The union-alpha answer** (§3 + the research doc): fully functioning
  (tools/vision/JSON/streaming), genuinely free, genuinely slow — usable
  today via the BYO OpenRouter provider; the thinking on/off claim does
  not survive contact with the API, and no primary-model role is
  recommended.
