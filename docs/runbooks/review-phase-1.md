<!-- last-reviewed: 2026-09-10 round-83 -->
# Phase 1 Review — Architecture, API Contracts, ADRs, Repo Skeleton

| | |
|---|---|
| **Reviewer** | Reviewer sub-agent (read-only pass) |
| **Date** | 2026-08-21 |
| **Inputs** | `docs/specs/SPEC.md` (truth) · `docs/architecture/ARCHITECTURE.md` · `docs/architecture/api/API.md` · ADRs 0001–0011 · full repo skeleton (root configs, `src/`, `agent-core/`, `shared/`, `scripts/`, `tests/`, `.github/workflows/ci.yml`, `src-tauri/`, all READMEs, `docs/runbooks/SETUP.md`, `docs/compliance/dependency-licenses.md`, `docs/runbooks/plan-phase-1.md`) |
| **Verdict** | **NOT READY FOR OWNER APPROVAL YET** — 3 blocking, 12 non-blocking. The architecture and ADR set are strong and internally consistent; the blockers are (1) `@acute/shared` placeholder types contradicting the API contract *and* being locked in by type-level tests, (2) API.md missing resource contracts its own module map requires (file tree, git panel, memory editing), (3) the SPEC §8 Phase 1 exit criterion "CI green" is not yet demonstrable (workflow never ran; Rust scaffold never compiled). |

---

## BLOCKING issues

### B1 — Shared placeholder types contradict the API contract, and the tests enshrine the drift

- **File:** `shared/src/index.ts` (lines 7–58) and `shared/src/index.test.ts` (lines 12–21, 63–66)
- **Problem:** API.md §header declares "`@acute/shared` wins" on divergence — the package is normative. It currently diverges from API.md and ARCHITECTURE §5.1 on nearly every union:
  - `RunMode` = `"single" | "auto-team" | "manual"` vs API.md `"single" | "auto_team" | "manual"` (API.md lines 39, 172, 191).
  - `SessionStatus` = `created | running | awaiting-approval | completed | failed | cancelled` vs API.md §5 `queued | running | waiting_approval | completed | stopped | interrupted | error` — entirely different vocabulary (missing `queued`, `interrupted`, `error`/`failed` mismatch, `stopped`/`cancelled` mismatch).
  - `ApprovalDecision.outcome` = `approved | denied` vs API.md §7.2 `decision: allow_once | allow_project | deny` (the allow_project/deny-distinction is precisely the F6 safety semantics).
  - `AgentRecord.provider` vs API.md §4 `providerId`; `memoryPolicy` as a string enum vs API.md's object `{enabled, memoryCharLimit}`; **`visionModel` missing entirely** although SPEC §F4, ARCHITECTURE §5.1 (`vision_model?`), and API.md §4 all require the per-agent vision override; `UsageRecord` uses `provider` (not `providerId`) and omits `costSource` provenance.
  - Aggravating: `index.test.ts` asserts these exact unions with `Expect<Equal<…>>` type checks under the comment "the v1 unions must stay exactly as specified in the brief" — the test suite will *actively resist* correcting the drift in Phase 2, and the comment's conformance claim is false.
- **Why it blocks:** Phase 1's exit is owner approval of the contracts. Approving a normative type package that contradicts the contract document freezes the wrong names (`auto-team`, `awaiting-approval`, `provider`, missing `visionModel`) into Phase 2 imports; every consumer (server validation, WS events, frontend stores) inherits the error. This is the exact client/server drift the opencode single-schema lesson (ARCHITECTURE §10) was adopted to prevent.
- **Suggested fix:** Before owner approval, either (a) align `shared/src/index.ts` to API.md vocabulary and add `visionModel`/`providerId`/cost-provenance (recommended — API.md is the more complete, more recent articulation), or (b) if the shared names are what the owner's brief truly specified, fix API.md/ARCHITECTURE instead. Update the type-level tests to the reconciled unions and delete the "exactly as specified in the brief" comment (or make it true). ARCHITECTURE §10 already schedules the full TypeBox authoring for Phase 2 kickoff — the Phase 1 requirement is only that the placeholder not contradict the contract.

