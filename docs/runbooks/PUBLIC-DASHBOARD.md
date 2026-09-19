<!-- last-reviewed: 2026-09-19 round-108 -->
# PUBLIC DASHBOARD — ACUTE-DASH

The owner's public, visual status page (round-17, ADR-0021):
**https://testplay-byte.github.io/DASHBOARD/** — dark bento cards, three
pillar progress bars, quality chips, milestone timeline. Round-18: the owner created the dedicated blank repo + a scoped PAT —
first publish succeeded and was browser-verified (screenshot:
`assets/round-14/dashboard-live.png`).

## Architecture

- **Private repo** keeps the truth: `docs/status.json` (schema
  `acute-status/1`, hand-maintained each round — statuses are distilled
  one-liners, NEVER scraped content).
- `scripts/dashboard/build-dashboard.mjs` — zero deps; reads status.json +
  git metadata; emits self-contained `dashboard.html` (inline CSS, no JS, no
  external assets); **fail-closed DENYLIST** on the output (tokens, the
  owner's private model id, internal paths, env names, ports, the ntfy
  topic, internal id prefixes, repo paths, secret-like runs) — exit 1 before
  anything publishes. Self-test: poisoned status.json was blocked (verified
  round-17).
- `scripts/dashboard/publish-dashboard.mjs` — builds, then pushes ONLY the
  generated `index.html` to the PUBLIC repo `testplay-byte/ACUTE-DASH`
  (token-in-URL per ADR-0018, remote sanitized), ensures Pages (main /),
  verifies the live URL. Run after any merged round where status.json moved.
- **Pages stays DISABLED on the private repo** — part of the pre-push
  checklist (`SECURITY.md`).

## Setup status: LIVE ✅

Published round-18: https://testplay-byte.github.io/DASHBOARD/ — the owner
created the repo + scoped PAT; `publish-dashboard.mjs` pushed the generated
page, enabled Pages, and the live URL was browser-verified (all sections
confirmed by VLM). Future updates:

```bash
DASHBOARD_PAT="$(cat /home/z/.secrets/dashboard.pat)" \
  node scripts/dashboard/publish-dashboard.mjs
```

## Content rules (binding)

ALLOW: product name/tagline/version, pillar states+progress, milestone
one-liners, aggregate quality facts (test counts by suite, license verdict),
short SHA + build stamp, generic tech chips.
DENY: everything else — code, file trees, internal paths, credentials
(including lengths), the owner's private model id, env-var auth names,
localhost ports, the ntfy topic, internal ids, links to the private repo,
"how to run" details. The builder enforces the denylist mechanically; humans
keep status.json prose public-safe.
