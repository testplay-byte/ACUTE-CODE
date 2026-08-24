<!-- last-reviewed: 2026-08-24 round-34 -->
# Round 14 — Dashboard live on GitHub Pages (2026-08-23)

**Owner direction:** "I have created a new GitHub repository explicitly for
the dashboard… you will have full access… set it up exactly like how it
needs to be… verify it afterwards too using the agent browser skill…
Make sure that it clearly highlights the plan."

## What was done

1. **PAT separated** — the owner-provided dashboard PAT stored at
   `/home/z/.secrets/dashboard.pat` (0600, 93 chars), completely separate
   from the main-repo PAT (never mixed). Verified: both tokens work on their
   respective repos only.
2. **Publisher updated** — `publish-dashboard.mjs` now defaults to
   `testplay-byte/DASHBOARD` + `DASHBOARD_PAT` env var (repo name, auth,
   and all error messages updated; no stale references).
3. **Dashboard enhanced with "The Plan"** (owner's explicit ask):
   - **NOW** card: current focus in an orange-tinted highlight box
   - Upcoming phases with status chips (`queued` / `owner-gated`)
   - **Principles** list (local-first, additive architecture, quality over
     speed)
4. **Published + Pages enabled** — first push to the blank repo succeeded,
   Pages enabled from `main/`, live URL answered HTTP 200.
5. **Browser-verified** — `agent-browser` navigated to the live URL,
   captured a screenshot, and VLM confirmed all 7 elements: bento header
   with Acute logo ✓ · three pillar cards with progress bars ✓ · THE PLAN
   card with NOW highlight + upcoming phases ✓ · Principles list ✓ ·
   Quality chips ✓ · Milestone timeline ✓ · nothing broken ✓.
6. **Denylist re-tested** with poisoned plan content — still fail-closed
   (private model id, ntfy topic, dev port all blocked).

## Live URL

**https://testplay-byte.github.io/DASHBOARD/**

Screenshot: `assets/round-14/dashboard-live.png` (browser-verified).

## Files changed

- `docs/status.json` — added `plan` section (current/upcoming/principles)
- `scripts/dashboard/build-dashboard.mjs` — plan rendering + CSS
- `scripts/dashboard/publish-dashboard.mjs` — DASHBOARD repo + DASHBOARD_PAT
- `docs/decisions/0021-public-status-dashboard-separate-repo.md` — updated
- `docs/runbooks/PUBLIC-DASHBOARD.md` — LIVE status, publish command
- `docs/README.md`, `docs/runbooks/SECURITY.md` — repo name references

**Status: delivered — dashboard live and verified; future publishes are
one command per WORKFLOW §6.**
