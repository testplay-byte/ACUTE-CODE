// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSidecarInfo,
  getSidecarStatus,
  isTauri,
  pingSidecar,
  restartSidecar,
} from "./sidecar";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Installs a capturable __TAURI__ shell for one test. */
function stubTauri(invoke: Invoke): void {
  (window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
}

function clearTauri(): void {
  delete (window as { __TAURI__?: unknown }).__TAURI__;
}

beforeEach(clearTauri);

afterEach(() => {
  vi.unstubAllEnvs();
  clearTauri();
});

describe("sidecar endpoint resolution", () => {
  it("is not inside Tauri under happy-dom", () => {
    expect(isTauri()).toBe(false);
  });

  it("falls back to VITE_ACUTE_* env vars in a plain browser", async () => {
    vi.stubEnv("VITE_ACUTE_PORT", "43127");
    vi.stubEnv("VITE_ACUTE_TOKEN", "tok_dev");

    await expect(getSidecarInfo()).resolves.toEqual({ port: 43127, token: "tok_dev" });
  });

  it("resolves to null in a browser without dev env vars", async () => {
    await expect(getSidecarInfo()).resolves.toBeNull();
  });
});

describe("ROUND-53 shell command wrappers", () => {
  it("getSidecarInfo resolves the running {port, token}", async () => {
    stubTauri(async (command) => {
      expect(command).toBe("sidecar_info");
      return { port: 55963, token: "tok-53" };
    });
    await expect(getSidecarInfo()).resolves.toEqual({ port: 55963, token: "tok-53" });
  });

  it("getSidecarInfo swallows a not-running refusal (callers retry via the loop)", async () => {
    stubTauri(async () => {
      throw new Error("sidecar is starting");
    });
    await expect(getSidecarInfo()).resolves.toBeNull();
  });

  it("getSidecarStatus returns the phase view, including the failure reason", async () => {
    stubTauri(async (command) => {
      expect(command).toBe("sidecar_status");
      return { phase: "failed", error: "spawning `node` failed" };
    });
    await expect(getSidecarStatus()).resolves.toEqual({
      phase: "failed",
      error: "spawning `node` failed",
    });
  });

  it("getSidecarStatus is null outside Tauri / on shell refusal", async () => {
    expect(await getSidecarStatus()).toBeNull();
    stubTauri(async () => {
      throw new Error("boom");
    });
    expect(await getSidecarStatus()).toBeNull();
  });

  it("restartSidecar invokes the shell restart and reports success", async () => {
    const commands: string[] = [];
    stubTauri(async (command) => {
      commands.push(command);
      return "restarting";
    });
    await expect(restartSidecar()).resolves.toBe(true);
    expect(commands).toEqual(["restart_sidecar"]);
  });

  it("restartSidecar reports failure when the shell refuses", async () => {
    stubTauri(async () => {
      throw new Error("busy");
    });
    await expect(restartSidecar()).resolves.toBe(false);
  });

  it("pingSidecar surfaces the shell health round-trip", async () => {
    stubTauri(async (command) => {
      expect(command).toBe("ping_sidecar");
      return "ok";
    });
    await expect(pingSidecar()).resolves.toBe(true);

    stubTauri(async () => {
      throw new Error("health check failed");
    });
    await expect(pingSidecar()).resolves.toBe(false);
  });
});
