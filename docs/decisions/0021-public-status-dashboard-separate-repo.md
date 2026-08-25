<!-- last-reviewed: 2026-08-25 round-35 -->
# ADR-0021: Public status dashboard in a separate repo (ACUTE-DASH)

- **Status:** ACCEPTED (round-17; owner requested a visual GitHub Pages dashboard)
- **Date:** 2026-08-23

## Context

Owner wants a scannable public status page (style reference:
testplay-byte.github.io/ANI-KUTA). The product repo is PRIVATE/closed-source
— Pages on it is paid AND a leak hazard; "nothing published to public
registries" applies to source, not to curated status.

## Options considered

- **Pages on the private repo** — needs a paid plan; one toggle mistake
  publishes the closed source. Rejected.
- **Separate PUBLIC repo containing only a generated static page** — the
  private repo keeps a hand-curated `docs/status.json`; a zero-dep builder
  renders a self-contained `index.html` and publishes it to
  `testplay-byte/DASHBOARD` (Pages from `main`; repo + scoped PAT created by the owner round-18).

## Decision

Separate-repo dashboard. The builder (`scripts/dashboard/build-dashboard.mjs`)
reads ONLY `docs/status.json` + git metadata, HTML-escapes everything, and
runs a DENYLIST assert on the output (tokens/key patterns, the owner's
private model id, internal paths, env names, ports, the ntfy topic, id
prefixes, repo paths) — **exit 1 before publishing** if anything matches
(fail-closed). Publishing is agent-driven via
`scripts/dashboard/publish-dashboard.mjs` (uses the owner-provided
DASHBOARD-scoped PAT via the `DASHBOARD_PAT` env var, token-in-URL +
sanitization per ADR-0018). The dashboard carries a "The Plan" section
(current focus, upcoming phases, principles) per owner request round-18.
Pages stays DISABLED on the private repo — part of the pre-push checks.

## Consequences

Owner gets a live visual dashboard with zero exposure of code/secrets;
staleness is self-evident (generated-at stamp + SHA). Rule: statuses are
hand-distilled one-liners, never scraped content. Reversal: delete the repo
+ scripts. See `docs/runbooks/PUBLIC-DASHBOARD.md`.
