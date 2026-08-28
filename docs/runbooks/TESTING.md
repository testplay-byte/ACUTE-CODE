<!-- last-reviewed: 2026-08-28 round-45 -->
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

**Current counts (R45, verified 2026-08-28):** `pnpm test` = **565 tests in
49 files**. Trajectory: 262 (R42) → 397 (R43) → 471 (R44) → 565 (R45), same
counting basis (the 8 sidecar e2e tests ride along when dist is built). New
R45 suites: `r45-security` (46 — P0-4 path-containment demotion, P0-5 host
gate decisions/rules, query scrubbing), `terminal-sessions` (23 — pipe/pty
engines, caps, idle reaping, ring buffer, the 6 routes end-to-end incl. the
SSE stream contract), `child-env` (7 — allowlist shape + secret-name
rejection + real spawn probe), `tool-catalog-drift` (2 — TOOL_NAMES vs
TOOL_CATALOG guard), SessionsScreen mobile search (+3); TerminalPanel grew
6→17 (Shell mode toggle, history, kill/new, error states).

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
