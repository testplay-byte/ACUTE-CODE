# scripts/

Repo-level maintenance scripts run through `pnpm <script>` at the workspace
root.

- `license-audit.mjs` (`pnpm license:audit`) — runs
  `pnpm licenses ls --json --prod`, writes
  `docs/compliance/dependency-licenses.md` (package / version / license /
  verdict table), and exits 1 on any copyleft (GPL/AGPL/LGPL) or
  unclassifiable license in production dependencies. Part of `pnpm verify`
  and CI.
