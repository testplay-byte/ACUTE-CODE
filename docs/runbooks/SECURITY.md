<!-- last-reviewed: 2026-08-24 round-28 -->
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

- No interactive approval engine yet (Phase 3): the containment above is the
  boundary; destructive ops are refused rather than approved.
- Sessions are open-ended (`running`); no terminal-state enforcement.
- `costUsd` is hardcoded 0 — unattended spend is invisible until estimation
  lands (pillar-2 prerequisite).
- Dev token is a constant (`acute-dev-local`) — loopback-only by design;
  acceptable while the threat model is "local user is the owner".

## Pre-push checklist (every round)

Repo PRIVATE via API · secret-pattern scan of staged files · Pages disabled
on the private repo · no key lengths or values in logs/diffs.
