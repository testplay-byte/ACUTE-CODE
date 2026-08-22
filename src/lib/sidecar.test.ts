import { afterEach, describe, expect, it, vi } from "vitest";
import { getSidecarInfo, isTauri } from "./sidecar";

afterEach(() => {
  vi.unstubAllEnvs();
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
