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
 *   - ROUND-80 (R80): the NVIDIA key (ACUTE_PROVIDER_NVIDIA env or
 *     ~/.acute/nvidia.key) — the built-in nvidia provider row is seeded on
 *     every boot; with a key present the connection test + models fetch
 *     work out of the box.
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

/**
 * ROUND-44 (R44-d, owner directive: "for the 3 sub-agent API keys I want to
 * save them inside the credentials.txt so I don't have to manually enter
 * them"): the sub-agent POOL keys. The launcher (and the credentials.txt it
 * maintains) now carries OPENROUTER_SUB1..3_KEY; they are distributed to the
 * same three stores the primary key uses, under the slot names the keyring's
 * pool expects (registry.ts: ACUTE_PROVIDER_OPENROUTER_SLOT{N}, N ≥ 2 —
 * slots 2/3/4 are exactly the three the Settings → Sub-agents tab shows and
 * the orchestrator prefers for child runs). Same resolution order as the
 * primary key: env → key file → Windows Credential Manager. Never printed.
 */
function readSlotKey(slot) {
  const envName = `ACUTE_PROVIDER_OPENROUTER_SLOT${slot}`;
  if (process.env[envName]) {
    const fromEnv = process.env[envName];
    console.error(`[dev] pool slot ${slot} key from ${envName} env (length ${fromEnv.length}).`);
    return fromEnv;
  }
  const keyFile = resolve(process.env.HOME ?? ".", ".acute", `openrouter-slot${slot}.key`);
  if (process.platform !== "win32" && existsSync(keyFile)) {
    const fromFile = readFileSync(keyFile, "utf8").trim();
    if (fromFile) {
      console.error(`[dev] pool slot ${slot} key from ${keyFile} (length ${fromFile.length}).`);
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
      `ACUTE-CODE/provider/openrouter-slot${slot}`,
    ],
    { encoding: "utf8" },
  );
  const key = res.stdout ? res.stdout.trim() : "";
  if (key) console.error(`[dev] pool slot ${slot} key loaded from Credential Manager (length ${key.length}).`);
  return key;
}

/**
 * ROUND-80 (R80, owner: "make sure it works with the nvidia api key too"):
 * the NVIDIA NIM key — env passthrough (ACUTE_PROVIDER_NVIDIA, how the
 * packaged app injects it) -> Linux/macOS key file (~/.acute/nvidia.key).
 * Absence is non-fatal (the nvidia provider row seeds regardless; its
 * connection test simply reports no key). Never printed — length only.
 */
function readNvidiaKey() {
  if (process.env.ACUTE_PROVIDER_NVIDIA) {
    const fromEnv = process.env.ACUTE_PROVIDER_NVIDIA;
    console.error(`[dev] NVIDIA key from ACUTE_PROVIDER_NVIDIA env (length ${fromEnv.length}).`);
    return fromEnv;
  }
  const keyFile = resolve(process.env.HOME ?? ".", ".acute", "nvidia.key");
  if (process.platform !== "win32" && existsSync(keyFile)) {
    const fromFile = readFileSync(keyFile, "utf8").trim();
    if (fromFile) {
      console.error(`[dev] NVIDIA key from ${keyFile} (length ${fromFile.length}).`);
      return fromFile;
    }
  }
  console.error("[dev] No NVIDIA key found (ACUTE_PROVIDER_NVIDIA env or ~/.acute/nvidia.key) — the nvidia provider stays keyless until one is stored.");
  return "";
}

const poolSlots = [2, 3, 4]
  .map((slot) => [slot, readSlotKey(slot)])
  .filter(([, key]) => key !== "");

const distMain = resolve(repoRoot, "agent-core", "dist", "main.js");
if (!existsSync(distMain)) {
  console.error("[dev] agent-core/dist/main.js missing — run `pnpm --filter agent-core build` first.");
  process.exit(1);
}

const key = readProviderKey();
// ROUND-44 (R44-d): pool slots ride along in the spawn env — the keyring
// snapshots them into the in-memory pool; nothing is persisted to disk.
const slotEnv = {};
for (const [slot, slotKey] of poolSlots) slotEnv[`ACUTE_PROVIDER_OPENROUTER_SLOT${slot}`] = slotKey;
if (poolSlots.length > 0) {
  console.error(`[dev] sub-agent key pool: ${poolSlots.length} slot key(s) active (${poolSlots.map(([s]) => `slot ${s}`).join(", ")}).`);
}
// ROUND-80 (R80): the NVIDIA key rides the same spawn-env pattern.
const nvidiaKey = readNvidiaKey();
const sidecar = spawn(process.execPath, [distMain], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ACUTE_TOKEN: DEV_TOKEN,
    ACUTE_PORT: String(DEV_PORT),
    ACUTE_DB_PATH: resolve(devDir, "acute.db"),
    ...(key ? { ACUTE_PROVIDER_OPENROUTER: key } : {}),
    ...slotEnv,
    ...(nvidiaKey ? { ACUTE_PROVIDER_NVIDIA: nvidiaKey } : {}),
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
