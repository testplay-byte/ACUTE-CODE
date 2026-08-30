<!-- last-reviewed: 2026-08-30 round-53 -->
# SECURITY — posture & rules

Round-17 (owner direction: proper documentation of all logic). Describes
what IS, and what's coming with Phase 3. Audience: any agent touching
auth/tools/secrets, and the owner.

## Threat model (local-first product)

The app runs entirely on the owner's machine: Tauri shell + loopback sidecar
+ browser/dev UI. Trust boundaries: (1) anything that can reach
127.0.0.1:<port>; (2) the model provider (OpenRouter) — sees prompts and
tool outputs sent to it; (3) the local filesystem outside a project root;
(4) the OS user session (secrets at rest).

## Controls in place today

1. **Sidecar transport**: binds 127.0.0.1 only, never 0.0.0.0; every route
   except `GET /health` requires `Authorization: Bearer <token>`
   (constant-time compare; token minted per spawn — ADR-0008). CORS is a
   strict allowlist (tauri hosts + the two dev origins).
2. **Tool path containment** (the real sandbox): every tool resolves paths
   RELATIVE to the session's project root; absolute paths, drive letters,
   and `..` traversals are rejected (`resolveInsideRoot`). Shell execution is
   not a tool at all in v1. Directory deletion is refused (approval-gated,
   Phase 3). Every executed tool call is audit-logged (`tool.use` events).
3. **Tool allowlist** (ADR-0019, round-17): `agent.allowedTools` is now
   enforced at tool-build time; empty = all (the defaults), non-empty = real
   restriction. The canonical name list is single-sourced
   (`TOOL_NAMES`) with a drift-guard test.
4. **Secrets custody — per surface** (the "Credential Manager only" rule,
   refined for reality):
   - Owner's packaged app: Windows Credential Manager (DPAPI), key hand-off
     via the shell (`ACUTE_PROVIDER_<ID>` env into the sidecar at spawn).
   - Launcher (owner's PC): `credentials.txt` next to the launcher (owner's
     explicit choice, rotates at will) + isolated `.acute/.git-credentials`
     (0600) + token-in-URL only for the single git command, remote sanitized
     immediately after; everything redacted from logs (values never, lengths
     at most).
   - Dev sandbox: `/home/z/.secrets/*` (0600, outside any repo), values never
     echoed.
   - NEVER in: the repo, transcripts, error messages, REST bodies (sole
     exception: the shell-only `/internal/providers/keys` handoff), the
     public dashboard (see below).
5. **Public dashboard**: separate public repo `DASHBOARD` carries a
   hand-curated `status.json` render only; the builder enforces a DENYLIST
   (tokens, model ids, internal paths, env names, ntfy topic…) and fails
   closed before publishing. Pages stays DISABLED on the private repo — part
   of the pre-push checks.
6. **License hygiene**: MIT/Apache-2.0/BSD/ISC/MPL-2.0 only; audit gates
   every CI run (closed source).

## Known gaps (deliberate, tracked)

The R42 audit's security P0s are **ALL CLOSED** — P0-1/P0-2 (Rust compile,
false-green status) in R43; the three deferred holes in R45:

- **P0-3 CLOSED (R45) — child-process env scrubbing:** every spawned child
  (exec/git tools, dialogs, terminal routes, PTY sessions) gets an
  ALLOWLIST environment via `buildChildEnv()`
  (`agent-core/src/lib/child-env.ts`) — children never inherit
  `ACUTE_TOKEN`/`ACUTE_PROVIDER_*` keys (live-verified: a child probe prints
  nulls; 7 tests).
- **P0-4 CLOSED (R45) — contained AUTO tier:** `decideCommand` takes the
  project root and `commandTouchesOutsideRoot()` demotes any auto-tier
  candidate touching an absolute path outside the root, `~`, `..`, or
  another drive to the ASK tier (`cat /etc/passwd` asks now); explicit
  always-allow rules still win.
- **P0-5 CLOSED (R45) — gated web tools:** `web_fetch` +
  `browser_control:navigate` pass the `decideWebFetch` host gate (37-host
  default doc/source allowlist + per-project `web_host_rules`, migration
  0016; interactive approval where "always allow" remembers the HOST);
  `web_search` queries are secret-scrubbed before leaving the machine.

Remaining honest gaps:

- **No real sandbox for APPROVED commands.** Once a command is approved it
  runs with the owner's full privileges — the human-approval engine IS the
  boundary (as designed since v1). The P0-4 containment is token-based, not
  a sandbox: shell escapes like `bash -c "…"` inside a command string still
  exist, but such commands were never auto-tier — they always asked.
- **Browser-proxy v1 limits (R43, still true):** no cookie persistence
  (logins don't survive), runtime-JS URLs bypass the rewrite, multipart
  POST is opaque, and the private-net guard is hostname-only.
- **User-typed browser-panel navigation is ungated BY DESIGN** — the P0-5
  gate covers AGENT tool calls; a URL the human types into the BrowserPanel
  is a user action, like typing it into their own browser.
- Dev token is a constant (`acute-dev-local`) — loopback-only by design;
  acceptable while the threat model is "local user is the owner".

## Pre-push checklist (every round)

Repo PRIVATE via API · secret-pattern scan of staged files · Pages disabled
on the private repo · no key lengths or values in logs/diffs.
