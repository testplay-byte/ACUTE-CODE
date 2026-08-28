/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

// ROUND-45: the app version is single-sourced from package.json (see
// scripts/release/version.mjs) — injected here so the UI badge can never
// drift from the release artifacts. Works for vitest too (same config).
const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // Port matches src-tauri/tauri.conf.json devUrl; strictPort fails fast if 5173 is taken.
  server: { port: 5173, strictPort: true },
  build: { target: "es2022", outDir: "dist" },
  // Vitest runs every workspace's tests from this config. Default environment is
  // "node"; DOM tests opt in per file with a `// @vitest-environment happy-dom` docblock.
});
