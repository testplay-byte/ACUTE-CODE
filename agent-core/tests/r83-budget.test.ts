/**
 * ROUND-83 (R83): resolveTurnBudget — the ONE budget both the turn runners
 * and the context meter use. The audit's §2.5 (the donut and the compaction
 * trigger disagreed — different numerator AND denominator) and §2.8 (the
 * owner's per-model max_output_tokens was stored + editable since
 * migration 0004 but NEVER read: both budget sites hardcoded 32 768) close
 * here: one resolver, one truth, with the window's SOURCE labeled so a
 * silent 200K guess can never masquerade as a measured window (§2.7).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getModelContextWindow, resolveTurnBudget } from "../src/agents/runtime";
import { upsertModel } from "../src/storage/models";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r83-budget-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("resolveTurnBudget (ROUND-83 R83)", () => {
  it("resolution order: models-table override → catalog → 200 000 default, with the SOURCE labeled", () => {
    // 1. The owner's override wins (both window AND max output).
    upsertModel(db, "openrouter", {
      modelId: "test/r83-override",
      displayName: "Override",
      contextWindow: 123_456,
      maxOutputTokens: 4_096,
    });
    const override = resolveTurnBudget(db, "openrouter", "test/r83-override");
    expect(override.contextWindow).toBe(123_456);
    expect(override.contextWindowSource).toBe("override");
    expect(override.maxOutputTokens).toBe(4_096);
    expect(override.available).toBe(123_456 - 4_096 - 8_000);

    // 2. The catalog (no models row): a known model's window + output cap.
    const catalog = resolveTurnBudget(db, "openrouter", "z-ai/glm-5.2:free");
    expect(catalog.contextWindow).toBe(256_000);
    expect(catalog.contextWindowSource).toBe("catalog");
    expect(catalog.maxOutputTokens).toBeGreaterThan(0);

    // 3. Unknown model → the honest default WITH the label (the meter
    //    renders "assumed 200k — set it in Settings → Models").
    const fallback = resolveTurnBudget(db, "openrouter", "totally/unknown-r83");
    expect(fallback.contextWindow).toBe(200_000);
    expect(fallback.contextWindowSource).toBe("default");
    expect(fallback.maxOutputTokens).toBe(32_768);
  });

  it("§2.8 closed: the owner's per-model max_output_tokens is HONORED (the pre-R83 hardcode ignored it)", () => {
    // Window from the catalog, output cap from the owner's row — the MIXED
    // resolution path (a row that sets only max_output_tokens).
    upsertModel(db, "openrouter", {
      modelId: "z-ai/glm-5.2:free",
      displayName: "Owner-capped",
      maxOutputTokens: 2_048,
    });
    const budget = resolveTurnBudget(db, "openrouter", "z-ai/glm-5.2:free");
    expect(budget.contextWindow).toBe(256_000);
    expect(budget.maxOutputTokens).toBe(2_048);
    expect(budget.available).toBe(256_000 - 2_048 - 8_000);
  });

  it("margin stays 8 000 and available = window − maxOutputTokens − margin (the compaction line = the guard line = the donut's budget marker)", () => {
    const budget = resolveTurnBudget(db, "openrouter", "totally/unknown-r83");
    expect(budget.margin).toBe(8_000);
    expect(budget.available).toBe(budget.contextWindow - budget.maxOutputTokens - budget.margin);
  });

  it("getModelContextWindow stays the window-only view (compat: the tests + old callers pin it)", () => {
    upsertModel(db, "openrouter", { modelId: "test/r83-win", displayName: "W", contextWindow: 999_999 });
    expect(getModelContextWindow(db, "openrouter", "test/r83-win")).toBe(999_999);
    expect(getModelContextWindow(db, "openrouter", "totally/unknown-r83")).toBe(200_000);
  });
});