### B2 — API.md is missing resource contracts its own module map requires (F1 file tree / git panel, F8 memory editing)

- **File:** `docs/architecture/api/API.md` (§3 Projects, §10 Settings, §13 endpoint summary); cross-ref `docs/architecture/ARCHITECTURE.md` §3.2 (`src/screens/` ProjectWorkspace "file tree, git panel"; `src/components/` "file tree"), §3.3 (`memory/`, "user-editable" markdown)
- **Problem:** The frontend is a pure sidecar API client (ARCHITECTURE §3.2, "no business rules; all state derivable from API data"), yet:
  1. **No file-tree or file-read endpoints exist.** SPEC §F1 requires a "file-tree browser"; the ProjectWorkspace screen (F9) needs tree + file content for its editor hookup. API.md §13 has nothing between `DELETE /projects/{id}` and `GET /agents` that could feed the file-tree component declared in the module map.
  2. **No git surface for the UI.** SPEC §F1 requires git status/diff/commit "via the shell tool with approvals" — that covers *agent-initiated* git, but the human-facing git panel (F9) has no read path (status/diff) declared anywhere; it cannot go through the agent tool layer.
  3. **No memory endpoints.** SPEC §F8 requires per-agent memory "user-editable"; ARCHITECTURE §3.3 `memory/` and §5.1 `memory_entries` model the storage, and F9 §6 lists a Settings→memory screen, but API.md has no route to read or edit `MEMORY.md`/`USER.md`. (If the intended UX is "view in app, edit via external editor through `open_path_in_explorer`", that mechanism is nowhere stated.)
- **Why it blocks:** Phase 1's deliverable is the *contract set*; Phase 2/3/5 UI cannot be built against contracts that don't exist for these screens, and amending contracts after owner approval is exactly the churn Phase 1 exists to prevent. This is an ARCHITECTURE↔API.md internal inconsistency (module map declares components with no data source), not merely missing polish.
- **Suggested fix:** Add minimal resource sections to API.md (e.g. `GET /projects/{id}/tree`, `GET /projects/{id}/files?path=`, `GET /projects/{id}/git/status|diff`, `GET/PATCH /agents/{id}/memory`) — or explicitly document the alternative mechanism (external-editor workflow via the `open_path_in_explorer` command) in both API.md and ARCHITECTURE §3.2 so the gap is a decision, not an omission.

### B3 — SPEC §8 Phase 1 exit criterion "CI green" is not yet demonstrable

