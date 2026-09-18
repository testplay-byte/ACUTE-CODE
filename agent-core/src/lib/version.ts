/**
 * ROUND-63: the app version /health reports — read at BOOT from the
 * package.json that sits NEXT TO the compiled code (agent-core/package.json
 * in the dev workspace; sidecar/app/package.json inside the installed
 * desktop app, where the staging step copies the exact version). This used
 * to be a hardcoded "0.3.0" that went stale for 60+ rounds, which made
 * /health useless for exactly the thing it exists for: letting the
 * launcher PROVE the freshly installed desktop app is really running the
 * new engine (registry version + exe FileVersion + /health version must
 * all agree — see launcher `desktop_flow`'s verification chain).
 *
 * ROUND-106 (R106-S1): extracted from server.ts into its own module so the
 * mobile routes (routes/mobile.ts — the pairing claim returns
 * machine.version) can share it without a server.ts import cycle. server.ts
 * re-exports it; every existing `import { VERSION } from "../server"`
 * keeps working unchanged.
 */
import { readFileSync } from "node:fs";

export function readAppVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    // A missing/corrupt manifest must never take the engine down — /health
    // then reports 0.0.0 and the launcher's check flags it honestly.
    return "0.0.0";
  }
}

export const VERSION = readAppVersion();
