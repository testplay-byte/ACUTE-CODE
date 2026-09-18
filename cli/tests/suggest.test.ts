/**
 * ROUND-107 (R107-c-impl, F4): the did-you-mean units — the bounded
 * Levenshtein (`suggest`) over the CLI's real name tables and the
 * ready-made clause (`didYouMean`), including the prefix rule and the
 * nothing-close case (silence beats a noisy guess).
 */
import { describe, expect, it } from "vitest";
import { didYouMean, suggest } from "../src/suggest.js";

const COMMANDS = ["sessions", "models", "providers", "keys", "approvals", "config", "status", "raw"];

describe("suggest (bounded Levenshtein over the name tables)", () => {
  it("a one-edit typo finds the real name, closest first", () => {
    expect(suggest("sesions", COMMANDS)).toEqual(["sessions"]);
    expect(suggest("model", COMMANDS)).toEqual(["models"]);
    expect(suggest("statu", COMMANDS)).toEqual(["status"]);
  });

  it("a prefix (≥ 2 chars) outranks edit distance; short inputs stay tight", () => {
    expect(suggest("ses", COMMANDS)).toEqual(["sessions"]);
    expect(suggest("app", COMMANDS)).toEqual(["approvals"]);
    // a 3-char needle matching something 2 edits away is noise, not a hint
    expect(suggest("kes", COMMANDS)).toEqual(["keys"]);
  });

  it("multiple hits come back ranked (score, then alphabetical), at most 3", () => {
    expect(suggest("confg", COMMANDS)).toEqual(["config"]);
    expect(suggest("raws", COMMANDS)).toEqual(["raw"]);
  });

  it("nothing within the bound → [] (silence, never a noisy guess)", () => {
    expect(suggest("zzzzzz", COMMANDS)).toEqual([]);
    expect(suggest("x", COMMANDS)).toEqual([]); // single chars never prefix-match
    expect(suggest("", COMMANDS)).toEqual([]);
  });

  it("matching is case-insensitive; an exact match is never suggested", () => {
    expect(suggest("SESIONS", COMMANDS)).toEqual(["sessions"]);
    expect(suggest("status", COMMANDS)).toEqual([]);
  });

  it("subcommand pools work the same way", () => {
    expect(suggest("lst", ["ls", "show", "events", "ctx", "rm", "rename", "resume"])).toEqual(["ls"]);
    expect(suggest("aprove", ["ls", "approve", "deny"])).toEqual(["approve"]);
  });
});

describe("didYouMean (the ready-made clause)", () => {
  it("one hit → ` — did you mean 'x'?`", () => {
    expect(didYouMean("sesions", COMMANDS)).toBe(" — did you mean 'sessions'?");
  });

  it("no hit → empty string (the caller's message stays untouched)", () => {
    expect(didYouMean("zzzzzz", COMMANDS)).toBe("");
  });

  it("the render shapes the candidate (flags carry their --)", () => {
    expect(didYouMean("quie", ["quiet", "quiet-x"], (n) => `'--${n}'`)).toBe(
      " — did you mean one of: '--quiet', '--quiet-x'?",
    );
  });

  it("multiple hits → ` — did you mean one of: …?`", () => {
    const clause = didYouMean("st", ["status", "stop", "start", "sessions"]);
    expect(clause).toBe(" — did you mean one of: 'start', 'status', 'stop'?");
  });
});
