<!-- last-reviewed: 2026-08-24 round-34 -->
# SANDBOX RESTORE — resuming after the agent sandbox is wiped

**Owner directive (2026-08-24, round 28 revision):** the agent's sandbox is
sometimes cleared out; everything needed to resume from where the last
session ended must be recoverable from the GitHub repos. This runbook is
that procedure. The canonical session history lives in
[`docs/agent/ORCHESTRATION-WORKLOG.md`](../agent/ORCHESTRATION-WORKLOG.md)
(refreshed into the repo at the end of every session).

**Round-28 rule change (owner revision):** if the sandbox wipes again, the
agent does **NOT** attempt autonomous recovery. The agent notifies the owner
via `curl -d "ACUTE-CODE sandbox wiped — re-supply credentials to resume" https://ntfy.sh/TASKISDONE`
and stops. The repos survive on GitHub; the owner re-supplies PATs + OpenRouter
key in chat. (The round-10–13 autonomous-recovery pattern is retired — the
owner now keeps GitHub as the backup and re-supplies tokens quickly.)

## What lives where (inventory — round-28 layout)

| Thing | Location | Survives a sandbox wipe? |
|---|---|---|
| All product code, docs, runbooks, memory | GitHub repo (private): `testplay-byte/ACUTE-CODE` | ✅ |
| Public dashboard source | GitHub repo (public): `testplay-byte/DASHBOARD` | ✅ |
| Orchestration worklog (session-by-session) | `docs/agent/ORCHESTRATION-WORKLOG.md` (snapshot; live sandbox copy at `/home/z/my-project/worklog.md`) | ✅ (snapshot) |
| Agent memory / lessons | `docs/runbooks/AGENT-MEMORY.md` | ✅ |
| Round-28 master plan | `docs/ROUND-28-MASTER-PLAN.md` | ✅ |
| Screenshot zips (from round 28 on) | `testplay-byte/DASHBOARD` repo `screenshots/` dir (public) | ✅ |
| GitHub PAT (acute-code repo) | sandbox only: `/home/z/.secrets/github-acute-code.pat` (0600, 93c) | ❌ — owner re-provides |
| GitHub PAT (dashboard repo) | sandbox only: `/home/z/.secrets/github-dashboard.pat` (0600, 93c) | ❌ — owner re-provides |
| OpenRouter API key | sandbox only: `/home/z/.secrets/openrouter.key` (0600, 73c) | ❌ — owner re-provides |
| Per-repo git credential stores | sandbox only: `/home/z/.secrets/git-credentials-acute` (153c) + `git-credentials-dashboard` (152c) | ❌ — recreatable from the PATs |
| Dev SQLite (agents/sessions/projects from live tests) | `<repo>/.dev/*.db` | ❌ — dev-only, recreatable |
| Local test folder | `/home/z/PROJECT/ACUTECODE/.dev/ACUTEST` (recreatable) | ❌ |

Secrets are deliberately NOT in either repo (hard rule); the owner supplies
them at the start of a fresh session. Everything else is one clone away.

## Restore procedure (fresh sandbox, zero to resumed)

