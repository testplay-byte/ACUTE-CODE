<!-- last-reviewed: 2026-09-26 round-129 -->
# Round 129 — the context-steward round + the sidebar & mobile transcript reworks

**Owner directive:** his device pass on v0.121.0 — the second improvement
round. What he confirmed GOOD (no work): the dashboard/usage bar hover
tooltips ("showing exactly like how they were meant to be"), the delete
confirmations ("which is good"). What he wants fixed, in his words:

1. **The General section is not to his liking** — it must sit at the very
   BOTTOM of the projects, separated by space from the normal projects;
   it must NOT be called "General" ("it will also not be called general,
   but it will be something else so that it looks proper"); and each of
   its sessions must be INDEPENDENT — "each of its sessions will get a
   separate folder in of itself… a separate workspace for itself", so
   general conversations don't pollute each other, and deleting a session
   deletes its whole folder. Deleting real projects/sessions must never
   delete their files — "This functionality will only work on the general
   ones."
2. **The project-row arrows are STILL there** — "I was shown the arrows on
   the left sides of each one of the projects, which was not good. I told
   you to remove the arrows and show the projects better, but you
   apparently did not handle it properly." (The R128 chevron was demoted
   to a presentation glyph — the owner wants the glyph GONE, not demoted.)
   Plus: separators between projects ("so that the projects are separate
   and they look much more cleaner"); a better UI for the new-session and
   delete buttons; and on hover the TEXT MUST SHRINK — "the text should
   shrink… so that there is enough space for the edit button for the
   sessions and delete buttons… and the new session button and the delete
   button for the projects" (the R128 absolute-overlay cluster covered
   the text instead of shrinking it).
3. **Context window management is "way too bad"** — "if for a very small
   task, it reaches 100 million context in no time… it takes in quite a
   lot of useless, unneeded data… it cannot handle long horizon tasks
   properly. It keeps hallucinating along the way." The directive: FIVE
   parallel research sub-agents (OpenCode, cline, oh-my-pi, kilocode,
   ZCode), each deeply studying that project's context management —
   assembly, inclusion/exclusion, compression, triggers — then "take
   references from each and every single one of them and create our own
   robust context window management system" with auto-compression at
   ~90% ("it will auto-start the compression without performing any of
   the next tasks"), modular, documented, future-proof; and reverting
   messages must revert the context.
4. **GitHub Actions economy** — "utilize as few GitHub Actions as needed…
   building only the versions which are needed, like your Linux version
   and the Windows version, and also skipping your Linux version
   sometimes if you don't need it… like skipping the Android version if
   that is not needed, and just directly doing the release and letting
   the things build by themselves."
5. **The Android transcript** — tool cards now render but "the UI is
   definitely not managed properly… it just combines everything together
   in a single session"; the tool cards "look way too cramped together";
   "the thoughts or thinking is not shown properly… it is combined with
   the tool cards"; and "the implementation of bubbles for the reply is
   most definitely not a great option. You should not utilize bubbles
   for the reply, but just directly writing the text… just like how most
   of the other modern ones handle it. It would give us much more space."
6. **Self-feedback quality** — "sometimes wrongly addresses the things."

**Method:** the playbook arc verbatim (AI-AGENT-PLAYBOOK §3): sandbox
checked + the worklog RESTORED (the R118-R120 sandbox copy merged with
the repo's R126-R128 block — the histories had diverged across sandbox
wipes); the ledger re-pulled from UPLOADED/Feedback.txt (18 entries,
byte-identical to the R128-validated pull — no new claims to validate);
the FIVE research agents dispatched FIRST (the owner's explicit
parallel-research directive) while the orchestrator surveyed the current
code; the constitution amended BEFORE any wave; backup branch
`backup/pre-r129-improvements` pushed at the green tip; then review-gated
waves (§1).

## 0. The five research reports (the owner's directive, done first)

`docs/research/{opencode,cline,oh-my-pi,kilocode,zcode}/context-management-r129.md`
— 2,195 lines of file:line-verified analysis (licenses verified:
MIT / Apache-2.0 / MIT / MIT / Apache-2.0 — all adoption-clean). The
convergent findings across all five (the synthesis the CTX waves
implement):

| # | The convergent mechanism | Who | Our gap |
|---|---|---|---|
| C1 | **Supersede-stale-reads** — older `read_file` results of a re-read path stub to "[superseded by a newer read]" | omp, cline | re-reads ride verbatim inside our 8-recent window |
| C2 | **Per-result budgets at the source + artifact spill** — hard caps per tool result; oversized output spills to a FILE with a pointer + head/tail preview | zcode, opencode, omp | only a 48K joined-block cap + 200-char stubs at replay |
| C3 | **Mechanical tiers before any LLM compaction** — supersede → prune (protect ~40K tokens, min savings ~20K) → shake → only then summarize | omp, opencode, kilo | compaction is our ONLY tier (single LLM summarize) |
| C4 | **Auto-compact at ~80-90%, awaited before the next provider call** | zcode 83%, cline 90%, kilo ~80% | we compact only at 100% of `available` (overflow-shaped) |
| C5 | **Structured summary templates** — fixed sections (Objective/State/Files/Next), deterministic ## Files appendix, prior-summary merge rules, verbatim tail | all five | free-form ~600-word prompt, no deterministic appendix |
| C6 | **Provider-anchored accounting** — the provider's own usage number + locally-estimated tail; scale by actual/estimate ratio | all five | R125-C landed the anchor; no ratio scaling |
| C7 | **Preflight output cap** — `max_tokens = min(modelMax, window − current − margin)`; free models hard-400 when prompt+cap > window | zcode, omp | we always send the full `budget.maxOutputTokens` |
| C8 | **Post-compact re-injection** — ≤5 recently-read file pointers re-injected after a compaction ("what was in the model's hands when the cut happened") | zcode (D4 — the confirmed queue item) | none |
| C9 | **Cache discipline** — stable system prefix; volatile env (date/cwd/git) OUT of the system prompt; breakpoints; batched rewrites | opencode, omp, kilo, zcode | volatile sections baked into the system prompt every turn |
| C10 | **Compaction attempt caps + honest exhaustion** | kilo 3/turn, zcode 3+breaker | the R128 rapid-refill breaker only |

SKIPs (documented in each report): opencode's ~100%-of-window trigger (our
margin is safer for free-tier models), the sidecar/shadow projection
(our append-only event + pure assembly is the same law), map-reduce
chunked compaction, shadow-git snapshots, native tokenizers, provider-
native compaction.

