#!/usr/bin/env node
/**
 * Dev backend bootstrapper (owner round-6: "test connection and the models
 * list fail to load" in the browser — plain `pnpm dev` has NO sidecar; only
 * the Tauri shell spawns one).
 *
 * `pnpm dev:full` runs this script: it starts the agent-core sidecar on the
 * FIXED port 127.0.0.1:5178 (the address the UI already defaults to) with
 *   - a stable dev SQLite DB at .dev/acute.db (gitignored, survives restarts)
 *   - the OpenRouter key read from Windows Credential Manager (never printed)
 * then starts vite. One Ctrl+C stops both.
 *
 * Plain `pnpm dev` (UI only, no sidecar) keeps working exactly as before.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_PORT = 5178;
const DEV_TOKEN = "acute-dev-local";
const devDir = resolve(repoRoot, ".dev");
mkdirSync(devDir, { recursive: true });

/** Resolve the OpenRouter key: env passthrough (how the desktop runner injects
 *  it on every platform) → Windows Credential Manager → Linux/macOS key file.
 *  Absence is non-fatal. Never printed — length only. */
function readProviderKey() {
  if (process.env.ACUTE_PROVIDER_OPENROUTER) {
    const fromEnv = process.env.ACUTE_PROVIDER_OPENROUTER;
    console.error(`[dev] OpenRouter key from ACUTE_PROVIDER_OPENROUTER env (length ${fromEnv.length}).`);
    return fromEnv;
  }
  const keyFile = resolve(process.env.HOME ?? ".", ".acute", "openrouter.key");
  if (process.platform !== "win32" && existsSync(keyFile)) {
    const fromFile = readFileSync(keyFile, "utf8").trim();
    if (fromFile) {
      console.error(`[dev] OpenRouter key from ${keyFile} (length ${fromFile.length}).`);
      return fromFile;
    }
  }
  const res = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-File",
      resolve(repoRoot, "scripts", "credential.ps1"),
      "Read",
      "ACUTE-CODE/provider/openrouter",
    ],
    { encoding: "utf8" },
  );
  const key = res.stdout ? res.stdout.trim() : "";
  if (!key) {
    console.error(
      "[dev] No OpenRouter key found (Credential Manager ACUTE-CODE/provider/openrouter, ACUTE_PROVIDER_OPENROUTER env, or ~/.acute/openrouter.key) — model catalog and connection tests will fail until one is stored.",
    );
    return "";
  }
  console.error(`[dev] OpenRouter key loaded from Credential Manager (length ${key.length}).`);
  return key;
}

const distMain = resolve(repoRoot, "agent-core", "dist", "main.js");
if (!existsSync(distMain)) {
  console.error("[dev] agent-core/dist/main.js missing — run `pnpm --filter agent-core build` first.");
  process.exit(1);
}

const key = readProviderKey();
const sidecar = spawn(process.execPath, [distMain], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ACUTE_TOKEN: DEV_TOKEN,
    ACUTE_PORT: String(DEV_PORT),
    ACUTE_DB_PATH: resolve(devDir, "acute.db"),
    ...(key ? { ACUTE_PROVIDER_OPENROUTER: key } : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
sidecar.stdout.on("data", (d) => process.stdout.write(`[sidecar] ${d}`));
sidecar.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));
sidecar.on("exit", (code) => {
  console.error(`[dev] sidecar exited (${code}) — shutting down.`);
  vite.kill();
  process.exit(code ?? 0);
});

// Give the sidecar a moment to print its ready line before the UI boots.
await new Promise((r) => setTimeout(r, 1200));

const vite = spawn("pnpm dev", { cwd: repoRoot, shell: true, stdio: "inherit" });
vite.on("exit", () => {
  sidecar.kill();
  process.exit(0);
});

function shutdown() {
  vite.kill();
  sidecar.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
