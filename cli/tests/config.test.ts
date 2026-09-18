/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2/§6): the CONFIG store + command units —
 * ~/.acute/cli.json get/set (default agent/model/db), the strict-tolerant
 * read (corrupt/absent → {}), the 0600 write, and the `acute config`
 * subcommand surface over a TEMP home (no secrets ever — the store's
 * documented contract).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { colorKitFor } from "../src/color.js";
import {
  cliConfigPath,
  isConfigKey,
  readCliConfig,
  writeCliConfig,
  type CliConfig,
} from "../src/config.js";
import { runConfigCommand } from "../src/commands/config.js";
import type { UiContext } from "../src/context.js";

const PLAIN_KIT = colorKitFor(false, {});

/** A fresh temp home per test (module-level injection). */
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "acute-cli-config-"));
}

describe("readCliConfig / writeCliConfig (the store)", () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("absent store → {}; the path is ~/.acute/cli.json", () => {
    expect(cliConfigPath(home)).toBe(join(home, ".acute", "cli.json"));
    expect(readCliConfig(home)).toEqual({});
  });

  it("corrupt / non-object stores degrade to {} (a bad file never breaks the CLI)", () => {
    mkdirSync(join(home, ".acute"), { recursive: true });
    const file = cliConfigPath(home);
    writeFileSync(file, "{corrupt json");
    expect(readCliConfig(home)).toEqual({});
    writeFileSync(file, JSON.stringify(["array"]));
    expect(readCliConfig(home)).toEqual({});
    writeFileSync(file, JSON.stringify(null));
    expect(readCliConfig(home)).toEqual({});
  });

  it("only the three KNOWN string keys survive a read (unknown + non-string + blank dropped)", () => {
    mkdirSync(join(home, ".acute"), { recursive: true });
    writeFileSync(
      cliConfigPath(home),
      JSON.stringify({
        agent: " a1 ", // trimmed
        model: "m1",
        db: "", // blank → dropped
        bogus: "x", // unknown key → dropped
        extra: 42,
      }),
    );
    expect(readCliConfig(home)).toEqual({ agent: "a1", model: "m1" });
  });

  it("writeCliConfig creates ~/.acute, writes the JSON + newline, and roundtrips", () => {
    const store: CliConfig = { agent: "architect", model: "z-ai/glm-5.2:free", db: "/tmp/x.db" };
    writeCliConfig(store, home);
    const file = cliConfigPath(home);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(store, null, 2)}\n`);
    expect(readCliConfig(home)).toEqual(store);
  });

  it.skipIf(process.platform === "win32")("the store file is mode 0600 (POSIX)", () => {
    writeCliConfig({ model: "m" }, home);
    const mode = statSync(cliConfigPath(home)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("isConfigKey accepts exactly agent|model|db", () => {
    expect(isConfigKey("agent")).toBe(true);
    expect(isConfigKey("model")).toBe(true);
    expect(isConfigKey("db")).toBe(true);
    expect(isConfigKey("token")).toBe(false);
    expect(isConfigKey("")).toBe(false);
  });
});

describe("the `acute config` command (over a TEMP home — no real ~/.acute is touched)", () => {
  let home: string;
  let out: string[];
  let err: string[];
  let ctx: () => UiContext;

  beforeEach(() => {
    home = tempHome();
    // os.homedir() reads HOME (POSIX) / USERPROFILE (win32) per call — both
    // stubbed so the command's internal readCliConfig()/writeCliConfig()
    // land in the temp home on every platform.
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    out = [];
    err = [];
    ctx = () => ({
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      kit: PLAIN_KIT,
      plain: true,
      quiet: false,
      json: false,
      autoApprove: false,
      config: {},
      flags: {},
      repoRoot: "/repo",
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("`config get` prints the whole store with (unset) placeholders — exit 0", async () => {
    const code = await runConfigCommand(ctx(), ["get"]);
    expect(code).toBe(0);
    expect(out.join("")).toContain("~/.acute/cli.json");
    expect(out.join("")).toContain("  agent    (unset)");
    expect(out.join("")).toContain("  model    (unset)");
    expect(err).toEqual([]);
  });

  it("`config set` writes the store and confirms — exit 0", async () => {
    const code = await runConfigCommand(ctx(), ["set", "model", "z-ai/glm-5.2:free"]);
    expect(code).toBe(0);
    expect(out.join("")).toBe("set model = z-ai/glm-5.2:free\n");
    expect(readCliConfig(home)).toEqual({ model: "z-ai/glm-5.2:free" });
    // a later `get` sees it
    out = [];
    expect(await runConfigCommand(ctx(), ["get", "model"])).toBe(0);
    expect(out.join("")).toBe("z-ai/glm-5.2:free\n");
  });

  it("`config set` values may span multiple words (joined + trimmed)", async () => {
    expect(await runConfigCommand(ctx(), ["set", "agent", "  code", "reviewer  "])).toBe(0);
    expect(readCliConfig(home)).toEqual({ agent: "code reviewer" });
  });

  it("unknown keys, missing values, and unknown subcommands fail honestly — exit 1", async () => {
    expect(await runConfigCommand(ctx(), ["get", "token"])).toBe(1);
    expect(err.join("")).toContain("unknown config key 'token' — agent|model|db");
    err = [];
    expect(await runConfigCommand(ctx(), ["set", "model"])).toBe(1); // no value
    expect(err.join("")).toContain("usage: acute config set");
    err = [];
    expect(await runConfigCommand(ctx(), ["set", "bogus", "x"])).toBe(1);
    expect(err.join("")).toContain("unknown config key 'bogus'");
    err = [];
    expect(await runConfigCommand(ctx(), ["frobnicate"])).toBe(1);
    expect(err.join("")).toContain("unknown config subcommand: frobnicate");
    expect(err.join("")).toContain("usage:");
    err = [];
    expect(await runConfigCommand(ctx(), [])).toBe(1);
    expect(err.join("")).toContain("usage:");
  });

  it("json mode: the whole store / one key as NDJSON lines", async () => {
    const jsonCtx = (): UiContext => ({ ...ctx(), json: true });
    writeCliConfig({ model: "m1" }, home);
    expect(await runConfigCommand(jsonCtx(), ["get"])).toBe(0);
    expect(out.join("")).toBe(`${JSON.stringify({ model: "m1" })}\n`);
    out = [];
    expect(await runConfigCommand(jsonCtx(), ["get", "model"])).toBe(0);
    expect(out.join("")).toBe(`${JSON.stringify({ model: "m1" })}\n`);
    out = [];
    expect(await runConfigCommand(jsonCtx(), ["get", "agent"])).toBe(0);
    expect(out.join("")).toBe(`${JSON.stringify({ agent: null })}\n`);
  });
});