## 1. The wave ledger

| Wave | Surface | The owner's complaint it kills |
|---|---|---|
| F (inline) | The constitution amendments (SCREENS §2 laws 2/8/9 rewritten + the mobile chat.md transcript grammar) + this plan + the backup branch | the spec every wave implements |
| S | The projects sidebar + the Scratchpad section | the arrows still there; no separators; the button UI; hover must SHRINK the text; General misplaced/misnamed/shared-folder; deletes must only truly delete scratchpad workspaces |
| CTX-1 | The replay hygiene layer (supersede + attachment stripping + spill) in `assembleHistory` + persistence budgets | "it takes in quite a lot of useless, unneeded data" |
| CTX-2 | The steward gates (90% auto-compact awaited in-loop, structured summary + deterministic Files appendix, post-compact re-injection, preflight output cap, revert-context pin) | "100 million context in no time"; "auto-start the compression without performing any of the next tasks"; "reverting the messages should also revert the context"; long-horizon hallucination |
| GHA (inline) | The release-target selection (`scripts/release/targets.json` + the workflows) | "build only the versions which are needed… skip Linux sometimes… skip Android if not needed… directly doing the release" |
| M | The mobile transcript grammar (flat replies, thinking separate, tool cards uncramped) | "bubbles for the reply"; "combined with the tool cards"; "way too cramped together" |
| SF | The self-feedback reporter's accuracy set | "sometimes wrongly addresses the things" |

Sequencing (playbook §4.5, max 2 concurrent): S + M parallel (disjoint
trees) → CTX-1 → CTX-2 (sequential, same files) → SF (last — it imports
the CTX seams) with GHA inline alongside.

## 2. The Scratchpad design (Wave S's letter)

- **The name**: "Scratchpad" (the row name, the confirm-dialog copy, the
  UI strings). The stable row ID stays `general` (the DB rows, the
  backend guard, the frontend pin all key on it — a rename would be a
  migration for zero benefit); the boot seed updates a row still named
  "General" to "Scratchpad" (owner-renamed rows stay).
- **The placement**: pinned LAST — the projects list renders, then a
  16px spacer + a hairline + a "SCRATCHPAD" kicker row carrying the
  section's own "New chat" affordance, then the Scratchpad project row +
  its session well. The R128 pinGeneralFirst is RETIRED (law #9
  rewritten).
