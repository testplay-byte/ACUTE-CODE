import { defineConfig } from "vitest/config";

// E2E suite: black-box tests against the BUILT sidecar (agent-core/dist/main.js).
// Runs after `pnpm build` in the verify chain — skipped (not failed) when dist is absent.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
