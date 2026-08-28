import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * ROUND-45 (audit P0-3): children spawned by the sidecar must NEVER inherit
 * its secrets. buildChildEnv() is the allowlist-based scrubber every spawn
 * site uses (exec.ts run_command, server.ts terminal sync+stream routes,
 * git.ts, dialogs.ts, and the R45-b terminal sessions).
 */
import { buildChildEnv } from "../src/lib/child-env";
import { runCommand } from "../src/tools/exec";

let tempDir = "";
let projectRoot = "";

beforeEach(() => {
  if (tempDir === "") {
    tempDir = mkdtempSync(join(tmpdir(), "acute-childenv-"));
    projectRoot = mkdtempSync(join(tmpdir(), "acute-childenv-root-"));
  }
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("buildChildEnv (P0-3 allowlist scrubber)", () => {
  it("drops ACUTE_* variables (token, provider keys, slot keys, db path)", () => {
    const before = {
      ACUTE_TOKEN: "acute-dev-local",
      ACUTE_PORT: "5178",
      ACUTE_DB_PATH: "/x/acute.db",
      ACUTE_PROVIDER_OPENROUTER: "sk-or-v1-main",
      ACUTE_PROVIDER_OPENROUTER_SLOT2: "sk-or-v1-sub1",
      ACUTE_PROVIDER_OPENROUTER_SLOT3: "sk-or-v1-sub2",
      ACUTE_PROVIDER_OPENROUTER_SLOT4: "sk-or-v1-sub3",
    };
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(before)) {
      saved[k] = process.env[k];
      process.env[k] = before[k as keyof typeof before];
    }
    try {
      const env = buildChildEnv();
      for (const k of Object.keys(before)) {
        expect(env[k], `${k} must not reach the child`).toBeUndefined();
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("drops secret-shaped names even if a future allowlist edit adds them (second layer)", () => {
    const saved = process.env.PATH;
    process.env.PATH = "/usr/bin"; // an allowlisted name
    process.env.GITHUB_TOKEN = "ghp_abc";
    process.env.MY_API_KEY = "k123";
    try {
      const env = buildChildEnv();
      expect(env.PATH).toBe("/usr/bin"); // allowed name survives
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.MY_API_KEY).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
      delete process.env.GITHUB_TOKEN;
      delete process.env.MY_API_KEY;
    }
  });

  it("keeps the OS essentials a child needs to run", () => {
    process.env.ACUTE_TOKEN = "leak-me";
    const env = buildChildEnv();
    expect(env.FORCE_COLOR).toBe("0");
    expect(env.CI).toBe("1");
    // PATH is on every platform the sidecar runs on.
    expect(typeof env.PATH).toBe("string");
    expect(env.PATH!.length).toBeGreaterThan(0);
    expect(env.ACUTE_TOKEN).toBeUndefined();
    delete process.env.ACUTE_TOKEN;
  });

  it("never passes caller extras with secret-shaped names through", () => {
    const env = buildChildEnv({ OKAY_VAR: "yes", EVIL_TOKEN: "no" });
    expect(env.OKAY_VAR).toBe("yes");
    expect(env.EVIL_TOKEN).toBeUndefined();
  });

  it("is a fresh object — mutating it cannot poison the sidecar env", () => {
    const a = buildChildEnv();
    a.PATH = "/hacked";
    const b = buildChildEnv();
    expect(b.PATH).not.toBe("/hacked");
  });
});

describe("runCommand env scrubbing (integration, P0-3)", () => {
  it("an executed command cannot read ACUTE_* from its environment", async () => {
    process.env.ACUTE_TOKEN = "acute-secret-token-123";
    process.env.ACUTE_PROVIDER_OPENROUTER = "sk-or-v1-secretkey-123456";
    try {
      const probe = `node -e "console.log(JSON.stringify({t:process.env.ACUTE_TOKEN||'clean',k:process.env.ACUTE_PROVIDER_OPENROUTER||'clean'}))"`;
      const result = await runCommand(projectRoot, probe);
      expect(result.ok).toBe(true);
      expect(result.output).toContain('"clean"');
      expect(result.output).not.toContain("acute-secret-token");
      expect(result.output).not.toContain("sk-or-v1-secretkey");
    } finally {
      delete process.env.ACUTE_TOKEN;
      delete process.env.ACUTE_PROVIDER_OPENROUTER;
    }
  }, 30_000);

  it("the child still finds node on PATH (env stays usable, not empty)", async () => {
    const result = await runCommand(projectRoot, "node --version");
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/v\d+\.\d+/);
  }, 30_000);
});
