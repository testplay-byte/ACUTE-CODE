/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ROUND-45: the app version is single-sourced from package.json (see
// scripts/release/version.mjs) — injected here so the UI badge can never
// drift from the release artifacts. Works for vitest too (same config).
const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// ROUND-59 (R59-b): the pop-out browser window's page — a SECOND vite entry.
// Dev mode serves any root .html automatically (/popout.html); the BUILD
// needs the explicit inputs so the page's bundle lands in dist/ where
// tauri's WebviewUrl::App("popout.html") resolves it. fileURLToPath (not
// URL.pathname) so the absolute input paths work on Windows drives too.
const indexEntry = fileURLToPath(new URL("./index.html", import.meta.url));
const popoutEntry = fileURLToPath(new URL("./popout.html", import.meta.url));
// ROUND-64 (R64-b): the floating computer-use mini monitor's page — a THIRD
// entry, same rules (build must land it in dist/ for WebviewUrl::App
// ("mini.html") to resolve).
const miniEntry = fileURLToPath(new URL("./mini.html", import.meta.url));
// ROUND-90 (R90-C2): the menu overlay window's page — a FOURTH entry, same
// rules (the sidebar's popovers render in an owned OS window above the
// live browser webview; see src/menu-overlay + browser.rs's menu_overlay_*).
const menuOverlayEntry = fileURLToPath(new URL("./menu-overlay.html", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // Port matches src-tauri/tauri.conf.json devUrl; strictPort fails fast if 5173 is taken.
  server: { port: 5173, strictPort: true },
  build: {
    target: "es2022",
    outDir: "dist",
    rollupOptions: {
      // Multi-page: the main app + the pop-out browser window's chrome page
      // + the floating computer-use mini monitor page + the menu overlay.
      input: { index: indexEntry, popout: popoutEntry, mini: miniEntry, menu: menuOverlayEntry },
    },
  },
  // Vitest runs every workspace's tests from this config. Default environment is
  // "node"; DOM tests opt in per file with a `// @vitest-environment happy-dom` docblock.
  test: {
    // ROUND-73 CI-stability patch (R70's lesson, the sequel): the CI runner
    // (windows-latest) executes this suite 3-4x slower than a dev machine
    // under parallel load, and the integration files that spin a real
    // Fastify app per test (r72-references D3, sessions, server,
    // r73-modes-backend, orchestrator, …) can exceed vitest's 10s DEFAULT
    // hookTimeout there — CI run 34111934048 failed 2 r72-references tests
    // purely on beforeEach/afterEach (app.close + db open/close) hook
    // timeouts while the SAME suite was green locally (2558/2558, and the
    // same file green on CI at R72). Timeouts only fire on failure — raising
    // them slows nothing on a fast machine; it stops slow-runner flakes.
    // testTimeout follows for the same reason (the heaviest integration
    // tests run 2-4s on CI vs sub-second locally, uncomfortably close to
    // the 5s default).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // ROUND-73 CI-stability patch #2 (runs 34111934048 + 34113189649): the
    // second failure had ALL 2558 tests GREEN and still exited 1 on an
    // unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` — the
    // 60s birpc deadline (vitest's DEFAULT_TIMEOUT, not user-configurable)
    // for a worker→main RPC expired because the MAIN process was starved on
    // the 4-vCPU windows runner while every worker hammered it. Two CI-only
    // de-saturation levers, env-gated so local dev is byte-identical:
    //   · reporters "dot" — the default reporter's per-file progress lines
    //     are the main process's own print load; dot collapses them;
    //   · maxWorkers 2 — caps the fork pool below the runner's vCPU count,
    //     leaving the main process real headroom (wall-time cost on CI is
    //     the honest price of stability; failures still print full diffs).
    ...(process.env.CI ? { reporters: ["dot"], maxWorkers: 2 } : {}),
  },
});
