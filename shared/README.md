# shared

Domain types shared between the React frontend (workspace root) and the
`agent-core` Node sidecar. Types only — no runtime code ships from here in
Phase 1, which is why `package.json` points `main`/`exports` at the TypeScript
source (`src/index.ts`): Vite/Vitest consume the source directly, and
`pnpm build` emits a compiled `dist/` for future Node consumers.

## Contents

- `src/index.ts` — the v1 domain model: `AgentRecord`, `RunMode`,
  `SessionStatus`, `ApprovalDecision`, `ToolPermission`, `UsageRecord`.
- `src/index.test.ts` — type-level smoke test plus runtime shape asserts.

## Scripts

- `pnpm --filter shared test` — vitest
- `pnpm --filter shared typecheck` — tsc --noEmit (library sources)
- `pnpm --filter shared build` — emit `dist/` (JS + declarations)

All test files across the workspace are additionally typechecked by the root
`tsconfig.json` program (`pnpm typecheck`).
