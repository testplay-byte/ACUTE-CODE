/**
 * ROUND-106 (R106-S3, CLI-DESIGN §4): the COLOR KIT units — the NO_COLOR +
 * non-TTY auto-disable rule (acute.mjs's rule, kept byte-for-byte in
 * spirit), the truecolor accent #ff6b2c → `38;2;255;107;44`, and the
 * bold-accent heading + accent-code variants.
 */
import { describe, expect, it } from "vitest";
import { accentCode, boldAccent, colorKitFor } from "../src/color.js";

describe("colorKitFor (NO_COLOR + non-TTY auto-disable)", () => {
  it("non-TTY stdout disables EVERYTHING (identity functions)", () => {
    const kit = colorKitFor(false, {});
    expect(kit.enabled).toBe(false);
    expect(kit.bold("x")).toBe("x");
    expect(kit.dim("x")).toBe("x");
    expect(kit.accent("x")).toBe("x");
    expect(kit.red("x")).toBe("x");
    expect(kit.green("x")).toBe("x");
    expect(kit.yellow("x")).toBe("x");
  });

  it("NO_COLOR env disables everything even on a TTY", () => {
    const kit = colorKitFor(true, { NO_COLOR: "1" });
    expect(kit.enabled).toBe(false);
    expect(kit.red("err")).toBe("err");
  });

  it("a TTY without NO_COLOR gets SGR codes", () => {
    const kit = colorKitFor(true, {});
    expect(kit.enabled).toBe(true);
    expect(kit.red("err")).toBe("\x1b[31merr\x1b[39m");
    expect(kit.dim("note")).toBe("\x1b[2mnote\x1b[22m");
    expect(kit.bold("h")).toBe("\x1b[1mh\x1b[22m");
    expect(kit.green("ok")).toBe("\x1b[32mok\x1b[39m");
    expect(kit.yellow("w")).toBe("\x1b[33mw\x1b[39m");
  });

  it("the accent is the app's #ff6b2c as truecolor 38;2;255;107;44", () => {
    const kit = colorKitFor(true, {});
    expect(kit.accent("go")).toBe("\x1b[38;2;255;107;44mgo\x1b[39m");
  });

  it("boldAccent composes 1 + the accent SGR; accentCode stays single-SGR", () => {
    const kit = colorKitFor(true, {});
    expect(boldAccent(kit, "H")).toBe("\x1b[1;38;2;255;107;44mH\x1b[22;39m");
    expect(accentCode(kit, "c")).toBe("\x1b[38;2;255;107;44mc\x1b[39m");
    const plain = colorKitFor(false, {});
    expect(boldAccent(plain, "H")).toBe("H");
    expect(accentCode(plain, "c")).toBe("c");
  });
});
