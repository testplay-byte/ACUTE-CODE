/**
 * ROUND-98 (R98-E1): the PROMPT-CUSTOMIZATION surface — the owner: "add
 * prompt customizability… customizing them better in the settings, getting
 * a proper visual experience". The override ENGINE existed since R59-F
 * (`.acute/prompts/<section-id>.md`: replace wholesale, empty = drop,
 * `_order.txt` reorder, 8K cap, diagnostics — pinned by prompts-overrides +
 * prompt-registry); this round shipped the STORAGE writer + the ROUTES the
 * Settings Prompts tab drives.
 *
 * Pins in this file:
 *   1. STORAGE (storage/prompt-overrides.ts) — the write/read/delete
 *      round-trip lands real files the ENGINE honors (compose changes),
 *      the unknown-id and over-cap THROWS, the empty write = drop
 *      semantics, delete = revert (byte-identical to the un-overridden
 *      composition).
 *   2. ROUTES (routes/prompts.ts) — GET /prompts/sections lists the
 *      registry with override status + overrideContent + defaultText; PUT
 *      writes + validates (cap 400, unknown id 400, unregistered
 *      projectRoot 404 — the write-side guard); DELETE reverts; the empty
 *      PUT = drop (the next GET reports the section absent); GET
 *      /prompts/preview returns the effective section texts with the
 *      override applied; the 401 bearer wall.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";
import { ProviderKeyring } from "../src/providers/registry";
import { buildServer } from "../src/server";
import {
  deletePromptOverride,
  readPromptOverride,
  writePromptOverride,
} from "../src/storage/prompt-overrides";
import { loadPromptOverrides, PROMPT_OVERRIDE_CHAR_CAP } from "../src/agents/prompt-registry";
import { buildProjectSystemPrompt, type PromptContext } from "../src/agents/prompts";
import { TOOL_NAMES } from "../src/storage/agents";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;
let projectRoot: string;

const TOKEN = "test-token-r98e1";
const KEY = "sk-or-vtest-r98e1";

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r98e1-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  projectRoot = mkdtempSync(join(tempDir, `proj-${randomUUID().slice(0, 8)}`));
  createProject(db, { name: "R98E1 Project", rootPath: projectRoot });
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function authInject(options: {
  method: "GET" | "PUT" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** A hermetic ctx bound to the test project (overrides load from its root). */
function ctxFor(root: string): PromptContext {
  return {
    projectName: "R98E1Project",
    rootPath: root,
    toolNames: [...TOOL_NAMES],
    customRules: undefined,
  };
}

/* ── 1. storage ───────────────────────────────────────────────────────────── */

