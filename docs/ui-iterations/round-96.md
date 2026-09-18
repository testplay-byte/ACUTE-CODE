<!-- last-reviewed: 2026-09-18 round-104 -->
# Round 96 — the seventh-walkthrough round (v0.93.0 → v0.94.0)

<!-- round: 96 -->
<!-- version: 0.94.0 -->

The owner's seventh walkthrough (2026-09-13, against v0.93.0). The
satisfied surface grows — the in-app updater worked end to end (download,
downloader, install, restart) and the Models & Providers overhaul landed
exactly as specified ("very good-looking, proper, exactly how I wanted
it… all the things which I mentioned to you were working properly") — and
the round now aims at the two big structural asks: **a much smarter, more
capable agent** (precision, batching, search, large projects, skills) and
**a browser that finally feels like part of the application**.

## §0 The owner's report, itemized (the round's contract)

Every item below traces to the owner's words. This is the definition of
done for the round; the workstream map follows.

1. **The thinking area STILL does not auto-scroll to the very bottom**
   (third report of this class). — workstream E.
2. **Reasoning levels are not detected for the model he tested** (a model
   that supports high and max showed the default options). — workstream F.
3. **The agent could not open the created HTML file in the right-side
   browser** — it typed the correct URL but the panel "was not showing
   things properly", while pasting the URL MANUALLY worked. — workstream G.
4. **The browser is "not native enough… not a part of our app itself"** —
   the owner wants it built INTO the app so the agent has full capability
   over it. — workstream G.
5. **Hovering the total token usage hides the browser** ("Browser paused
   while the menu is open" — "this is not a great experience"). —
   workstream G.
6. **Make the agent much smarter**: handle complex problems; edit larger
   files easily; target changes precisely; handle large projects (hundreds
   of files) and track them; proper prompts and proper tools; precisely
   target the file + text (with variants) instead of analyzing the whole
   HTML; run BATCH commands in a single go instead of one-then-wait. —
   workstreams C + D (+ the research leg A).
7. **The chat window needs better handling**: show details properly; when
   it edits a file it does not show WHICH parts changed and HOW (modern
   IDE diff behavior). — workstream H.
8. **The loop guard is way too bad** — it stopped a model that was
   legitimately reading a file in parts (first half, second, fourth,
   fifth, sixth…) claiming a loop; the guard should only fire on EXACT
   repetition (same response again and again / the exact same task with
   everything exactly the same); when it fires it must **WARN ONLY and
   pass the generation**, never end it; and it showed "generation failed"
   instead of a loop-guard warning. — workstream B.
9. **The stuck stop button**: after the loop-guard stop the bottom still
   offered "stop generation"; clicking it said "Stopped by user" but the
   generation state stayed live until a project switch. — workstream B.
10. **The context window must not show the token value alongside the
    donut** (hover-only is the wanted shape). — workstream H.
11. **Needless split reads**: the model read an HTML file in parts when it
    could have read it whole in one go; search should use smarter
    techniques than checking every file (modern agentic IDE behavior). —
    workstream C (+ D).
12. **"Generation failed" AFTER a successful completion** —
    `PROVIDER_ERROR: The last message must have role=user.` on
    `deepseek-v4.1-flash:free` (attempts: 2) after the task completed and
    the chat finished properly. — workstream B.
13. **A proper SKILLS SYSTEM**: planning / UI / error-testing / and more;
    NOT in the prompt by default — the agent requests what it needs based
    on the task, and can SEARCH the skills; the main prompt only guides
    (capabilities, what skills exist). — workstream D.
14. **Rate limiting** on the free models must be handled properly. —
    workstream B.
15. **Installer write errors** ("Error opening file for writing:
    win32 x64.node", then node.exe — Ignore-clicked). — workstream I.
16. **Analyze the open-source agentic environments** (Claude Code, Kilo
    Code, OpenCode, …) and work based on them. — workstream A.
17. **Self-test with a very large project** in our own environment with
    the free models. — workstream J.
18. **Document everything well** (where things are, how implemented, why
    that way) so future edits are easy; push to the repo regularly; ntfy
    progress notifications; the final THE-TASK-IS-DONE ping. —
    workstream K (continuous).

## §1 Workstream map (with the root-cause notes from the survey)

| ID | Scope | Root cause / plan (survey-verified) |
|---|---|---|
| A | Research: Claude Code / Kilo Code / OpenCode / Cline / Aider | `docs/research/agent-architectures-r96.md` — adopt/reject decisions feeding C+D |
| B | Agent core loop reliability | Loop guard compares the DISPLAY SUMMARY (`summarizeArgs` drops numeric args — offsets/lengths — so paged reads of the SAME file look identical); guard semantics must become warn-only; `continueIfUnfinished` re-calls the provider with an assistant-last history (DeepSeek rejects: "The last message must have role=user") AND retries a deterministic shape; the error frame path leaves the stop affordance stuck; 429/Retry-After handling |
| C | Tools: precision + power | read_file pages by default (marker machinery exists — flip the default to whole-file-under-budget); search_code lacks regex flags/context lines/gitignore; edit_file is single-edit only (add multi-edit + whitespace-normalized fallback + a diff in the result); batch tool calls (parallel execution of one step's calls + prompt guidance) |
| D | Prompts + skills | Precision/batch/verify discipline in the main prompt; new skills (planning, UI, error-testing, large-project navigation); search_skills tool; keep names+descriptions-only in the prompt |
| E | Thinking area live wiring | **Found it**: a live thinking entry in a segment with NO tool entries renders via `BareWorkingEntries`, which never passes `live` → no auto-expand, no stick-to-bottom, no jump pill — exactly "thinking before the first tool call", the norm |
| F | Reasoning levels | The vocabulary folds `max`→`high` and drops `xhigh` (the owner's model — `deepseek-v4.1-flash` — carries `['max','high','low']` live: the folded menu is indistinguishable from the defaults); legacy models stored before R95 never re-merge capabilities; the detection is INVISIBLE (no detected-ladder note, no default_effort) |
| G | Browser experience | The ContextDonut hover popover is a DOM overlay that geometrically intersects the native webview → the guard hides it ("Browser paused"); the agent-navigate path diverges from the address-bar path somewhere between the tool and the webview drive; general native-feel polish |
| H | Chat UX | The edit snapshots (`recordSnapshot`) exist but never render in chat; tool lines lack exit code/duration detail; the donut's inline measured value must move to hover-only |
| I | Installer | The NSIS installer hit locked files — the sidecar (and its children) were still running when quitAndInstall fired |
| J | Live-fire (large project) | The r96 harness: a synthetic ~300-file project + the REAL OpenRouter free models; every §0 item gets a live leg |
| K | Docs + release | round-96.md (this file), CHANGELOG 0.94.0, status.json, HANDOFF, AGENT-MEMORY, ORCHESTRATION-WORKLOG, README index, ADRs, version ×4, push/CI/release, DASHBOARD data.json, ntfy |

## §2 Verification plan (the round's gates)

- Unit/type/lint: `pnpm lint` + both typechecks + the full vitest suite —
  green with our own eyes before every push.
- Per-workstream focused suites (the sub-agents pin their own behavior).
- Live legs (workstream J): the built sidecar against REAL OpenRouter with
  the free models — sequential paged reads MUST NOT trip the loop guard; a
  `['max','high','low']` model MUST wire its own tokens; a completed task
  MUST NOT end in "The last message must have role=user"; batch calls ride
  one turn; token usage stays exact (the R95 zero-deviation standard).
- Browser verification for every UI change (agent-browser screenshots; the
  VLM pass for the surfaces that changed).
- CI green on the final push; v0.94.0 released with sha256-verified assets.

## §3 Workstream E — the thinking area finally follows its own stream

**The root cause (the third report was right — it was never the scroller):**
a LIVE thinking entry in a segment with NO tool entries (the norm at every
turn's start — the model thinks before it acts) rendered via
`BareWorkingEntries`, which never passes `live` down. No `live` → no
auto-expand, no stick-to-bottom, no jump pill. The R95-D machinery was
correct but unreachable for thinking-first turns.

**The fix (commit ee1cf82):** the live-section's `isWork` check gained the
clause "the segment carrying the LIVE entry renders as a live
WorkingSection" — a thinking-first turn now gets the "Working" header, the
auto-expanding row, the stick-to-bottom scroller, and the inner
"Jump to latest" pill. Pinned by the R96-E regression test (a live thinking
turn with no tool entries → the live section + the scroller + the follow).

## §4 Workstream B — the agent core loop reliability

**The loop guard is WARN-ONLY and identity-honest (commit 02c7b80).**
The R51 guard compared the DISPLAY summary — and `summarizeArgs` DROPS
every numeric arg, so `read_file {offset:1}` and `{offset:5000}` rendered
identical ("path: big.html") and the guard STOPPED the owner's healthy
paged read at call 5. The R96 guard:
- compares the RAW args (threaded through `ChatToolCall.args` in both the
  sync and streamed adapters; display/persisted surfaces keep using the
  summary — raw args never persist or emit);
- NEVER stops (the owner: "it will only warn the user and it will pass the
  generation"): identical calls warn at 3 and re-warn every 3 more;
  consecutive failures warn at 6; the model repeating the EXACT same final
  text warns at 3 (any tool activity resets it — the owner's loop shape is
  text-only repetition);
- warns honestly: a persisted `turn.warning` event + a live SSE
  `{type:"turn.warning"}` frame — never a "generation failed" card over a
  passing turn; LOOP_GUARD is retired as a PRODUCED outcome code (legacy
  rows still render).
The owner's exact paged-read shape (offsets 1/5000/10000/…/35000 of one
file, identical summaries) is pinned in BOTH paths: zero warnings.

**Completion = the model's own stop (the "role=user" fix).** The
`continueIfUnfinished` phrase gate was the outlier (research finding #1:
every mature system ends on the model's tool-less stop) and the direct
cause of the owner's report — a tool-using final iteration without a magic
phrase forced an assistant-last continuation DeepSeek@OpenRouter rejected
with "The last message must have role=user" (attempts: 2, over WORK THAT
WAS ALREADY DONE). Now:
- a tool-using iteration with non-empty text ENDS the turn (the phrase
  survives only as the ONE todos-continuation's heuristic: unfinished
  todos + a signal-less text → exactly one user-role continuation);
- the MESSAGES-SHAPE GUARANTEE: at every provider-call boundary, an
  assistant-last outgoing list gains a user-role nudge — the shape can
  never reach the wire;
- deterministic request-shape errors classify FAIL-FAST (no blind
  retries);
- a post-completion continuation's failure KEEPS the completed answer:
  ok:true + a turn.warning ("continuation failed after the completed
  answer — the answer above stands"), never "Generation failed" over
  finished work;
- the sync path's abort-vs-completion race fixed: a stopped child reports
  the honest stop even when its in-flight answer completed (the R48-e1
  contract restored under the new break order).

**The stuck stop button.** Every terminal SSE frame (done | error |
stopped) now retires `streamBusy` AT THE FRAME — not only in the read
loop's finally, which a hanging connection never reaches — plus an 8s
watchdog force-cleans a never-settling stream (freezing the live turn as
stopped so partial work stays visible). Pinned with a never-closing-stream
regression test (the owner's "had to switch to another project and come
back" report is dead).

## §5 Workstream C — the tools precision + power round (commit 02c7b80)

- **read_file is WHOLE-file-first**: under a 48KB budget the entire file
  returns in one call (the owner: "it could have read the whole HTML file
  in a single go"); only genuinely large files page — and the marker then
  carries the file's total line count + the EXACT next call. The
  description no longer TEACHES paging.
- **search_code has ripgrep semantics**: `output_mode`
  (content / files_with_matches / count), context lines, first-class
  regex (the legacy `/pattern/` form still parses), .gitignore-respecting
  walk, binary + oversize skips, per-file match grouping with "…N more in
  this file" truncation, and honest truncation flags — the model can
  TARGET without reading everything (the owner's "smarter techniques
  rather than checking each and every single file").
- **edit_file is surgical**: atomic `edits[]` batches (all anchors
  validated in sequence, one write, the failing index reported, NO partial
  application), `replaceAll` with the count, and the ONE variant rung —
  whitespace-normalized matching, named in the output when it fires (the
  owner: "It will try its variants"). The model-facing output confirms
  precisely ("Edited path: 2 replacements, +12 −3 lines").
- **write_file** snapshots new-file creates (before=null) so the UI's
  diff story covers creates too.

## §6 Workstream D — the prompts + skills system (commit 02c7b80)

- **Three owner-directed prompt sections** (composed behind the loop and
  code-navigation, every phrase content-pinned): BATCH DISCIPLINE ("issue
  them ALL in ONE response… `a && b`… one-call-one-wait is the
  anti-pattern"), COMPLETION DISCIPLINE (the explicit "Task complete."
  ending line — the exact phrase the runtime's heuristic knows — never
  pad, never restart), PRECISION DISCIPLINE (the owner's own example:
  "CHANGE X TO Y IN FILE F: search → read F → edit the exact text →
  verify. NEVER analyze the whole project (or a whole HTML file) when one
  file and one string are named"). The D6 budget held by trimming to the
  load-bearing lines; the bound moved 22K → 23K with the rationale
  documented in both the section and the pin.
- **Four owner-named seeded skills**: `planning` (decompose → todo_write
  → verify per milestone → re-plan on surprise), `ui-design` (the app's
  design docs as spec + screenshot verification), `error-testing`
  (reproduce → read the REAL error → one hypothesis → targeted test),
  `large-project-navigation` (search-first orientation, import-following,
  context budgeting, the todo list as cross-step memory).
- **The `search_skills` discovery tool** (fuzzy over names + descriptions
  + reference titles, ranked, capped at 8, honest no-match, the
  computer-use gate respected) — the owner's "It can search for the
  skills too if it needs to."
- **The SKILLS listing is BUDGET-CAPPED** (count + char budgets; the
  seeded core lists intact on default installs; over budget → the honest
  "…and M more — search_skills to discover them").
- Migration 0036 + TOOL_NAMES + TOOL_CATALOG carry search_skills (the
  read_skill companion rule — a skill-reading agent is a skill-searching
  agent; user curation never widened).

## §7 Workstream I — the installer's locked files (src-tauri)

The v0.93 updater launched the installer BEFORE the sidecar teardown
finished; `TerminateProcess` closes handles asynchronously, so "kill
issued" ≠ "files writable" and the NSIS File instructions lost the race
twice (`win32 x64.node`, then `node.exe`). The new contract in
`update.rs` → `sidecar::shutdown_before_install`, enforced BEFORE the
installer launches: (a) graceful `POST /internal/shutdown` ask, (b) a
bounded 5s wait polling for a REAL exit, (c) the process-tree taskkill
(terminal jobs + PowerShell helpers included), (d) a 300ms
handle-release grace — only then does the installer run. Eight new unit
tests pin the ordering (graceful and fallback shapes); `cargo check` is
CI's gate (no Rust toolchain in the sandbox — honestly noted).

## §8 Verification (the full pipeline)

- `pnpm lint` clean; both typechecks clean (root + agent-core).
- **agent-core: 2,228/2,228 tests** (107 files) — including the rewritten
  loop-guard suite (16: the warn-only contract, the paged-read pins in both
  paths), the r96-prompts-skills suite (35), the r96-tools-precision +
  r96-search-precision suites (C's), the r96-reasoning-levels suite (23:
  the verbatim ladders, the legacy auto-refresh, the attribution + output
  cap wrappers), and the updated contract pins (completion semantics, tool
  counts, section counts, the golden regenerated with the R96 note).
- **frontend: 1,193/1,193** — including the R96-E thinking-first test, the
  stuck-stop-button hanging-stream regressions, the diff-block renders, and
  the donut's hover-only pins (the owner's R95-F reversal documented).
- CI runs the Windows gates (`cargo check` included — the Rust toolchain
  is absent in this sandbox, honestly noted in §7).
- **CI 34796586539 SUCCESS + Release run 34796593336 SUCCESS on 34961ab**
  (the tag push) — the Windows `cargo check` gate passed on the R96-I
  kill-order round (the sandbox-honest gap closed by CI, the round's one
  compile-level unknown).
- **v0.94.0 PUBLISHED** (release 388103373, `make_latest`, published
  2026-09-14T02:16:57Z): `ACUTE-CODE_0.94.0_x64-setup.exe` 37,660,082 B
  (sha256 `118b0487d177182d4f2f68554194cb4ac1933ba168863c75c932361b4f487ae0`)
  + `acute-launcher-kit-v0.94.0.zip` 115,232 B (sha256
  `17fbddfccf0532a3fcd8d2dd2395313863a1c8240cab97ec7c12feee6ac63fdf`) —
  both digests verified against freshly downloaded bytes (GitHub's
  server-side asset digests, exactly what the in-app updater verifies
  against); the kit scanned for real key values — clean (only prefix
  teaching text); `/releases/latest` verified pointing at v0.94.0.

## §8b The LIVE-FIRE (R96-J, commit 96f5cdf) — the owner's directive:
"test it in your own environment, give it a very large project"

`scripts/r96-live-fire.mjs`: the BUILT sidecar through a recording proxy
against REAL OpenRouter, over a **258-file synthetic project** (a widget /
service / util / test tree + a ~200KB paged-read file + the planted
precision target — all synthetic paths, nothing in this repo). The checks,
with the live outcomes:

1. **The precision task** ("In the file `src/widgets/timer-panel.js` (a SYNTHETIC path inside the temp project — not a repo path), change
   'Coffee Timer' to 'Tea Timer' — both places — and nothing else"):
   ✓ completes with a done frame (no post-completion error, no role=user
   failure), ✓ ZERO loop-guard warnings, ✓ the disk file changed EXACTLY
   (both occurrences, nothing else), ✓ the tool sequence TARGETED the named
   file (a read+edit of timer-panel, no project-root listing, ≤8 reads),
   ✓ TOKEN TRUTH (the app's finish-frame totals == the provider's reported
   usage — the R95 zero-deviation standard held on the multi-step turn).
2. **The paged read** ("read data/big-log.txt from beginning to end"): ✓
   completes, ✓ ZERO loop-guard warnings across the pages — the owner's
   false-positive report is closed live, not just in unit tests.
3. **The reasoning wire shapes**: ✓ the owner's exact model
   (deepseek/deepseek-v4.1-flash, ladder ['max','high','low'] live) with a
   Max pick sends `reasoning.effort: "max"` VERBATIM (the folded-default
   report closed); ✓ a ['low','medium'] model steps a Max pick down to
   "medium"; ✓ a ladder-less model rides the budget only (the R95 XOR
   preserved).
4. **The skills surface**: ✓ the live system prompt carries the SKILLS
   header naming both tools + the four new seeded skills + the three
   discipline sections.
5. **Batching measured** (the research's open question): the free Nemotron
   models did NOT batch tool calls through the openai-compatible path in
   this run (0 multi-tool messages) — the executor parallelizes whatever
   the model emits (research finding #3); the prompt guidance is the
   lever, the model decides. Informational, honestly reported.

**The two REAL bugs the live-fire caught (both fixed + unit-pinned):**
- **App attribution**: OpenRouter publishers gate models on app identity
  ("thinkingmachines/inkling-small:free is only available on agentic
  harnesses" — a routing-layer policy; verified live that our headers do
  not unlock it for unlisted apps, honestly documented). Every outbound
  chat-completions call now carries `X-Title` + `HTTP-Referer`
  (`withAppAttribution`, outermost in the wrapper chain).
- **The output cap**: OpenRouter PRICES an unspecified max_tokens at the
  model's FULL default ceiling — the owner's exact model was rejected with
  "You requested up to 131072 tokens, but can only afford 22738" (a
  one-word reply!). The resolved maxOutputTokens budget now rides the wire
  as `max_tokens` (`buildOutputCapFetch` — never overwriting a
  provider-set cap, standing down when the ladder-less reasoning budget
  owns the body per lesson #96's XOR).

## §9 The owner's TEST CHECKLIST (what to try on v0.94.0)

1. Send a simple build task (the coffee-timer class) and WATCH THE THINKING
   AREA: it auto-expands, follows its own stream to the very bottom, and
   scrolling up stops the follow (a small "Jump to latest" pill appears —
   clicking it works).
2. Pick the DeepSeek/GLM-class model and open the thinking menu: the
   DETECTED ladder shows (with its source) — a `max` model offers Max and
   the wire carries the model's own token, not a folded "high".
3. Let the agent finish a task that ends in a normal summary — NO
   "Generation failed / The last message must have role=user" card after
   completion.
4. Let the agent read a file in pages — the loop guard must NOT stop it;
   force a real repetition (same call, same args) and the guard WARNS in
   chat while the generation CONTINUES.
5. After any turn end (error, stop, or loop-guard warning) the bottom
   returns to the composer — no stuck "stop generation".
6. The agent opens the HTML file it just created in the right-side
   browser — the panel shows it, same as pasting the URL by hand.
7. Hover the total token usage: the popover opens WITHOUT pausing the
   browser; the donut itself shows NO inline number (hover-only).
8. Ask for a precise single-string change in one HTML file — the agent
   targets that file (search-first), reads it whole, edits with a visible
   RED/GREEN DIFF in chat, and issues independent calls in batches.
9. The updater flow installs without "Error opening file for writing".

(§3–§8 will be filled per workstream as they land, with the evidence.)