- **Per-session workspaces**: `sessions.root_path` (migration 0032,
  nullable) — a session created under the Scratchpad gets
  `<dataDir>/scratchpad/<sessionId>/` as its OWN workspace root
  (created at session create; threaded through the runtime as the
  effective root override for tools/environment/modes/skills). Every
  scratchpad conversation is sandboxed to its own folder — "so that the
  different general options do not get populated."
- **Delete semantics (law #8 rewritten)**: deleting a SCRATCHPAD session
  cascades the DB AND removes that session's folder (inside the
  scratchpad root only — path-shape-guarded); deleting a normal session
  or project removes APP RECORDS ONLY (the folder/files on disk are
  never touched) and the dialogs SAY so. The Scratchpad project itself
  stays delete-protected (the internal workspace).
- **The row anatomy (law #2 rewritten)**: the left chevron glyph is
  GONE (no arrows — the owner's second ask); the tile + name carries
  the row; expand state reads from the session well below + a subtle
  open-tile treatment; projects are separated by a hairline + spacing
  (the "cleaner separation"); the hover actions are RESERVED-WIDTH
  (flex) buttons that reveal on hover while the NAME TRUNCATION
  TIGHTENS (the text shrinks to make room — never an overlay that
  covers the text); the buttons share one quiet ghost grammar (law: the
  new-session and delete buttons are the SAME visual spelling).

## 3. The mobile transcript grammar (Wave M's letter)

The R119 "ONE visual turn per exchange" container (the TurnBlock's clay
card wrapping thinking + tools + reply) is RETIRED as a CONTAINER — the
owner's verdict: it "combines everything together", the tool cards are
"cramped", the thinking "is combined with the tool cards", and the reply
is a "bubble". The new grammar (chat.md §Transcript rewritten):

- **The reply is FLAT**: no card, no container — the assistant text
  renders directly on the screen background, full width, the meta line
  (model · time) above it, markdown per the house ladder, the live caret
  unchanged. "Just directly writing the text… like how most of the other
  modern ones handle it."
- **Thinking is SEPARATE**: its own collapsible row above the reply —
  "Thinking" / "Thought for Ns" label + chevron, the dim mono text
  behind the expand (the 20-line settled cap + Show all survive), never
  inside a shared well with tool rows.
- **Tool cards are PROPER CARDS**: one clay card per tool call, real
  padding (the house 12px card padding — not the well's cramped rows),
  8px gaps between cards, the icon + verb + target head line, the
  status/result line, tap-to-expand body (streaming previews, diff
  chips, terminal tails) — the R120 content logic preserved, the
  presentation un-cramped.
- **The user bubble stays** (right, accent-tinted — the modern standard;
  the owner's complaint was the REPLY bubble).

## 4. The context steward (Waves CTX-1/CTX-2's letter)

Modular by design: the pipeline lives in named, pure, individually-
pinnable stages (a new `agents/context-steward.ts` for the gates +
budgets; `assembleHistory` gains the hygiene passes; `compaction.ts`
gains the template/appendix/re-injection), documented in a new
`docs/runbooks/CONTEXT-MANAGEMENT.md` (the pipeline diagram + every
constant + where to edit each stage) — the owner's "modular so we can
easily edit any part" made literal. The stages, in order:

1. **Source budgets (CTX-1)**: per-tool result caps at persistence +
   artifact spill — an output over the budget spills to
   `<dataDir>/artifacts/<session>/<n>.txt` and the context keeps the
   head + tail + a pointer line ("full output at <path> — read it back
   if needed"). Data is never LOST, only moved out of context.
2. **Replay hygiene (CTX-1)**: superseded reads stub to
   `[superseded by a newer read of <path>]`; attachment bodies render on
   the newest turns only (older turns keep name/size stubs); the sticky
   exemptions survive.
3. **The 90% gate (CTX-2)**: auto-compaction fires when the anchored
   count ≥ 90% of `available`, AWAITED inside the turn loop before the
   next provider call (the ZCode await law — "auto-start the compression
   without performing any of the next tasks"), with the overflow force
   path and the rapid-refill breaker unchanged.
4. **The structured summary (CTX-2)**: the anchored template (Objective /
   Key decisions / Work state (done/active/blocked) / Relevant files /
   Next move) + the deterministic Files appendix (derived from the
   summarized region's tool.use events — paths read/edited/written +
   commands run; no LLM) + prior-summary merge rules.
5. **Post-compact re-injection (CTX-2)**: ≤5 most-recently-read file
   pointers as an in-memory note after each compaction (ZCode's D4).
6. **The preflight output cap (CTX-2)**: `maxOutputTokens` clamped to
   `min(modelMax, window − currentCount − 1000)` per provider call.
7. **Revert = context revert (CTX-2)**: pinned end-to-end (revert past a
   context.compact event resurrects the original messages — the pure
   assembly already implies it; the pin makes it a contract).

## 5. The honest caveats (pre-declared)

- The 90% gate's tuning is pin-level + live-battery verified; the
  owner's free-tier models' actual refill behavior is his device pass.
- The Android transcript rework is verified in the mobile jest harness +
  the design grammar; on-device rendering rides the owner's next pass.
- The Linux bundles are SKIPPED on the v0.122.0 release via the new
  targets.json (no Rust changes this round → no Linux testing need);
  Windows + the arm64 APK ship. The config is one edit away from
  including Linux when a round needs it.
- Self-feedback accuracy improvements are prompt/telemetry-level; the
  ledger's fundamental freshness-vs-accuracy tradeoff is documented.

## 6. The final gate stack + the live verification (close-out)

**The gate stack on the release tree (all fresh, all green):**
`pnpm version:check` — all 7 manifests agree on 0.122.0; mobile
lock-sync proof (`npm ci --dry-run` in mobile/, 871 packages clean);
root `tsc` CLEAN; agent-core `tsc` CLEAN; mobile `tsc` CLEAN (after a
lockfile-exact `npm ci` — the sandbox's mobile/node_modules had been
wiped between sessions; environmental, not code); FULL root vitest
**296 files / 5,205 tests** (the +1 file/+4 tests vs the CTX wave's
295/5,201 record reconciled exactly: the root sweep includes
agent-core's tests — 128 root-src files + agent-core's 168 = 296 — and
the SF wave's r129-sf-accuracy suite had only been counted in the
agent-core gate until now); agent-core vitest 168/3,090; mobile jest
48 suites / 1,096; eslint 0 findings; design-audit CLEAN at baseline
(R1 100/101, R2 1536/1635, R3 0/0, R4 15/16, R5 13/21); docs:check
283/0/0 (the servo.org/openrouter egress WARNs — the documented
sandbox-only transients); `pnpm build` SUCCESS with the mermaid chunk
gate ok; e2e 12/12 against the fresh dist; license audit clean (299
production deps).

**The live verification (agent-browser 1600×1000, a REAL sidecar on a
fresh seeded temp DB — the Wave S world re-seeded: OpenRouter provider
row, a Verifier agent, Alpha + Beta projects, three sessions, one
Scratchpad conversation):** the boot → wizard → main-app walk with ZERO
console/page errors (the update-checker's anonymous-403 warnings are
the sandbox egress class, honest, non-blocking); the sidebar laws on
the final tree — the SCRATCHPAD section LAST (data-scratchpad-section
is the list container's last child, its own hairline + kicker + New
chat), ZERO chevrons (0 leading svgs in every project row), 1 hairline
separator between the 2 normal projects, the row click expanding the
session well with the URL UNCHANGED; the hover-shrink geometry probe
(transitions disabled, the group-hover widths applied directly): the
name's column 156px → 100px while BOTH action buttons render at 28×28
with an 8px gap and ZERO overlap — the text shrinks to make room, the
buttons never cover it; the delete-materiality dialogs — normal session:
"This removes the conversation's messages and tool history from ACUTE.
The project's files on disk are NOT touched." (cancel preserved the
row), Scratchpad session: "This permanently removes the conversation
AND its scratchpad workspace folder." (the confirm click removed the
row AND the /tmp/…/scratchpad/<sessionId>/ folder from disk, the
sibling folder untouched); the chat — the composer with the context
meter LIVE ("~5% of context window projected (13k of 256k tokens,
estimated)") and its details dialog carrying the compaction line +
the honest "not yet measured" state + the composition donut; the
Workspace landing with honest counts ("3 projects · 3 sessions" — the
deleted conversation reflected). 8 screenshots in shots/r129/
(final-*).

**The honest battery caveat:** a real-provider live battery (a real
agent turn through the context steward) was NOT runnable from this
sandbox session — no model keys are present on disk (the R120 battery's
keys rode a prior session's environment). The context steward's
coverage this round is the 28 new pins + the e2e black-box suite + the
browser sweep above; the owner's free-tier device pass remains the live
battery, exactly as §5 pre-declared.