- **File:** `.github/workflows/ci.yml`; `docs/runbooks/SETUP.md` (machine-state table: Rust + VS Build Tools "installing … background"); `docs/runbooks/plan-phase-1.md` tasks 2/7; `src-tauri/README.md` ("compilation is deferred")
- **Problem:** The CI workflow has never executed (no remote repository — ADR-0005 itself says "runs when a remote exists"), and `cargo check` has never run locally because the Rust toolchain was still installing when Phase 1 was packaged. The entire Rust scaffold (`Cargo.toml`, `tauri.conf.json`, `build.rs`, `main.rs`, `lib.rs`, `capabilities/default.json`) is therefore *uncompiled*. Static review says it should be valid (see checks below), but tauri-build validates `tauri.conf.json` and generates the context at compile time — config errors would only surface on first compile.
- **Why it blocks:** SPEC §8 row 1 defines the Phase 1 exit criterion as "ARCHITECTURE.md, API contracts, repo skeleton, **CI green**, SETUP.md — Owner approves". Reporting Phase 1 done with the workflow never having run and the shell never having compiled does not meet the phase's own exit criterion, and risks discovering scaffold breakage in Phase 2 when it is more expensive to fix.
- **Suggested fix:** Before requesting owner approval: finish the Rust install, run `cargo check --manifest-path src-tauri/Cargo.toml` locally (and commit the generated `Cargo.lock`), re-run `pnpm verify`, and — if the owner provides the offered private repo — observe one green CI run (or state explicitly in the phase report that CI-green is deferred with the owner's sign-off, per SPEC §9 open item 2).

---

## NON-BLOCKING issues

### N1 — `db.ts` comment says the storage ADR is "pending"; ADR-0007 exists and is ACCEPTED

- **File:** `agent-core/src/storage/db.ts` (lines 2–3)
- **Problem:** Header comment: "the real SQLite layer (driver + migrations, ADR pending) lands in Phase 2". ADR-0007 (`better-sqlite3`) was accepted in Phase 1 and ARCHITECTURE §3.3/§5.1 already encode it.
- **Impact:** A Phase 2 implementer reading "ADR pending" may re-litigate the driver choice or invent a new one.
- **Fix:** Change the comment to reference ADR-0007 by number (one line).

### N2 — `approvals.ts` placeholder is fail-open for unknown actions (ordering itself is correct)

- **File:** `agent-core/src/approvals.ts` (lines 13–39)
- **Problem:** The requested ordering check **passes**: blocked patterns are evaluated before destructive, which are evaluated before confirm — denylist-supreme ordering is honored. However: (a) the fallback return is `"auto"` — any unrecognized command (e.g. `rm -rf C:\Users` — Windows path not matched by `/(\/|~)/`, and `rm` is not in `CONFIRM_PREFIXES`) categorizes as **auto-approved**, the exact inverse of ARCHITECTURE §7.2 rule 6 ("unknown ⇒ DENY, fail-closed") and SPEC §F6's security posture; (b) regex gaps: `rm -fr /` (flag order f-before-r) escapes `-[a-z]*r[a-z]*f`; (c) the single hard-coded `BLOCKED_PATTERNS` table conflates the *user-configurable settings denylist* (§7.2 step 1) with the *tool static blocked level* (step 2) — fine for a stub, but the Phase 3 engine must keep them separate (denylist is user data, evaluated per-call).
- **Impact:** If any Phase 3 code wires this placeholder before the real policy engine lands, it becomes a security hole in the subsystem SPEC §6 calls "complete, unbypassable, denylist-supreme". The existing test only covers the happy paths (`rm -rf /`, `format C:`).
- **Fix:** Default branch returns `"confirm"` (or a new `"unknown" → deny`) instead of `"auto"`; broaden patterns or add a comment that enumeration is illustrative only; add a negative test for the Windows-path and flag-order cases.

### N3 — Workspace package names don't match the architecture's module map

- **File:** `agent-core/package.json` (`"name": "agent-core"`), `shared/package.json` (`"name": "shared"`) vs `docs/architecture/ARCHITECTURE.md` §3 lines 125–126, §3.4 ("`@acute/shared`") and ADRs 0006/0007 which import from `@acute/shared`
- **Problem:** Docs consistently use the `@acute/*` scope; the actual packages are unscoped. `agent-core`'s dependency is `"shared": "workspace:*"`.
- **Impact:** Phase 2 code written per the ADRs/architecture (`import … from "@acute/shared"`) won't resolve; renaming later touches every import.
- **Fix:** Rename both packages to `@acute/agent-core` / `@acute/shared` (lockfile regen), or fix ARCHITECTURE/ADRs to the unscoped names. Do it now while only one file imports `shared`.

### N4 — License-audit allowlist is wider than SPEC §6 without an ADR

- **File:** `scripts/license-audit.mjs` (lines 21–30) and the generated `docs/compliance/dependency-licenses.md` (policy line)
- **Problem:** Script allows `0BSD` and `CC0-1.0` in addition to SPEC §6's list (MIT, Apache-2.0, BSD, ISC, MPL-2.0). `0BSD` is arguably "BSD"; `CC0-1.0` is a public-domain waiver not in the SPEC allowlist. The script's own policy line says "Every license exception must be recorded as an ADR" — none covers these additions.
- **Impact:** Policy widening silently ratifies itself in a generated compliance doc; for a closed-source product the owner should make that call.
- **Fix:** Record a one-paragraph ADR approving 0BSD/CC0-1.0 (and note that "BSD" = BSD-2/BSD-3), or trim the set to the SPEC list.

### N5 — ADR-0005 license statements are incomplete/incorrect

- **File:** `docs/decisions/0005-dev-tooling.md` (lines 12–14)
- **Problem:** ESLint's own license is never stated (it is MIT; only typescript-eslint BSD-2-Clause and Vitest MIT are given); the rejected Jest option is labeled "BSD" (Jest is MIT). Date is 2026-08-22 while every other Phase 1 ADR is 2026-08-21.
- **Impact:** The ADR set's "every dependency's license stated and allowlisted" property (which 0006–0009 satisfy) has a hole in 0005; the Jest mislabel is harmless (option rejected) but sloppy in a compliance-relevant record.
- **Fix:** Add "ESLint (MIT)" to the decision line, correct Jest to MIT, align the date (or note the cross-midnight session).

### N6 — `src/lib/version.ts` is an anti-drift orphan

- **File:** `src/lib/version.ts`; cross-ref ARCHITECTURE §3.2 (module map lists only `api/`, `stores/`, `screens/`, `components/`, `theme/`)
- **Problem:** `src/lib/` matches no purpose declared in the module map, and ARCHITECTURE §3's own rule is "every future file must map to a purpose declared here". It's a trivial placeholder (`APP_NAME`, `PHASE`), but the rule was declared precisely to catch this.
- **Fix:** Add a `src/lib/` row (app-level constants/utilities) to the module map, or fold the constants elsewhere. Same treatment, arguably, for the `ping` command in `src-tauri/src/lib.rs` (self-documented as removable, but not in the §3.1 commands surface) — acceptable as a temporary, flagged scaffold.

### N7 — `agent-core/README.md` provider row mentions "local" providers — a SPEC non-goal

- **File:** `agent-core/README.md` (line 12: "LLM provider adapters (Anthropic, OpenAI, local, ...)")
- **Problem:** SPEC §1.1/§F4 explicitly defer local models; ARCHITECTURE's provider module correctly lists only native + OpenAI-compatible. The README's "local" contradicts both. Also: the README's target table omits the `memory/`, `skills/`, `mcp/`, and `config.ts` rows that ARCHITECTURE §3.3 declares (the README claims to be the "target map").
- **Fix:** Drop "local"; add the missing module rows for one-stop consistency.

### N8 — `tests/README.md` defers integration tests to Phase 4+; SPEC/ARCHITECTURE schedule them Phase 2/3

- **File:** `tests/README.md` (line 3) vs SPEC §7 ("one integration test covering a full multi-agent run" every phase), ARCHITECTURE §3.5 and §10 (integration tests + recorded fixtures are Phase 2/3 work)
- **Problem:** The README's "(Phase 4+)" contradicts the verification plan; a Phase 2/3 implementer following the README would skip the SPEC §7 integration-test requirement.
- **Fix:** Change to "Phase 2/3" (cross-workspace integration + fixtures), keeping boot/smoke e2e later if desired.

### N9 — `tauri.conf.json` ships `csp: null` while ARCHITECTURE §3.1 commits to a CSP allowing only the sidecar origin

- **File:** `src-tauri/tauri.conf.json` (line 21) vs ARCHITECTURE §3.1 (`tauri.conf.json` row: "CSP allowing only the sidecar origin")
- **Problem:** Acceptable for a scaffold with no network calls, but it is a declared-security deviation that must not silently survive to Phase 2 when the webview starts talking to the sidecar (and only to the sidecar).
- **Fix:** Add a TODO comment/issue tying the CSP to Phase 2 wiring; set it (`default-src 'self'; connect-src http://127.0.0.1:* ws://127.0.0.1:*` shape) when `sidecar_endpoint()` lands.

### N10 — Stale statuses, examples, and generated-doc timing

- **Files/sections:**
  - `docs/specs/SPEC.md` header still reads "DRAFT v1.0 — Phase 0, awaiting product-owner approval", while `docs/runbooks/plan-phase-1.md` records "Phase 0 APPROVED 2026-08-22" — the SPEC's own status block ("living document maintained by the Scribe") should now say APPROVED.
  - ARCHITECTURE §2.2 health example `"version":"1.0.0"` vs API.md §2.1 `"0.1.0"` vs `agent-core/src/server.ts` `VERSION = "0.1.0"` — pick one (0.1.0).
  - `agent-core/src/server.ts` health body `{status, app}` deviates from the API.md §2.1 shape (`status, version, uptimeMs, dbOk`) — fine for the placeholder, but note the swap target explicitly (the file's header says "the GET /health contract stays", which is ambiguous about the body).
  - `docs/compliance/dependency-licenses.md` was generated 2026-08-21 but the lockfile was regenerated 2026-08-22 (plan task 6 note: allowBuilds fix + regen); re-run `pnpm license:audit` so the committed report provably reflects the committed lockfile.
- **Fix:** All one-line edits; batch them.

### N11 — Phase 2 prediction: `allowBuilds` must add better-sqlite3 or its prebuild will be silently blocked

- **File:** `pnpm-workspace.yaml` (lines 9–10) + `docs/runbooks/SETUP.md` pnpm-11 notes
- **Problem:** pnpm 11 blocks dependency build scripts unless allowlisted; only `esbuild` is listed today. better-sqlite3 (ADR-0007) runs `prebuild-install` on install — when it lands in Phase 2 without an `allowBuilds` entry, the native addon silently falls back to a source build (which will fail without a configured toolchain on clean machines, or quietly work on this dev box — the worst kind of environment-dependent failure). SETUP.md documents that `allowBuilds` changes require deleting lockfile + node_modules to take effect.
- **Fix:** When adding better-sqlite3, add `better-sqlite3: true` to `allowBuilds` in the same commit and regen; consider a CI assert that no dependency's build script was skipped.

### N12 — Phantom dependencies and unpinned Rust builds

- **Files:** `agent-core/package.json` / `shared/package.json` (no devDependencies at all — tests import `vitest`, sources rely on `@types/node` from the root workspace), `.gitignore`/repo (no `src-tauri/Cargo.lock` committed; it isn't ignored, just never generated since cargo never ran)
- **Problem:** `agent-core` tests and node-typed sources currently resolve `vitest`/`@types/node` only via directory walk-up to the root `node_modules`. This works with pnpm's layout (root is an ancestor directory) but is a phantom-dependency pattern that breaks the moment a package is built in isolation (e.g., the ADR-0009 esbuild bundle pipeline). The missing `Cargo.lock` means CI's `cargo check` resolves fresh, unpinned crate versions each run — non-reproducible for an app crate.
- **Fix:** Declare `vitest`/`@types/node` (and `typescript`, if scripts run tsc) as devDependencies in each workspace package; commit `Cargo.lock` after the first local `cargo check`.

---

## Traceability notes — SPEC F1–F11 coverage

| Feature | ARCHITECTURE.md | API.md | Verdict |
|---|---|---|---|
| **F1** Project workspace | §3.2 ProjectWorkspace, §5.1 `projects`, §7.1(5) workspace scoping, §7.2 destructive git | §3 projects CRUD | **PARTIAL** — registry + scoping + destructive-git approvals covered; file-tree browser and UI git panel have **no API** (B2) |
| **F2** Agent registry | §3.3 `agents/` (templates seeded, never hard-coded), §5.1 `agents` incl. `vision_model?`, `skills` | §4 CRUD + duplicate + version bump | **COVERED** (shared-type drift: B1) |
| **F3** Orchestration | §4.1 three modes, topology-as-data, bus, task board, §3.3 semaphore cap 5 (ADR-0011) | §5 sessions, `queued` status, `agent.queued` event | **COVERED** |
| **F4** Provider manager | §3.3 `providers/` (native + OpenAI-compatible, vision routing global + per-agent, fixture mode, keys in vault) | §8 providers/keys/models/test, §10.1 `defaults.visionModel` | **COVERED** |
| **F5** Tool layer | §3.3 `tools/` (`auto/confirm/blocked` registry, single choke point), `mcp/` bridge | §12 MCP servers (tools list w/ permissionLevel) | **COVERED** |
| **F6** Approval engine | §4.2 round-trip, §7.1–7.2 choke points + denylist-supreme order + fail-closed, §5.1 audit tables | §7 approvals/decision/audit incl. 422 on `allow_project` destructive | **COVERED** — minor: the disabled Docker "coming later" settings placeholder (SPEC F6 last bullet) appears in no settings contract; carry it into §10.1 when Settings is built so it isn't forgotten |
| **F7** Usage & cost | §4.3 per-request telemetry + cost provenance, §5.1 `usage_events` | §9 groupBy day/provider/model/agent/project/session | **COVERED** |
| **F8** Sessions/history/memory/skills | §5.1 events + memory + skills tables, §3.3 `memory/`, `skills/`, §3.5 fixtures | §5 sessions + events backfill, §11 skills | **PARTIAL** — memory is "user-editable" (SPEC F8) with **no read/edit API** (B2) |
| **F9** UI screens | §3.2 all six screens + theme module | all screens data-backed except workspace file tree/git (B2) | **PARTIAL** (via B2) |
| **F10** Multimodal input | §4.3 vision routing paragraph | §5.4 `attachments` | **COVERED** |
| **F11** Distribution | §2 spawn/lifecycle, §5 first-run migration, §3.5 packaging scripts, ADR-0003/0009 | n/a (not an API concern) | **COVERED** (execution is Phase 6) |

**Scope beyond SPEC:** none found — no local models, sync, marketplace, multi-user, or mobile anywhere in ARCHITECTURE/API (the only touch is the README "local" slip, N7). Non-functional requirements (§5) are honored: no polling (§6 event model), two-process inventory (§2.5), secrets via Credential Manager only (§7.3), no telemetry, closed-source markers correct (no LICENSE file; `license: UNLICENSED`/`LicenseRef-Proprietary`).

**Anti-drift (§3 module map) result:** every skeleton file maps to a declared purpose or a README **except** `src/lib/version.ts` (N6) and the temporary `ping` command (flagged in code). Root configs, `scripts/license-audit.mjs`, `agent-core/src/{server,approvals,storage/db}.ts` (flat placeholders for the `server/`, `approvals/`, `storage/` modules — mapping documented in `agent-core/README.md`), `shared/src`, `src-tauri/*`, `tests/`, and `docs/*` all trace cleanly. No orphans beyond those two.

**Skeleton correctness spot-checks (static, since nothing has compiled/run in CI — see B3):**
- `ci.yml`: `windows-latest` ✓; action versions all real and correctly ordered (`checkout@v4` → `pnpm/action-setup@v4` (reads `packageManager: pnpm@11.22.0`) → `setup-node@v4` with `node-version: 24, cache: pnpm` (pnpm already on PATH — order correct) → `dtolnay/rust-toolchain@stable` → `Swatinem/rust-cache@v2` with `workspaces: src-tauri` ✓); `pnpm install --frozen-lockfile` → `pnpm verify` → `cargo check --manifest-path` all valid; no path filters, so every push verifies fully. Triggers (push: main, pull_request) sane.
- `tauri.conf.json`: valid Tauri 2 shape — `identifier: com.acutecode.app` ✓, `build.devUrl` matches `vite.config.ts` port 5173 (strictPort) ✓, `frontendDist: ../dist` matches vite `outDir` ✓, `bundle.active: false` correctly avoids the icon/bundle requirements at scaffold stage ✓. Deviation: `csp: null` (N9).
- `Cargo.toml`: `tauri-build = "2"`, `tauri = "2"`, `tauri-plugin-shell = "2"` are the real Tauri 2 crates; `edition 2021`, standard `[lib]` crate-type trio, `windows_subsystem` attr in `main.rs` — matches the official v2 template shape.
- `capabilities/default.json`: valid minimal capability (`core:default`, window `main` matches the default window label).

---

## ADR consistency check — RESULT: PASS (with the N4/N5 license-statement caveats)

- **Numbering:** `docs/decisions/` contains 0001–0011 + `TEMPLATE.md` — sequential, no gaps, no duplicates. 0001–0004 = Phase 0, 0005–0011 = Phase 1, matching the SPEC's derivation note and ARCHITECTURE's header.
- **Fastify (ADR-0006):** reflected in ARCHITECTURE §3.3 (`server/` "Fastify app assembly") and API.md header ("Served by … Fastify, ADR-0006"). Skeleton `server.ts` is a `node:http` placeholder — acceptable and self-labeled; Phase 2 swap must bring Fastify 5 + the API.md §2.1 health body (N10).
- **better-sqlite3 (ADR-0007):** reflected in ARCHITECTURE §3.3 (`storage/` "better-sqlite3 (WAL), numbered SQL migrations, serialized write queue") and §5. Skeleton contradiction is only the stale "ADR pending" comment (N1) and the future `allowBuilds` entry (N11).
- **Bearer token (ADR-0008):** reflected consistently in ARCHITECTURE §2.3 (env-var token, WS first-message auth, close 4401, single-origin CORS) and API.md §1.2/§6.1 (same mechanics, same close code, same CORS rule). No drift.
- **Append-only event log (ADR-0010):** reflected in ARCHITECTURE §5.1 (`session_events` insert-only, per-session `seq`), §4.2 step ⑧, §2.4 crash recovery, and API.md §5.6 (`afterSeq` backfill). No drift.
- **In-process runners (ADR-0011):** reflected in ARCHITECTURE §3.3 (semaphore in `orchestration/`, global across modes) and §8.2 memory math. No drift.
- **ADR-0009 (packaging):** reflected in ARCHITECTURE §3.5 (`build-sidecar.mjs`, `package-portable.mjs` — not yet written, correctly scheduled Phase 6 per §10) and §2.1 (spawn of bundled sidecar).
- **ADR-0005 (tooling):** ESLint 9 flat + typescript-eslint ✓ (`eslint.config.js`), Vitest ✓, `pnpm verify` mirrors CI exactly ✓ (`package.json` verify vs `ci.yml` verify step — same command), CI runs `cargo check` ✓ as the ADR promises. License-statement gaps: N5.
- **License statements per ADR:** 0006 (fastify/websocket/cors/ws/typebox — all MIT) ✓ · 0007 (better-sqlite3 MIT; Drizzle Apache-2.0) ✓ · 0008 (getrandom MIT OR Apache-2.0) ✓ · 0009 (esbuild MIT; Node MIT) ✓ · 0010/0011 (no new deps) ✓ · **0005 incomplete (N5)**. All stated licenses fall inside the SPEC §6 allowlist; the only allowlist *widening* is in the audit script, not the ADRs (N4).

---

## Bottom line

The architecture document is genuinely good: F1–F11 nearly all trace cleanly, the five design ADRs are consistently propagated into ARCHITECTURE and API.md, the security model is coherent, and the skeleton maps to the module map with only trivial orphans. Fix B1 (reconcile `@acute/shared` with the contract — one file plus its test), B2 (add or explicitly defer the file-tree/git/memory API surfaces), and B3 (run `cargo check` + one real `pnpm verify` on the final tree, ideally one CI run) before taking Phase 1 to the owner. The non-blocking items are one-liners except N2, which becomes blocking the moment the placeholder is wired to real dispatch — fix the fail-open default now while touching nothing else.