```bash
# 0. Safety env vars (every shell invocation — put in ~/.bashrc for the session)
export GIT_TERMINAL_PROMPT=0          # never hang on a prompt
export GIT_CONFIG_NOSYSTEM=1          # ignore system gitconfig

# 1. pnpm via corepack (repo pins 11.22.0; corepack ships with Node)
corepack enable 2>/dev/null || npm install -g pnpm@11.22.0
corepack prepare pnpm@11.22.0 --activate 2>/dev/null || true
which pnpm                            # verify (could be ~/.cache/node/corepack/shims/pnpm)

# 2. Stage the 5 secrets the owner provided (0600, outside any repo, NEVER echo values)
umask 077; mkdir -p /home/z/.secrets
# Owner pastes the 3 token values into the agent chat; agent writes them to files:
#   /home/z/.secrets/github-acute-code.pat    (93 chars, fine-grained PAT scoped to ACUTE-CODE)
#   /home/z/.secrets/github-dashboard.pat     (93 chars, fine-grained PAT scoped to DASHBOARD)
#   /home/z/.secrets/openrouter.key           (73 chars, sk-or-v1-...)
# Then build per-repo git-credentials stores (URL-line format):
printf 'https://x-access-token:%s@github.com/testplay-byte/ACUTE-CODE\n'   "$(cat /home/z/.secrets/github-acute-code.pat)"    > /home/z/.secrets/git-credentials-acute
printf 'https://x-access-token:%s@github.com/testplay-byte/DASHBOARD\n'    "$(cat /home/z/.secrets/github-dashboard.pat)"     > /home/z/.secrets/git-credentials-dashboard
chmod 600 /home/z/.secrets/*
wc -c /home/z/.secrets/*              # verify LENGTHS only (never cat the values)

# 3. Configure global git (no inherited credential helper, no askpass)
git config --global user.email "z@container"
git config --global user.name "Z User"
git config --global init.defaultBranch main
git config --global pull.rebase false
git config --global core.autocrlf false
git config --global credential.helper ""    # clear inherited helper
git config --global core.askPass ""        # no askpass
git config --global push.default current

# 4. Create the new folder layout (round-28: /home/z/PROJECT/{ACUTECODE,DASHBOARD})
umask 022; mkdir -p /home/z/PROJECT/ACUTECODE /home/z/PROJECT/DASHBOARD
chmod 0755 /home/z/PROJECT
git config --global --add safe.directory /home/z/PROJECT/ACUTECODE
git config --global --add safe.directory /home/z/PROJECT/DASHBOARD

# 5. Clone both repos with token-in-URL (lesson #24: credential helpers are
#    environment-sensitive on the owner's Git-for-Windows; token-in-URL is not.
#    Embed the PAT for the ONE clone command, sanitize the remote immediately after.)
ACUTE_PAT=$(cat /home/z/.secrets/github-acute-code.pat)
DASH_PAT=$(cat /home/z/.secrets/github-dashboard.pat)
git clone "https://x-access-token:${ACUTE_PAT}@github.com/testplay-byte/ACUTE-CODE.git" /home/z/PROJECT/ACUTECODE
git -C /home/z/PROJECT/ACUTECODE remote set-url origin https://github.com/testplay-byte/ACUTE-CODE.git
git clone "https://x-access-token:${DASH_PAT}@github.com/testplay-byte/DASHBOARD.git" /home/z/PROJECT/DASHBOARD
git -C /home/z/PROJECT/DASHBOARD remote set-url origin https://github.com/testplay-byte/DASHBOARD.git
unset ACUTE_PAT DASH_PAT
# Configure per-repo credential helpers for future pushes (Linux-only; on
# owner's Windows the launcher uses token-in-URL per lesson #24)
git -C /home/z/PROJECT/ACUTECODE  config credential.helper "store --file=/home/z/.secrets/git-credentials-acute"
git -C /home/z/PROJECT/DASHBOARD config credential.helper "store --file=/home/z/.secrets/git-credentials-dashboard"

# 6. Verify state with your own eyes
git -C /home/z/PROJECT/ACUTECODE  log --oneline -3    # tip per HANDOFF §3 (currently a727b43 round-28 plan)
git -C /home/z/PROJECT/DASHBOARD log --oneline -3     # tip (currently 23f5846)
# Secret-scan .git/config — must return CLEAN (no tokens persisted in remote URL):
grep -E 'github_pat|sk-or-v1|x-access-token:' /home/z/PROJECT/ACUTECODE/.git/config /home/z/PROJECT/DASHBOARD/.git/config || echo "CLEAN"
# Verify ACUTE-CODE is PRIVATE before any push (lesson #15):
ACUTE_PAT=$(cat /home/z/.secrets/github-acute-code.pat)
curl -s -H "Authorization: Bearer $ACUTE_PAT" https://api.github.com/repos/testplay-byte/ACUTE-CODE | jq -r .private   # must print "true"
unset ACUTE_PAT

# 7. Install deps + verify baseline
cd /home/z/PROJECT/ACUTECODE
pnpm install                          # ~332 packages, better-sqlite3 native build
pnpm verify                          # MUST be green before any new work (197 tests expected)

# 8. Re-read, in order:
#    HANDOFF.md  →  docs/runbooks/AGENT-MEMORY.md  →  docs/agent/ORCHESTRATION-WORKLOG.md
#    →  docs/ROUND-28-MASTER-PLAN.md (the round-28 plan)  →  docs/runbooks/WORKFLOW.md
#    then the runbook for the task at hand.

# 9. (only when live model testing is needed) stage the OpenRouter key for the sidecar
export ACUTE_PROVIDER_OPENROUTER=$(cat /home/z/.secrets/openrouter.key)
# Single allowed model: stealth/ox-alpha (1M ctx, 0-cost). Do NOT test other models.
# baseUrl is seeded in DB as https://openrouter.ai/api/v1 (APEX — sandbox-reachable;
# api.openrouter.ai is DNS-blocked but irrelevant since the sidecar uses the apex URL).

# 10. Continue appending to the sandbox worklog at /home/z/my-project/worklog.md
#     (live copy); snapshot into the repo at docs/agent/ORCHESTRATION-WORKLOG.md
#     at session end (see "Session-end backup rule" below).
```

