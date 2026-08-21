import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db";

describe("openDatabase (placeholder)", () => {
  it("returns a ready handle for the requested path", () => {
    const handle = openDatabase("data/acute-code.db");
    expect(handle.path).toBe("data/acute-code.db");
    expect(handle.ready).toBe(true);
  });
});
