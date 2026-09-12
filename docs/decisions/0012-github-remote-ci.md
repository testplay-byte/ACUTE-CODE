<!-- last-reviewed: 2026-09-12 round-94 -->
# ADR-0012: GitHub remote for CI and heavy builds

- **Status:** ACCEPTED (owner provided repo + token, 2026-08-22)
- **Date:** 2026-08-22

## Context

The owner directed that heavy lifting (Rust compilation, long builds) should run on GitHub Actions rather than the local 8 GB machine, and provided a repository (testplay-byte/ACUTE-CODE) with a full-access fine-grained PAT. ADR-0005 anticipated this. The repo was created **public**; ACUTE-CODE is closed-source (brief §7), so pushing to a public repo would have published the codebase.

## Options considered

- **A. Push to the repo as-is (public)** — violates the closed-source mandate outright.
- **B. Ask the owner to flip it private, then push** — safe but blocks setup on a round-trip.
- **C. Use the full-access token to set the repo private via API (`PATCH /repos/... {"private":true}`), then push** — same safety, immediate, reversible.

## Decision

**Option C.** The repo was verified and set to **private** via the API (HTTP 200) before any push. The token is stored only in Windows Credential Manager, written via `git credential approve` with the `wincred` helper (GCM special-cases github.com toward OAuth and discarded Basic credentials; per-URL helper override: `credential.https://github.com.helper = wincred`). The remote URL embeds the username (`https://testplay-byte@github.com/...`) so credential lookup is deterministic and no plaintext token exists in any file. Push of `main` succeeded; the CI workflow now owns lint/typecheck/test/build/license-audit/cargo-check execution.

## Consequences

Heavy builds default to GitHub Actions from now on; local runs of `pnpm verify` remain the fast pre-push gate, and local cargo work is reserved for debugging CI failures. The token never appears in the repo, logs, or docs; if it must be referenced, it is retrieved from Credential Manager at runtime. Secrets scheme: provider API keys live under Credential Manager targets `ACUTE-CODE/provider/<providerId>`; the GitHub token lives under the wincred entry `git:https://testplay-byte@github.com`. Rotation requires updating the Credential Manager entry only.
