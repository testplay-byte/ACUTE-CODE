# PUBLIC DASHBOARD — ACUTE-DASH

The owner's public, visual status page (round-17, ADR-0021):
**https://testplay-byte.github.io/ACUTE-DASH/** — dark bento cards, three
pillar progress bars, quality chips, milestone timeline. Screenshot of the
render: `docs/ui-iterations/assets/round-13/public-dashboard.png`.

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

## One-time setup STILL NEEDED (owner action — the only blocker)

The public repo `ACUTE-DASH` is created, but pushes are denied: fine-grained
PATs have a FIXED repository selection, and this repo was created after the
token. Owner picks ONE:

- **A (easiest):** github.com → Settings → Developer settings →
  Fine-grained tokens → edit the current token → *Repository access* → add
  `testplay-byte/ACUTE-DASH` → *Contents: Read and write* → Save.
- **B (least privilege):** create a NEW fine-grained token scoped to ONLY
  `ACUTE-DASH` (Contents R/W, expiry ≤1y) — this is the recommended shape
  for the future CI secret `ACUTE_DASH_PAT`.

Then (once): `GITHUB_PAT=<token> node scripts/dashboard/publish-dashboard.mjs`
— future publishes are the orchestrator's job per WORKFLOW §6 (CI automation
via the repo secret can come later; the publisher prints exact guidance on a
403).

## Content rules (binding)

ALLOW: product name/tagline/version, pillar states+progress, milestone
one-liners, aggregate quality facts (test counts by suite, license verdict),
short SHA + build stamp, generic tech chips.
DENY: everything else — code, file trees, internal paths, credentials
(including lengths), the owner's private model id, env-var auth names,
localhost ports, the ntfy topic, internal ids, links to the private repo,
"how to run" details. The builder enforces the denylist mechanically; humans
keep status.json prose public-safe.
