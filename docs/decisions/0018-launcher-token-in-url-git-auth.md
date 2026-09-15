<!-- last-reviewed: 2026-09-12 round-98 -->
# ADR-0018: Launcher git auth = token-in-URL for one command (no credential helpers)

- **Status:** ACCEPTED (backfilled round-17; decided round-13)
- **Date:** 2026-08-23

## Context

Owner's Windows clone failed twice with identical `/dev/tty` +
"failed to execute prompt script" symptoms: credential helpers
(`store --file="C:/…"` quoted, and even single-word `store` under isolated
HOME) never answered on Git-for-Windows from a double-clicked console — git
fell back to an interactive prompt that cannot exist there. Owner then
accepted a local `credentials.txt` for the launcher.

## Options considered

- **Keep fighting helper configurations** — environment-sensitive, twice
  burned.
- **Token-in-URL for the ONE command** — the CI-proven pattern: nothing to
  configure, nothing to break.

## Decision

The launcher authenticates each git network command (clone/fetch/pull) by
passing `https://user:token@host/...` to that single invocation, then
sanitizes the stored remote to the tokenless URL immediately after clone.
`GIT_TERMINAL_PROMPT=0` + `GIT_CONFIG_NOSYSTEM=1` + isolated `HOME` mean git
can never hang on a prompt or consult foreign config. The token and full
authed URL are registered with the log redactor; grep-verified absent from
`.git/config` and logs.

## Consequences

Clone/pull works on any Windows console with zero helper machinery. Token
touches disk only in the 0600 isolated store + `credentials.txt` (owner's
custody choice). Machine-user credentials (GCM) never interfere. Reversal:
swap to a helper behind the same interface.
