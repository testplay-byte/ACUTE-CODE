#!/usr/bin/env node
/**
 * ROUND-51 (R51-g): the SMOKE suite — one command, the critical path, ~15s.
 *
 * The owner's round-51 directive: "you actually do not need to run all the
 * [930] tests if it is resource-intensive… you should most probably have some
 * automated kind of tests, like a file which you run and it would
 * automatically test the things out and give the results back."
 *
 * This is that file. `pnpm smoke` runs a CURATED subset of the suite — the
 * tests that guard the paths the owner actually exercises (composer, live
 * streaming, sub-agents, the transcript, the browser panel, delegation,
 * the loop guard, the context report, the server's session routes) — and
 * prints a green/red verdict with timing. It is NOT a replacement for the
 * full `pnpm test` gate (which still runs once per round before a commit,
 * and in CI on every push); it is the fast daily answer to "did I break the
 * spine?".
 *
 * Curated list policy (kept in ONE place, on purpose):
 *   - every file here must run in < ~3s individually (no PTY, no e2e, no
 *     real network — the 23 PTY-skipped and 12 e2e suites are excluded);
 *   - one to three files per critical user-facing surface, covering both
 *     workspaces (frontend + agent-core);
 *   - when a round adds a new critical surface, its test file joins this
 *     list IN THE SAME ROUND (the round report documents the addition).
 *
 * Usage:  pnpm smoke            (from the repo root)
 *         node scripts/smoke.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The curated critical-path files (relative to the repo root). */
const SMOKE_FILES = [
  // ── frontend: the surfaces the owner touches every session ──────────────
  "src/components/project-chat/composer/Composer.test.tsx", // the composer (modes/thinking/model picker/donut/flyout)
  "src/components/project-chat/WorkingSection.test.tsx", // the transcript (tool rows, delegations, diffs)
  "src/components/right-sidebar/SubAgentPanel.test.tsx", // the sub-agent live panel (todo list, stats footer)
  "src/components/right-sidebar/BrowserPanel.test.tsx", // the embedded browser panel (native + proxy)
  "src/lib/stream-store.test.ts", // the SSE live-stream store
  "src/lib/api.test.ts", // the typed API layer
  // ── agent-core: the spine the surfaces stand on ─────────────────────────
  "agent-core/tests/orchestrator.test.ts", // delegation, retries, child sessions
  "agent-core/tests/runtime-loop-guard.test.ts", // ROUND-51 loop-hygiene guard
  "agent-core/tests/context-report.test.ts", // context donut + usage split report
  "agent-core/tests/permission-modes.test.ts", // the 4 permission modes
  "agent-core/tests/chat-format.test.ts", // the provider adapters (retries, effort)
  "agent-core/tests/sessions.test.ts", // the turn loop + session persistence
];

const missing = SMOKE_FILES.filter((f) => !existsSync(resolve(ROOT, f)));
if (missing.length > 0) {
  console.error("smoke: curated file(s) missing from the repo:");
  for (const f of missing) console.error(`  - ${f}`);
  console.error("Update SMOKE_FILES in scripts/smoke.mjs (the list must track the code).");
  process.exit(1);
}

const started = Date.now();
console.log(`\n▶ ACUTE-CODE smoke — ${SMOKE_FILES.length} curated critical-path suites\n`);

// One vitest invocation over the curated list (same engine as pnpm test —
// no special config, so what passes here is what passes in CI).
const run = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["exec", "vitest", "run", ...SMOKE_FILES],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, CI: "1" } },
);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (run.status === 0) {
  console.log(`\n✓ SMOKE GREEN — critical path healthy (${seconds}s).`);
  console.log("  (Full gate still runs before every commit: pnpm lint && pnpm typecheck && pnpm test)");
  process.exit(0);
}
console.error(`\n✗ SMOKE RED — the critical path is broken (${seconds}s).`);
console.error("  Fix the failures above before anything else ships.");
process.exit(run.status ?? 1);
