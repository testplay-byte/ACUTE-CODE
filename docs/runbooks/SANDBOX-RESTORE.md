# SANDBOX RESTORE — resuming after the agent sandbox is wiped

**Owner directive (2026-08-23):** the agent's sandbox is sometimes cleared
out; everything needed to resume from where the last session ended must be
recoverable from THIS GitHub repo. This runbook is that procedure. The
canonical session history itself lives in
[`docs/agent/ORCHESTRATION-WORKLOG.md`](../agent/ORCHESTRATION-WORKLOG.md)
(refreshed into the repo at the end of every session).

## What lives where (inventory)

| Thing | Location | Survives a sandbox wipe? |
|---|---|---|
| All product code, docs, runbooks, memory | GitHub repo (private) | ✅ |
| Orchestration worklog (session-by-session) | `docs/agent/ORCHESTRATION-WORKLOG.md` (snapshot; live copy at `/home/z/my-project/worklog.md`) | ✅ (snapshot) |
| Agent memory / lessons | `docs/runbooks/AGENT-MEMORY.md` | ✅ |
| GitHub PAT, OpenRouter key | sandbox only: `/home/z/.secrets/*` (0600) | ❌ — owner re-provides |
| Dev SQLite (agents/sessions/projects from live tests) | `<repo>/.dev/*.db` | ❌ — dev-only, recreatable |
| Local test folder | `/home/z/acute-workspace/ACUTEST` | ❌ — recreatable (see below) |

Secrets are deliberately NOT in the repo (hard rule); the owner supplies them
at the start of a fresh session. Everything else is one clone away.

## Restore procedure (fresh sandbox, zero to resumed)

```bash
# 1. pnpm via corepack (repo pins 11.22.0; corepack ships with Node)
mkdir -p /home/z/.local/bin
corepack enable --install-directory /home/z/.local/bin
export PATH=/home/z/.local/bin:$PATH        # re-export in EVERY shell invocation

# 2. Stage the secrets the owner provided (0600, outside any repo, NEVER echo values)
umask 077; mkdir -p /home/z/.secrets
printf '%s' '<GITHUB_PAT>'      > /home/z/.secrets/github.pat     # 93 chars expected
printf '%s' '<OPENROUTER_KEY>'  > /home/z/.secrets/openrouter.key # 73 chars expected
chmod 600 /home/z/.secrets/*
wc -c /home/z/.secrets/*                   # verify LENGTHS only

# 3. Clone (PAT embedded for auth, then sanitize the remote)
umask 022; mkdir -p /home/z/acute-workspace; cd /home/z/acute-workspace
PAT=$(cat /home/z/.secrets/github.pat)
git -c credential.helper= clone https://testplay-byte:${PAT}@github.com/testplay-byte/ACUTE-CODE.git ACUTE-CODE
cd ACUTE-CODE
git remote set-url origin https://github.com/testplay-byte/ACUTE-CODE.git
git config --global credential.helper 'store --file=/home/z/.secrets/git-credentials'
printf 'protocol=https\nhost=github.com\nusername=testplay-byte\npassword=%s\n\n' "$PAT" | git credential approve
chmod 600 /home/z/.secrets/git-credentials

# 4. Confirm state and verify the baseline with your own eyes
git log --oneline -3                                  # tip per HANDOFF §3
curl -s -H "Authorization: Bearer $PAT" https://api.github.com/repos/testplay-byte/ACUTE-CODE | grep '"private"'   # must be true
pnpm install
pnpm verify                                           # MUST be green before any new work

# 5. Re-read, in order:
#    HANDOFF.md  →  docs/runbooks/AGENT-MEMORY.md  →  docs/agent/ORCHESTRATION-WORKLOG.md
#    then the runbook for the task at hand.

# 6. (only when live model testing is needed) re-stage the Linux key file
mkdir -p "$HOME/.acute"
cp /home/z/.secrets/openrouter.key "$HOME/.acute/openrouter.key" && chmod 600 "$HOME/.acute/openrouter.key"
# or boot sidecars with ACUTE_PROVIDER_OPENROUTER="$(cat /home/z/.secrets/openrouter.key)"
# M4-style test folder: mkdir -p /home/z/acute-workspace/ACUTEST (+ a README inside)

# 7. Re-create the orchestration worklog location and continue appending there
#    (live copy: /home/z/my-project/worklog.md — snapshot back into the repo at session end)
```

## Session-end backup rule (every session, before the final push)

1. Append the session's entries to `/home/z/my-project/worklog.md` (the live log).
2. Copy the whole file into the repo: `docs/agent/ORCHESTRATION-WORKLOG.md`
   (with its header note that it is a snapshot refreshed each session).
3. Commit + push together with the session's work; confirm CI green; ntfy the owner.

## Environment facts to remember on restore

- Linux x64, ~2 CPUs / 4 GB RAM / ~8 GB disk; non-root user `z` (uid 1001).
- Background processes die between shell invocations (memory §4): live tests
  run as ONE self-contained invocation.
- No Rust toolchain: `cargo check` happens on CI only (ADR-0012).
- ntfy notify after every milestone: `curl -d "<no secrets>" https://ntfy.sh/TASKISDONE`.
