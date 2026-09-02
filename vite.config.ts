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
      // + the floating computer-use mini monitor page.
      input: { index: indexEntry, popout: popoutEntry, mini: miniEntry },
    },
  },
  // Vitest runs every workspace's tests from this config. Default environment is
  // "node"; DOM tests opt in per file with a `// @vitest-environment happy-dom` docblock.
});
