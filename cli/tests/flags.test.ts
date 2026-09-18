/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the FLAGS TABLE units — parsing
 * (long/short/=/joined forms, `--`, unknown detection) and the --help
 * generation (the single-source-of-truth contract: every flag row MUST
 * appear in the rendered help).
 */
import { describe, expect, it } from "vitest";
import { renderHelp } from "../src/main.js";
import {
  GLOBAL_FLAGS,
  flagBool,
  flagString,
  parseArgv,
  renderFlagHelp,
} from "../src/flags.js";

describe("parseArgv (the flags table parser)", () => {
  it("parses long flags with values, bare flags, and positionals", () => {
    const parsed = parseArgv(["--mode", "json", "--quiet", "sessions", "ls"]);
    expect(parsed.flags).toEqual({ mode: "json", quiet: true });
    expect(parsed.positionals).toEqual(["sessions", "ls"]);
    expect(parsed.unknown).toEqual([]);
  });

  it("supports --flag=value and joined short forms (-pjson → print=json)", () => {
    expect(parseArgv(["--mode=json"]).flags).toEqual({ mode: "json" });
    expect(parseArgv(["-p", "hello"]).flags).toEqual({ print: "hello" });
    expect(parseArgv(["-phello"]).flags).toEqual({ print: "hello" });
    expect(parseArgv(["--print=hello"]).flags).toEqual({ print: "hello" });
  });

  it("a value flag with NO value degrades to bare true (validated downstream)", () => {
    expect(parseArgv(["-p"]).flags).toEqual({ print: true });
    expect(parseArgv(["--model", "--quiet"]).flags).toEqual({ model: true, quiet: true });
  });

  it("`--` pushes everything after it positional (prompts with dashes)", () => {
    const parsed = parseArgv(["-p", "--", "--not-a-flag", "x"]);
    expect(parsed.positionals).toEqual(["--not-a-flag", "x"]);
    expect(parseArgv(["--", "-p"]).flags).toEqual({});
  });

  it("unknown flags land in `unknown` verbatim (the honest error path)", () => {
    const parsed = parseArgv(["--bogus", "value", "-z", "positional"]);
    expect(parsed.unknown).toEqual(["--bogus", "-z"]);
    // the unknown flag's VALUE stays positional (never swallowed silently)
    expect(parsed.positionals).toEqual(["value", "positional"]);
    expect(parseArgv(["--bogus", "value"]).positionals).toEqual(["value"]);
  });

  it("a lone `-` is a positional, not a flag", () => {
    expect(parseArgv(["-"]).positionals).toEqual(["-"]);
  });
});

describe("flagString / flagBool", () => {
  it("flagString: string values trimmed; bare/blank/absent → undefined", () => {
    expect(flagString({ model: " x " }, "model")).toBe("x");
    expect(flagString({ model: true }, "model")).toBeUndefined();
    expect(flagString({ model: "" }, "model")).toBeUndefined();
    expect(flagString({}, "model")).toBeUndefined();
  });

  it("flagBool: presence with any value counts", () => {
    expect(flagBool({ quiet: true }, "quiet")).toBe(true);
    expect(flagBool({ quiet: "x" }, "quiet")).toBe(true);
    expect(flagBool({}, "quiet")).toBe(false);
  });
});

describe("--help generation (the single source of truth)", () => {
  it("every GLOBAL_FLAGS row renders into the help text", () => {
    const help = renderHelp();
    for (const spec of GLOBAL_FLAGS) {
      const spelling = spec.short !== undefined ? `-${spec.short}, --${spec.name}` : `--${spec.name}`;
      expect(help).toContain(spelling);
      expect(help).toContain(spec.description);
    }
    expect(help).toContain("exit codes: 0 ok · 1 error · 130 double Ctrl-C");
  });

  it("the command table rides the help", () => {
    const help = renderHelp();
    for (const name of ["sessions", "models", "providers", "keys", "config", "status", "raw"]) {
      expect(help).toContain(name);
    }
  });

  it("renderFlagHelp marks value flags with <value> and aligns short aliases", () => {
    const rows = renderFlagHelp(GLOBAL_FLAGS);
    const print = rows.find((r) => r.includes("--print"));
    const quiet = rows.find((r) => r.includes("--quiet"));
    expect(print).toMatch(/-p, --print <value>/);
    expect(quiet).toMatch(/^\s+--quiet\s/);
  });
});
