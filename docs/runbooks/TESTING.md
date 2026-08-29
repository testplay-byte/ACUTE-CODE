<!-- last-reviewed: 2026-08-29 round-47 -->
# TESTING — the verification ladder

Five layers; each has a defined "when mandatory". Rules here are binding
(`WORKFLOW.md` §4 references them). Promoted from AGENT-MEMORY lessons
(#8–#35) into one place (round-17).

| Layer | What | Runs where | Mandatory when |
|---|---|---|---|
| L1 unit | `agent-core/tests` (AI SDK **mocked**) + frontend suites | `pnpm test` / vitest | every change, with the code |
| L2 verify | lint + typecheck + test + build + license audit | `pnpm verify` | before every commit/push (== CI) |
| L3 sidecar E2E | black-box vs built `agent-core/dist` (boots, auth, seeds, CRUD) | `pnpm test:e2e` (in verify) | automatic (rebuild dist first!) |
| L4 live battery | real provider turn(s), real disk, fresh DB | sandbox, single invocation | anything touching agents, projects, tools, streaming |
| L5 browser verification | real UI against the live stack; screenshots machine-verified | sandbox, single invocation | any UI-affecting round |

**Current counts (R47, verified 2026-08-29):** `pnpm test` = **683 tests in
56 files** (671 unit + 12 e2e — the e2e split is 8 sidecar + 4 terminal-
session, both statically countable in `tests/e2e/`). Trajectory: 262 (R42)
→ 397 (R43) → 471 (R44) → 565 (R45) → 622 (R46) → 683 (R47), same counting
basis. New/changed R47 suites: `key-pool` (6, NEW — nextFreeSlot gaps/full/
bounds/dupes — the KeyPoolSection slot-collision regression),
`ModelsProvidersTab` (8, NEW — the collision through the real KeyPoolSection,
full-pool guard, key+model selector wiring + the `{slot, model}` POST body,
the reachability note, ok:false red render), `AgentFormDialog` (5, NEW —
live provider options, registry-unreachable fallback, vanished-provider,
catalog datalists, placeholder), `api` 30→56 (every new provider fn: URL/
method/body/auth + happy + error paths incl. the empty-slot 409 wording and
ok:false-at-200 semantics), `providers` 32→44 (slot probes provably carry
THAT key via Bearer capture with neither key leaking into any body; catalog
shape + 401; GET key → 404 while PUT survives), `sessions` 35→36 (disable →
PROVIDER_DISABLED, zero events appended → re-enable → the normal no-key
409), `SubAgentsTab` 9→11 (catalog failure → verbatim error + Retry, zero
rows — no silent fallback; fail-then-recover). Counting honesty note: the
per-suite deltas sum to +60; the +61 net against R46's recorded 622 includes
the R46 baseline being one short of its own CI log (run 33219573774 shows
623 root-run entries — R46's delta list summed to 58 against its recorded
+57 net). R47's 683 is exact: CI run 33243501373's log shows the same 683
root-run entries (648 passed + 35 windows-only skips on CI; the sandbox runs
them green).

## Hard rules

1. **No live AI calls in tests** (L1/L3 mock the SDK; the only live model is
   exercised in L4/L5 batteries).
2. **Fresh-DB journey gate** (lessons #31/#32): L4 runs on a throwaway
   `ACUTE_DB_PATH` and must cover the *first-user journey* — open → send →
   reply works with zero setup (default agent seeded), not just API CRUD.
3. **Disk is ground truth** for file-mutating turns: assert the file exists
   with the expected content, not just a 200 response (#35).
4. **Outcome-based completion polls, never sleeps**: poll the on-disk file or
   a specific new DOM string (#35). Verify you drove the RIGHT element
   (snapshot refs before acting).
5. **Single-invocation batteries** (#4): boot sidecar (+vite for L5), run
   everything, assert, teardown — background processes die between shell
   invocations; check for orphans after.
6. **CLI template-agent filter** (#27): `GET /agents?includeTemplates=false`
   in batteries; a template has no provider/model and 409s confusingly.
7. Rebuild `agent-core/dist` before L3/e2e after backend changes (e2e runs
   against the built dist).
8. Model on the owner's keys (R43+): free-first — default
   `z-ai/glm-5.2:free` with the OpenRouter fallback chain
   (`models:[model, openrouter/free]`); the dead `stealth/ox-alpha` is
   retired (R43). Free-tier 429 storms are REAL — expect the fallback to
   engage mid-battery and say so in the round report.

## L4 live-battery recipe

```bash
export PATH=/home/z/.local/bin:$PATH
mkdir -p .dev && rm -f .dev/<name>.db
setsid env ACUTE_TOKEN=acute-dev-local ACUTE_PORT=5178 \
  ACUTE_DB_PATH="$PWD/.dev/<name>.db" \
  ACUTE_PROVIDER_OPENROUTER="$(cat /home/z/.secrets/openrouter.key)" \
  node agent-core/dist/main.js > .dev/<name>.log 2>&1 < /dev/null &
# wait for /health; export ACUTE_BASE_URL/ACUTE_TOKEN for scripts/acute.mjs
# ...create project/agent(non-template)/session → POST message →
# ...assert files on disk + event log ordering + usage rows →
pkill -f 'agent-core/dist/main.js'   # teardown, then check for orphans
```

## L5 browser-verification recipe

- Boot sidecar + `pnpm dev` with `.env.development`
  (`VITE_ACUTE_BASE_URL` + `VITE_ACUTE_TOKEN`; **delete the file before any
  verify/commit** — lesson #12). Bypass the first-run gate with
  `localStorage.acute.setupDone=1` (lesson #11).
- Drive the real UI (snapshot refs → fill/click), screenshots at
  1920×1080 **and** a tall viewport into `docs/ui-iterations/assets/round-NN/`.
- Machine-verify each screenshot (VLM) against a checklist; numeric checks
  for centering/overflow; `agent-browser errors` + console must be clean
  (`[role=alert]` empty).
- Streaming turns: completion signal = the on-disk file or the stats row for
  THIS turn (a "tok/s" text poll can match the previous turn's stats — #35).

## CI

`ci.yml` on `main` pushes + PRs: windows-latest, `pnpm verify` +
`cargo check`. ~4–6 min; a client timeout while polling is not a failure —
re-query the run (#8). Heavy Rust builds belong on Actions, never the
owner's machine (ADR-0012).