describe("R98-E1: storage/prompt-overrides.ts (the writer)", () => {
  it("write → the ENGINE honors it: loadPromptOverrides maps the file, the compose replaces the section", () => {
    const result = writePromptOverride(projectRoot, "communication", "## COMMUNICATION (custom)\nR98E1-MARKER\nBe terse.");
    expect(result.dropped).toBe(false);
    expect(result.file).toBe(join(projectRoot, ".acute", "prompts", "communication.md"));

    const loaded = loadPromptOverrides(projectRoot);
    expect(loaded.overrides.get("communication")).toBe("## COMMUNICATION (custom)\nR98E1-MARKER\nBe terse.");
    expect(loaded.diagnostics).toEqual([]);

    const prompt = buildProjectSystemPrompt(ctxFor(projectRoot));
    expect(prompt).toContain("R98E1-MARKER");
    expect(prompt).not.toContain("- **Concise by default:**"); // the built-in body is GONE
  });

  it("readPromptOverride returns the RAW file text (null when absent) — the engine trims at load", () => {
    expect(readPromptOverride(projectRoot, "communication")).toBeNull();
    writePromptOverride(projectRoot, "communication", "  \npadded text\n\n");
    expect(readPromptOverride(projectRoot, "communication")).toBe("  \npadded text\n\n");
    // ...while the engine sees the TRIMMED value.
    expect(loadPromptOverrides(projectRoot).overrides.get("communication")).toBe("padded text");
  });

  it("an UNKNOWN section id THROWS the honest message (the registry is the only vocabulary)", () => {
    expect(() => writePromptOverride(projectRoot, "efficiency", "retired id")).toThrow(
      /unknown section id "efficiency"/,
    );
    expect(() => writePromptOverride(projectRoot, "not-a-section", "x")).toThrow(/unknown section id/);
  });

  it("content over the 8,000-char cap THROWS (refused up front — the loader would truncate + diagnose every turn)", () => {
    expect(() => writePromptOverride(projectRoot, "communication", "X".repeat(PROMPT_OVERRIDE_CHAR_CAP + 1))).toThrow(
      /the cap is 8,000/i,
    );
    // Exactly AT the cap is fine.
    expect(() => writePromptOverride(projectRoot, "communication", "X".repeat(PROMPT_OVERRIDE_CHAR_CAP))).not.toThrow();
  });

  it("an EMPTY write = DROP semantics (dropped:true, the section leaves the composition)", () => {
    const before = buildProjectSystemPrompt(ctxFor(projectRoot));
    expect(before).toContain("## COMMUNICATION");

    const result = writePromptOverride(projectRoot, "communication", "");
    expect(result.dropped).toBe(true);

    const dropped = buildProjectSystemPrompt(ctxFor(projectRoot));
    expect(dropped).not.toContain("## COMMUNICATION");
    expect(dropped).not.toMatch(/\n\n\n/); // no blank-line pileup where it sat
  });

  it("delete = REVERT: the composition returns byte-identical to the un-overridden project", () => {
    const pristine = buildProjectSystemPrompt(ctxFor(projectRoot));
    writePromptOverride(projectRoot, "communication", "R98E1-TEMPORARY");
    expect(buildProjectSystemPrompt(ctxFor(projectRoot))).not.toBe(pristine);

    const removed = deletePromptOverride(projectRoot, "communication");
    expect(removed.ok).toBe(true);
    expect(removed.existed).toBe(true);
    expect(buildProjectSystemPrompt(ctxFor(projectRoot))).toBe(pristine);

    // Idempotent revert: an absent file is a successful no-op.
    const again = deletePromptOverride(projectRoot, "communication");
    expect(again.ok).toBe(true);
    expect(again.existed).toBe(false);
  });
});

/* ── 2. routes ────────────────────────────────────────────────────────────── */

