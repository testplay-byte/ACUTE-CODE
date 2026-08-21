/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Port matches src-tauri/tauri.conf.json devUrl; strictPort fails fast if 5173 is taken.
  server: { port: 5173, strictPort: true },
  build: { target: "es2022", outDir: "dist" },
  // Vitest runs every workspace's tests from this config. Default environment is
  // "node"; DOM tests opt in per file with a `// @vitest-environment happy-dom` docblock.
});