## If the sandbox wipes again (round-28 rule)

**DO NOT attempt autonomous recovery.** The repos survive on GitHub; the
owner re-supplies tokens quickly. The agent's job is to:

1. Detect the wipe (e.g. `/home/z/PROJECT/ACUTECODE` missing, or
   `/home/z/.secrets/` missing, or `git log` fails).
2. Notify the owner:
   ```bash
   curl -d "ACUTE-CODE sandbox wiped — re-supply credentials to resume" https://ntfy.sh/TASKISDONE
   ```
3. Stop. Wait for the owner to re-supply credentials in chat, then resume
   from step 1 of the restore procedure above.

**Rationale (owner revision 2026-08-24):** the round-10–13 pattern of
attempting autonomous recovery wasted time and risked re-introducing stale
state. The repos are the backup; the owner re-supplies tokens in <5 min.
Lesson #37 in `AGENT-MEMORY.md` codifies this.

## Session-end backup rule (every session, before the final push)

1. Append the session's entries to `/home/z/my-project/worklog.md` (the live log).
2. Copy the relevant new entries into the repo's
   `docs/agent/ORCHESTRATION-WORKLOG.md` (append, do not overwrite — it has
   the full R1–R27 history).
3. Commit + push together with the session's work; confirm CI green.
4. **ntfy the owner ONLY on round close-out + owner-APPROVE** (round-28
   rule, lesson #39): `curl -d "Round NN complete — owner approved" https://ntfy.sh/TASKISDONE`.
   Do NOT ntfy for individual milestones or workstream completions — the
   owner sees GitHub pushes in real time.

## Environment facts to remember on restore

- **Linux x64**, ~2 CPUs / 4 GB RAM / ~8 GB disk; non-root user `z` (uid 1001).
- **Background processes die between shell invocations** (lesson #4): live
  tests run as ONE self-contained invocation (boot → work → assert → teardown).
- **No Rust toolchain** in sandbox: `cargo check` happens on CI only (ADR-0012).
- **`api.openrouter.ai` DNS-blocked** in sandbox; use apex
  `https://openrouter.ai/api/v1` (already seeded in DB — don't "fix" DNS).
- **pnpm at** `/home/z/.cache/node/corepack/shims/pnpm` after `corepack enable`
  (NOT at `/home/z/.local/bin/pnpm` — that path doesn't exist post-wipe).
- **CI takes ~4–6 minutes** (windows-latest + cargo) — a Bash timeout that
  kills a polling loop is NOT a CI failure; re-query run status.

## Quick reference: the two repos

| Repo | URL | Visibility | Clone path | PAT file |
|---|---|---|---|---|
| ACUTE-CODE (product) | `https://github.com/testplay-byte/ACUTE-CODE.git` | **PRIVATE** (verify before push) | `/home/z/PROJECT/ACUTECODE` | `/home/z/.secrets/github-acute-code.pat` |
| DASHBOARD (public status page) | `https://github.com/testplay-byte/DASHBOARD.git` | public | `/home/z/PROJECT/DASHBOARD` | `/home/z/.secrets/github-dashboard.pat` |