describe("R98-E1: GET /prompts/sections", () => {
  it("lists the registry sections with override status, overrideContent, and defaultText", async () => {
    writePromptOverride(projectRoot, "communication", "## COMMUNICATION (custom)\nR98E1-ROUTE-MARKER");
    const res = await authInject({ method: "GET", url: `/api/v1/prompts/sections?projectRoot=${encodeURIComponent(projectRoot)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rootPath: string;
      sections: Array<{
        id: string;
        description: string;
        dynamic: boolean;
        bucket: string;
        present: boolean;
        overridden: boolean;
        overrideContent: string | null;
        defaultText: string | null;
      }>;
      overridden: string[];
      effectiveOrder: string[];
      diagnostics: string[];
    };
    expect(body.rootPath).toBe(projectRoot);
    expect(body.overridden).toEqual(["communication"]);

    const comm = body.sections.find((s) => s.id === "communication");
    expect(comm?.overridden).toBe(true);
    expect(comm?.present).toBe(true);
    expect(comm?.dynamic).toBe(false);
    expect(comm?.bucket).toBe("identity");
    expect(comm?.overrideContent).toBe("## COMMUNICATION (custom)\nR98E1-ROUTE-MARKER");
    // The DEFAULT reference is the built-in composition (what revert restores).
    expect(comm?.defaultText).toContain("- **Concise by default:**");
    expect(comm?.defaultText).not.toContain("R98E1-ROUTE-MARKER");

    // An unpinned section: no override content, a real default.
    const env = body.sections.find((s) => s.id === "environment");
    expect(env?.overridden).toBe(false);
    expect(env?.overrideContent).toBeNull();
    expect(env?.defaultText).toContain("## ENVIRONMENT");

    // The registry picture is complete (every registry id appears).
    expect(body.sections.length).toBeGreaterThanOrEqual(30);
    expect(body.sections.map((s) => s.id)).toContain("always-on-skills");
    expect(body.diagnostics).toEqual([]);
  });

  it("404 for an UNREGISTERED project root (the write-side guard), 400 when projectRoot is missing", async () => {
    const unknown = await authInject({
      method: "GET",
      url: `/api/v1/prompts/sections?projectRoot=${encodeURIComponent(join(tempDir, "not-registered"))}`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(((unknown.json() as { error: { message: string } }).error.message)).toContain("no registered project");

    const missing = await authInject({ method: "GET", url: "/api/v1/prompts/sections" });
    expect(missing.statusCode).toBe(400);
  });
});

describe("R98-E1: PUT /prompts/sections/:id", () => {
  it("writes the override file and reports the honest outcome", async () => {
    const res = await authInject({
      method: "PUT",
      url: "/api/v1/prompts/sections/communication",
      payload: { projectRoot, content: "## COMMUNICATION (custom)\nR98E1-PUT-MARKER" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; id: string; file: string; dropped: boolean; content: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("communication");
    expect(body.dropped).toBe(false);
    expect(body.file).toBe(join(projectRoot, ".acute", "prompts", "communication.md"));
    // The engine honors it immediately.
    expect(buildProjectSystemPrompt(ctxFor(projectRoot))).toContain("R98E1-PUT-MARKER");
  });

  it("an empty content PUT = DROP (dropped:true; the next GET reports the section ABSENT)", async () => {
    const res = await authInject({
      method: "PUT",
      url: "/api/v1/prompts/sections/communication",
      payload: { projectRoot, content: "" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { dropped: boolean }).dropped).toBe(true);

    const sections = await authInject({
      method: "GET",
      url: `/api/v1/prompts/sections?projectRoot=${encodeURIComponent(projectRoot)}`,
    });
    const comm = ((sections.json() as { sections: Array<{ id: string; present: boolean; overridden: boolean }> })
      .sections).find((s) => s.id === "communication");
    expect(comm?.present).toBe(false); // dropped, honestly reported
    expect(comm?.overridden).toBe(true);
  });

  it("400 for an unknown section id, the cap breach, and a non-string content; 404 for an unregistered root", async () => {
    const unknown = await authInject({
      method: "PUT",
      url: "/api/v1/prompts/sections/efficiency",
      payload: { projectRoot, content: "retired id" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(((unknown.json() as { error: { message: string } }).error.message)).toContain(
      'unknown section id "efficiency"',
    );

    const capped = await authInject({
      method: "PUT",
      url: "/api/v1/prompts/sections/communication",
      payload: { projectRoot, content: "Y".repeat(PROMPT_OVERRIDE_CHAR_CAP + 10) },
    });
    expect(capped.statusCode).toBe(400);
    expect(((capped.json() as { error: { message: string } }).error.message)).toContain("the cap is 8,000");

    const notString = await authInject({
      method: "PUT",
      url: "/api/v1/prompts/sections/communication",
      payload: { projectRoot, content: 42 },
    });
    expect(notString.statusCode).toBe(400);

    const unregistered = await authInject({
      method: "PUT",
      url: "/api/v1/prompts/sections/communication",
      payload: { projectRoot: join(tempDir, "nope"), content: "x" },
    });
    expect(unregistered.statusCode).toBe(404);
  });
});

describe("R98-E1: DELETE /prompts/sections/:id", () => {
  it("reverts the section to its built-in composition (the file is gone, the compose is pristine)", async () => {
    writePromptOverride(projectRoot, "communication", "R98E1-DELETE-MARKER");
    const pristineBefore = buildProjectSystemPrompt(ctxFor(projectRoot));

    const res = await authInject({
      method: "DELETE",
      url: `/api/v1/prompts/sections/communication?projectRoot=${encodeURIComponent(projectRoot)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: "communication", reverted: true, existed: true });
    expect(readPromptOverride(projectRoot, "communication")).toBeNull();
    expect(buildProjectSystemPrompt(ctxFor(projectRoot))).not.toBe(pristineBefore); // marker gone
    expect(buildProjectSystemPrompt(ctxFor(projectRoot))).not.toContain("R98E1-DELETE-MARKER");
    expect(buildProjectSystemPrompt(ctxFor(projectRoot))).toContain("- **Concise by default:**");
  });

  it("404 for an unregistered root; 400 when projectRoot is missing", async () => {
    const unknown = await authInject({
      method: "DELETE",
      url: `/api/v1/prompts/sections/communication?projectRoot=${encodeURIComponent(join(tempDir, "nope"))}`,
    });
    expect(unknown.statusCode).toBe(404);
    const missing = await authInject({ method: "DELETE", url: "/api/v1/prompts/sections/communication" });
    expect(missing.statusCode).toBe(400);
  });
});

describe("R98-E1: GET /prompts/preview", () => {
  it("returns the EFFECTIVE section texts (override applied) in effective order, overridden flagged", async () => {
    writePromptOverride(projectRoot, "communication", "## COMMUNICATION (custom)\nR98E1-PREVIEW-MARKER");
    const res = await authInject({
      method: "GET",
      url: `/api/v1/prompts/preview?projectRoot=${encodeURIComponent(projectRoot)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rootPath: string;
      registryOrder: string[];
      effectiveOrder: string[];
      totalChars: number;
      sections: Array<{ id: string; overridden: boolean; text: string }>;
      diagnostics: string[];
    };
    expect(body.rootPath).toBe(projectRoot);
    expect(body.registryOrder).toContain("communication");
    expect(body.effectiveOrder).toContain("communication");

    const comm = body.sections.find((s) => s.id === "communication");
    expect(comm?.overridden).toBe(true);
    expect(comm?.text).toContain("R98E1-PREVIEW-MARKER");
    expect(comm?.text).not.toContain("Concise by default");

    const env = body.sections.find((s) => s.id === "environment");
    expect(env?.overridden).toBe(false);
    expect(env?.text).toContain("## ENVIRONMENT");

    // The counts are honest (the total is the sum of the served texts).
    expect(body.totalChars).toBe(body.sections.reduce((sum, s) => sum + s.text.length, 0));
    expect(body.totalChars).toBeGreaterThan(10_000);
  });

  it("404 for an unregistered root", async () => {
    const res = await authInject({
      method: "GET",
      url: `/api/v1/prompts/preview?projectRoot=${encodeURIComponent(join(tempDir, "nope"))}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("R98-E1: the bearer wall", () => {
  it("every route 401s without the token (ARCHITECTURE §2.3 — no exceptions for the new domain)", async () => {
    for (const [method, url] of [
      ["GET", `/api/v1/prompts/sections?projectRoot=${encodeURIComponent(projectRoot)}`],
      ["GET", `/api/v1/prompts/preview?projectRoot=${encodeURIComponent(projectRoot)}`],
      ["PUT", "/api/v1/prompts/sections/communication"],
      ["DELETE", `/api/v1/prompts/sections/communication?projectRoot=${encodeURIComponent(projectRoot)}`],
    ] as const) {
      const res = await app.inject({ method, url, ...(method === "PUT" ? { payload: { projectRoot, content: "x" } } : {}) });
      expect(res.statusCode).toBe(401);
      expect(((res.json() as { error: { code: string } }).error.code)).toBe("UNAUTHORIZED");
    }
  });
});
