<!-- last-reviewed: 2026-09-13 round-96 -->
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
