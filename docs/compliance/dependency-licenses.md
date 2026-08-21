# Dependency License Audit

**Status: begins Phase 1** (when the first dependencies are installed and CI exists).

Policy (SPEC §6): allowed — MIT, Apache-2.0, BSD, ISC, MPL-2.0. Forbidden — GPL, AGPL, LGPL (closed-source distribution). The CI job runs `pnpm licenses ls --json`, generates this file, and fails the build on any forbidden license. Every license-related exception is recorded as an ADR.
