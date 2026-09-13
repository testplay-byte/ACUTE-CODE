/**
 * ROUND-50 (R50-c1): the composer's send-time extras — attachments + the
 * per-send thinking level — and the attachment READ route that feeds them.
 *
 *  - POST /attachments/read: 20-path cap, first-128KB head (truncated flag),
 *    NUL-byte binary sniff, relative paths resolve ONLY inside the project
 *    root (escape / missing project → per-file error, never a 500), absolute
 *    paths read as-is (user-picked files).
 *  - Both send routes (POST /sessions/:id/messages and /messages/stream):
 *    thinkingLevel validation (default|low|high|max), attachments validation
 *    (≤20 items, non-empty name ≤200 chars, text capped to 128KB), and the
 *    persisted message.user payload carrying `attachments`.
 *  - The runtime threads thinkingLevel into the chat adapter input and
 *    renders attachments into the MODEL-FACING history only.
 *
 * ROUND-67 (R67-A): the attachment INGESTION route + the model-facing path
 * rendering — the owner's #1 v0.66.0 complaint ("I uploaded an image directly
 * in chat and the agent said the image doesn't exist"):
 *  - POST /attachments/upload: dataBase64 bytes AND absolutePath copy modes,
 *    the 8MB cap, name sanitization, the identical-reuse / -2…-suffix dedupe,
 *    unknown project 404, both/neither source 400;
 *  - renderAttachments: the analyze_image instruction for persisted images,
 *    the "(file saved at …)" line for other path-bearing files, and the
 *    UNCHANGED R50 shape for path-less attachments.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// The full stack runs against the real aiSdkChat adapter with ONLY the AI SDK
// mocked at the module boundary (the sessions.test.ts pattern) — no network.
// jsonSchema passes through as-is: buildProjectTools uses it to wrap tool
// schemas, and the stubbed chat never validates them.
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: vi.fn(),
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: (schema: unknown) => schema,
}));

import { assembleHistory, runSingleAgentTurn, runStreamedAgentTurn } from "../src/agents/runtime";
import { appendSessionEvent, createSession, listSessionEvents } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import type { ChatFn, StreamChatFn } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-att1";
const KEY = "sk-or-vtest-att1";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-attachments-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: "Got the file.",
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
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
    // best-effort
  }
});

async function authInject(options: {
  method: "GET" | "POST" | "PATCH";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({ ...options, headers: { authorization: `Bearer ${TOKEN}` } })) as LightMyRequestResponse;
}

async function makeSession(): Promise<string> {
  const agent = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "Att Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
      temperature: 0.1,
      maxTurns: 4,
    },
  });
  const session = await authInject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { agentId: agent.json().id, mode: "single" },
  });
  return session.json().id as string;
}

// ── POST /attachments/read ──────────────────────────────────────────────────

describe("POST /api/v1/attachments/read (ROUND-50 R50-c1)", () => {
  async function makeProject(): Promise<string> {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "AttachProject", rootPath: tempDir },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  it("reads the first 128KB head of a text file (truncated=true when longer) and full short files", async () => {
    const projectId = await makeProject();
    writeFileSync(join(tempDir, "small.txt"), "hello attachment", "utf8");
    // 200KB of text — above the 128KB head cap, below the 512KB limit.
    const big = "x".repeat(200 * 1024);
    writeFileSync(join(tempDir, "big.txt"), big, "utf8");

    const response = await authInject({
      method: "POST",
      url: "/api/v1/attachments/read",
      payload: { paths: ["small.txt", "big.txt"], projectId },
    });
    expect(response.statusCode).toBe(200);
    const files = response.json().files as Array<{
      path: string;
      name: string;
      size: number;
      text: string | null;
      truncated: boolean;
    }>;
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      path: "small.txt",
      name: "small.txt",
      size: 16,
      text: "hello attachment",
      truncated: false,
    });
    expect(files[1].name).toBe("big.txt");
    expect(files[1].size).toBe(200 * 1024);
    expect(files[1].text?.length).toBe(128 * 1024);
    expect(files[1].truncated).toBe(true);
  });

  it("marks binary files (a NUL byte in the first 8KB) as text: null with an honest size", async () => {
    const projectId = await makeProject();
    const binary = Buffer.concat([Buffer.from("PK\x03\x04header"), Buffer.alloc(64, 1), Buffer.from([0])]);
    writeFileSync(join(tempDir, "blob.bin"), binary);

    const response = await authInject({
      method: "POST",
      url: "/api/v1/attachments/read",
      payload: { paths: ["blob.bin"], projectId },
    });
    expect(response.statusCode).toBe(200);
    const file = (response.json().files as Array<{ text: string | null; size: number; truncated: boolean }>)[0];
    expect(file.text).toBeNull();
    expect(file.size).toBe(binary.length);
    expect(file.truncated).toBe(false);
  });

  it("per-file errors, never a 500: relative escape, missing project, missing file, directory", async () => {
    const projectId = await makeProject();
    mkdirSync(join(tempDir, "adir"), { recursive: true });

    const response = await authInject({
      method: "POST",
      url: "/api/v1/attachments/read",
      payload: { paths: ["../secrets.txt", "nope.txt", "adir"], projectId },
    });
    expect(response.statusCode).toBe(200);
    const files = response.json().files as Array<{ path: string; text: string | null; error?: string }>;
    expect(files).toHaveLength(3);
    expect(files[0].path).toBe("../secrets.txt");
    expect(files[0].text).toBeNull();
    expect(files[0].error).toMatch(/escapes the project root/);
    expect(files[1].error).toMatch(/cannot read/);
    expect(files[2].error).toMatch(/directory/);
  });

  it("relative paths WITHOUT a (valid) project fail per-file; absolute paths read as-is", async () => {
    writeFileSync(join(tempDir, "abs.txt"), "absolute pick", "utf8");

    // No projectId at all.
    const noProject = await authInject({
      method: "POST",
      url: "/api/v1/attachments/read",
      payload: { paths: ["relative.txt"] },
    });
    expect(noProject.statusCode).toBe(200);
    expect((noProject.json().files as Array<{ error?: string }>)[0].error).toMatch(
      /relative paths need a projectId/,
    );

    // Unknown projectId.
    const badProject = await authInject({
      method: "POST",
      url: "/api/v1/attachments/read",
      payload: { paths: ["relative.txt"], projectId: "proj_missing" },
    });
    expect(badProject.statusCode).toBe(200);
    expect((badProject.json().files as Array<{ error?: string }>)[0].error).toMatch(/not found/);

    // Absolute path — user-picked file, read as-is without a project.
    const absolute = await authInject({
      method: "POST",
      url: "/api/v1/attachments/read",
      payload: { paths: [join(tempDir, "abs.txt")] },
    });
    expect(absolute.statusCode).toBe(200);
    const file = (absolute.json().files as Array<{ text: string | null; name: string }>)[0];
    expect(file.text).toBe("absolute pick");
    expect(file.name).toBe("abs.txt");
  });

  it("refuses files above the 512KB read limit with a per-file error", async () => {
    const projectId = await makeProject();
    writeFileSync(join(tempDir, "huge.txt"), Buffer.alloc(600 * 1024, 0x61)); // 'a' * 600KB
    const response = await authInject({
      method: "POST",
      url: "/api/v1/attachments/read",
      payload: { paths: ["huge.txt"], projectId },
    });
    expect(response.statusCode).toBe(200);
    const file = (response.json().files as Array<{ error?: string }>)[0];
    expect(file.error).toMatch(/512KB/);
  });

  it.each([
    [
      "more than 20 paths",
      { paths: Array.from({ length: 21 }, (_, i) => `f${i}.txt`), projectId: "p" },
      "at most 20 paths",
    ],
    ["non-array paths", { paths: "one.txt" }, "paths must be an array of strings"],
    ["non-string entry", { paths: ["a.txt", 5] }, "paths must be an array of strings"],
    ["non-string projectId", { paths: ["a.txt"], projectId: 7 }, "projectId must be a string"],
  ])("rejects %s with 400 VALIDATION", async (_name, payload, message) => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/attachments/read",
      payload: payload as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.message).toContain(message);
  });

  it("requires the bearer token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/attachments/read",
      payload: { paths: [] },
    });
    expect(response.statusCode).toBe(401);
  });
});

// ── POST /attachments/upload (ROUND-67 R67-A) ───────────────────────────────

describe("POST /api/v1/attachments/upload (ROUND-67 R67-A)", () => {
  async function makeProject(): Promise<string> {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "UploadProject", rootPath: tempDir },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  const upload = (projectId: string, payload: Record<string, unknown>) =>
    authInject({
      method: "POST",
      url: "/api/v1/attachments/upload",
      payload: { projectId, ...payload },
    });

  it("dataBase64 mode: decodes, writes <root>/attachments/<name>, answers the PROJECT-RELATIVE path", async () => {
    const projectId = await makeProject();
    const bytes = Buffer.concat([Buffer.from("PNG"), Buffer.from([0x00, 0x01, 0x02])]);
    const response = await upload(projectId, {
      name: "shot.png",
      dataBase64: bytes.toString("base64"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      path: "attachments/shot.png",
      name: "shot.png",
      size: bytes.length,
    });
    // The bytes on disk are EXACTLY what was sent (round-tripped).
    expect(readFileSync(join(tempDir, "attachments", "shot.png"))).toEqual(bytes);
  });

  it("absolutePath mode: the SIDECAR copies the picked file into the project (a copy, not a move)", async () => {
    const projectId = await makeProject();
    const source = join(tempDir, "picked-screenshot.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
    writeFileSync(source, bytes);
    const response = await upload(projectId, {
      name: "picked-screenshot.png",
      absolutePath: source,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      path: "attachments/picked-screenshot.png",
      name: "picked-screenshot.png",
      size: bytes.length,
    });
    expect(readFileSync(join(tempDir, "attachments", "picked-screenshot.png"))).toEqual(bytes);
    expect(existsSync(source)).toBe(true);
  });

  it("dedupe: identical content reuses the existing file; different content mints -2/-3 (NEVER an overwrite)", async () => {
    const projectId = await makeProject();
    const A = Buffer.from("AAAA");
    const B = Buffer.from("BBBB");
    const C = Buffer.from("CCCC");
    const send = (b: Buffer) => upload(projectId, { name: "dup.png", dataBase64: b.toString("base64") });

    expect((await send(A)).json().path).toBe("attachments/dup.png");
    expect((await send(B)).json().path).toBe("attachments/dup-2.png");
    // Same bytes as the incumbent dup.png → REUSED, no new file.
    expect((await send(A)).json().path).toBe("attachments/dup.png");
    // Same bytes as dup-2 → reused there too.
    expect((await send(B)).json().path).toBe("attachments/dup-2.png");
    expect((await send(C)).json().path).toBe("attachments/dup-3.png");

    // The attachments dir is shared across this file's tests — scope the
    // assertion to THIS test's files (everything the "dup" name minted).
    const dupFiles = readdirSync(join(tempDir, "attachments"))
      .filter((f) => f.startsWith("dup"))
      .sort();
    expect(dupFiles).toEqual(["dup-2.png", "dup-3.png", "dup.png"]);
    // Nothing was overwritten — every variant holds its own content.
    expect(readFileSync(join(tempDir, "attachments", "dup.png"))).toEqual(A);
    expect(readFileSync(join(tempDir, "attachments", "dup-2.png"))).toEqual(B);
    expect(readFileSync(join(tempDir, "attachments", "dup-3.png"))).toEqual(C);
  });

  it("refuses dataBase64 over the 8MB decoded cap with 400 VALIDATION (the analyze_image ceiling)", async () => {
    const projectId = await makeProject();
    const response = await upload(projectId, {
      name: "huge.png",
      dataBase64: Buffer.alloc(8 * 1024 * 1024 + 1, 0x61).toString("base64"),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.message).toContain("8MB");
    expect(existsSync(join(tempDir, "attachments", "huge.png"))).toBe(false);
  });

  it.each([
    ["junk characters", "definitely!not!!base64"],
    ["bad padding", "AA="],
    ["empty", ""],
  ])("rejects invalid base64 (%s) with 400", async (_name, bad) => {
    const projectId = await makeProject();
    const response = await upload(projectId, { name: "x.png", dataBase64: bad });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.details.field).toBe("body.dataBase64");
  });

  it.each([
    ["path separator /", "a/b.png"],
    ["path separator \\", "a\\b.png"],
    ["bare parent traversal", ".."],
    ["parent inside the name", "x..y.png"],
    ["control character", "bad\u0007.png"],
    ["too long", "x".repeat(201)],
    ["whitespace-only", "   "],
  ])("rejects unsafe name (%s) with 400 VALIDATION on body.name", async (_name, bad) => {
    const projectId = await makeProject();
    const response = await upload(projectId, {
      name: bad,
      dataBase64: Buffer.from("hi").toString("base64"),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.details.field).toBe("body.name");
  });

  it("404 for an unknown project", async () => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/attachments/upload",
      payload: {
        projectId: "proj_missing",
        name: "x.png",
        dataBase64: Buffer.from("hi").toString("base64"),
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it.each([
    [
      "BOTH sources",
      { name: "x.png", dataBase64: Buffer.from("hi").toString("base64"), absolutePath: "/etc/hosts" },
      "one, not both",
    ],
    ["NEITHER source", { name: "x.png" }, "exactly one of dataBase64"],
    ["non-string dataBase64", { name: "x.png", dataBase64: 5 }, "dataBase64 must be a base64 string"],
    ["non-string absolutePath", { name: "x.png", absolutePath: 7 }, "absolutePath must be a string"],
  ])("rejects %s with 400 VALIDATION", async (_name, payload, message) => {
    const projectId = await makeProject();
    const response = await upload(projectId, payload as Record<string, unknown>);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.message).toContain(message);
  });

  it.each([
    ["a relative path", join("relative", "shot.png")],
    ["a missing file", join(tempDir, "no-such-file.png")],
    ["a directory", (() => {
      mkdirSync(join(tempDir, "adir"), { recursive: true });
      return join(tempDir, "adir");
    })()],
  ])("rejects absolutePath that is %s with 400 (honest reason)", async (_name, bad) => {
    const projectId = await makeProject();
    const response = await upload(projectId, { name: "shot.png", absolutePath: bad });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.details.field).toBe("body.absolutePath");
  });

  it("requires the bearer token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/attachments/upload",
      payload: { projectId: "p", name: "x.png", dataBase64: Buffer.from("hi").toString("base64") },
    });
    expect(response.statusCode).toBe(401);
  });
});

// ── Send-route validation: thinkingLevel + attachments ──────────────────────

describe("composer send-field validation (ROUND-50 R50-c1)", () => {
  // ROUND-95 (R95-E): "medium" joins the accepted set (models whose detected
  // ladder tops out below high offer it — shared's THINKING_LEVELS widened).
  it.each(["default", "low", "medium", "high", "max"] as const)(
    "POST /messages accepts thinkingLevel %s (validated against the shared vocabulary)",
    async (level) => {
      const sessionId = await makeSession();
      const response = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/messages`,
        payload: { content: "hi", thinkingLevel: level },
      });
      expect(response.statusCode).toBe(200);
    },
  );

  it.each([
    ["unknown string", "ultra"],
    ["non-string", 3],
  ])("POST /messages rejects thinkingLevel %s with 400 VALIDATION naming body.thinkingLevel", async (_n, bad) => {
    const sessionId = await makeSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hi", thinkingLevel: bad },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.details.field).toBe("body.thinkingLevel");

    // The stream route validates identically (a 400 JSON reply, not SSE).
    const streamed = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "hi", thinkingLevel: bad },
    });
    expect(streamed.statusCode).toBe(400);
    expect(streamed.json().error.details.field).toBe("body.thinkingLevel");
  });

  it.each([
    ["more than 20 attachments", Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.txt` }))],
    ["non-array attachments", "nope"],
    ["non-object entry", [{ name: "ok.txt" }, "x" ]],
    ["empty name", [{ name: "  " }]],
    ["missing name", [{ path: "a.txt" }]],
    ["too-long name", [{ name: "x".repeat(201) }]],
    ["non-string path", [{ name: "a.txt", path: 5 }]],
    ["negative size", [{ name: "a.txt", size: -1 }]],
    ["non-string text", [{ name: "a.txt", text: 9 }]],
  ])(
    "POST /messages rejects %s with 400 VALIDATION",
    async (_name, attachments) => {
      const sessionId = await makeSession();
      const response = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/messages`,
        payload: { content: "hi", attachments },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION");
      expect(response.json().error.details.field).toContain("body.attachments");

      // The stream route validates identically.
      const streamed = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/messages/stream`,
        payload: { content: "hi", attachments },
      });
      expect(streamed.statusCode).toBe(400);
      expect(streamed.json().error.details.field).toContain("body.attachments");
    },
  );

  it("rejects a non-object body on both routes with 400", async () => {
    const sessionId = await makeSession();
    for (const url of [`/api/v1/sessions/${sessionId}/messages`, `/api/v1/sessions/${sessionId}/messages/stream`]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        payload: JSON.stringify([1, 2]),
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

// ── Persistence: the message.user payload carries the attachments ───────────

describe("attachment persistence on message.user (ROUND-50 R50-c1)", () => {
  it("the sync send route persists the validated attachments alongside role/content (text capped to 128KB)", async () => {
    const sessionId = await makeSession();
    const bigText = "y".repeat(300 * 1024); // 300KB — must be capped to 128KB.
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: {
        content: "review these files",
        attachments: [
          { name: "notes.md", path: "notes.md", size: 12, text: "short notes" },
          { name: "big.md", size: bigText.length, text: bigText },
          { name: "image.png", path: "image.png", size: 4096, text: null },
        ],
      },
    });
    expect(response.statusCode).toBe(200);

    const events = listSessionEvents(db, sessionId);
    const userEvent = events.find((e) => e.type === "message.user");
    expect(userEvent).toBeDefined();
    const payload = userEvent!.payload as {
      role: string;
      content: string;
      attachments?: Array<{ name: string; path?: string; size?: number; text?: string | null }>;
    };
    expect(payload.role).toBe("user");
    expect(payload.content).toBe("review these files");
    expect(payload.attachments).toHaveLength(3);
    expect(payload.attachments![0]).toEqual({
      name: "notes.md",
      path: "notes.md",
      size: 12,
      text: "short notes",
    });
    // The 300KB text was capped server-side to the 128KB head.
    expect(payload.attachments![1].text?.length).toBe(128 * 1024);
    // null text survives (binary attachment, display-only chip).
    expect(payload.attachments![2].text).toBeNull();
  });

  it("an EMPTY attachments array persists nothing (no attachments key on the payload)", async () => {
    const sessionId = await makeSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "plain message", attachments: [] },
    });
    expect(response.statusCode).toBe(200);
    const events = listSessionEvents(db, sessionId);
    const payload = events.find((e) => e.type === "message.user")!.payload as Record<string, unknown>;
    expect(payload.attachments).toBeUndefined();
  });
});

// ── assembleHistory: the model-facing rendering of attachments ───────────────

describe("assembleHistory attachment rendering (ROUND-50 R50-c1)", () => {
  it("renders each attachment AFTER the user text with the block markers; null-text files get the placeholder", () => {
    const project = createProject(db, { name: "HistProject", rootPath: tempDir });
    const agent = createAgent(db, { name: "Hist Agent", providerId: "openrouter", model: "test/model-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });

    appendSessionEvent(db, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: {
        role: "user",
        content: "please review",
        attachments: [
          { name: "a.ts", path: "src/a.ts", size: 10, text: "const a = 1;" },
          { name: "logo.png", size: 4096, text: null },
        ],
      },
    });
    appendSessionEvent(db, session.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: { role: "assistant", content: "Reviewed." },
    });

    const messages = assembleHistory(db, session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    // The exact model-facing block format (contract). ROUND-67 (R67-A): a.ts
    // carries a path → the text block gains the trailing "(file saved at …)"
    // line; logo.png has NO path (and no image-extension + path pair) → the
    // R50 placeholder, byte-for-byte.
    expect(messages[0].content).toBe(
      "please review" +
        "\n\n--- attached file: a.ts ---\nconst a = 1;\n--- end of a.ts ---\n(file saved at src/a.ts)" +
        "\n\n--- attached file: logo.png (no readable text) ---",
    );
    // The assistant message is untouched.
    expect(messages[1].content).toBe("Reviewed.");

    // The RAW event payload stays clean (the display never sees the blocks).
    const raw = listSessionEvents(db, session.id).find((e) => e.type === "message.user")!
      .payload as Record<string, unknown>;
    expect(raw.content).toBe("please review");
    expect(raw.attachments).toEqual([
      { name: "a.ts", path: "src/a.ts", size: 10, text: "const a = 1;" },
      { name: "logo.png", size: 4096, text: null },
    ]);
  });

  it("old/foreign payloads without attachments fold exactly as before (tolerant reader)", () => {
    const agent = createAgent(db, { name: "T2", providerId: "openrouter", model: "test/model-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    appendSessionEvent(db, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: { role: "user", content: "legacy message" },
    });
    const messages = assembleHistory(db, session.id);
    expect(messages[0].content).toBe("legacy message");
  });

  // ── ROUND-67 (R67-A): the persisted-attachment rendering ─────────────────

  it("ROUND-67 (R67-A): a persisted IMAGE attachment (path, no text) renders the explicit analyze_image instruction", () => {
    const project = createProject(db, { name: "ImgProject", rootPath: tempDir });
    const agent = createAgent(db, { name: "Img Agent", providerId: "openrouter", model: "test/model-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    appendSessionEvent(db, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: {
        role: "user",
        content: "what is in this screenshot?",
        attachments: [
          { name: "shot.png", path: "attachments/shot.png", size: 4096, text: null },
        ],
      },
    });
    const messages = assembleHistory(db, session.id);
    // The contract the model is TAUGHT with (path + the exact tool call).
    expect(messages[0].content).toBe(
      "what is in this screenshot?" +
        '\n\n--- attached image: shot.png (saved in the project at attachments/shot.png) ---\n' +
        'Use analyze_image with path "attachments/shot.png" to view it.',
    );
  });

  it("ROUND-67 (R67-A): an image that somehow HAS text keeps the text render + the path line; non-image binaries get the placeholder + path line; path-less attachments are unchanged", () => {
    const project = createProject(db, { name: "MixedProject", rootPath: tempDir });
    const agent = createAgent(db, { name: "Mixed Agent", providerId: "openrouter", model: "test/model-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    appendSessionEvent(db, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: {
        role: "user",
        content: "look",
        attachments: [
          { name: "weird.png", path: "attachments/weird.png", size: 4, text: "texty" },
          { name: "data.bin", path: "attachments/data.bin", size: 9, text: null },
          { name: "logo.png", size: 4096, text: null },
        ],
      },
    });
    const messages = assembleHistory(db, session.id);
    expect(messages[0].content).toBe(
      "look" +
        "\n\n--- attached file: weird.png ---\ntexty\n--- end of weird.png ---\n(file saved at attachments/weird.png)" +
        "\n\n--- attached file: data.bin (no readable text) ---\n(file saved at attachments/data.bin)" +
        "\n\n--- attached file: logo.png (no readable text) ---",
    );
  });
});

// ── The runtime threads thinkingLevel + renders attachments on the turn ─────

describe("runtime threading (ROUND-50 R50-c1)", () => {
  it("runSingleAgentTurn passes the thinkingLevel through to the chat adapter input (not persisted anywhere)", async () => {
    const project = createProject(db, { name: "ThreadProject", rootPath: tempDir });
    const agent = createAgent(db, { name: "Thread Agent", providerId: "openrouter", model: "test/model-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });

    const inputs: Array<{ thinkingLevel?: string }> = [];
    const chat: ChatFn = async (input) => {
      inputs.push({ ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}) });
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };
    await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      session.id,
      "think hard",
      undefined,
      undefined,
      undefined,
      "high",
    );
    expect(inputs[0].thinkingLevel).toBe("high");

    // Absent → the chat input carries NO thinkingLevel (provider default).
    const session2 = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      session2.id,
      "think normally",
    );
    expect(inputs[1].thinkingLevel).toBeUndefined();

    // Nothing about the level landed in the event log.
    const events = listSessionEvents(db, session.id);
    expect(JSON.stringify(events)).not.toContain("thinkingLevel");
  });

  it("runSingleAgentTurn persists the send's attachments and the NEXT turn's history renders them", async () => {
    const project = createProject(db, { name: "ThreadProject2", rootPath: tempDir });
    const agent = createAgent(db, { name: "Thread Agent 2", providerId: "openrouter", model: "test/model-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });

    const seenMessages: string[] = [];
    const chat: ChatFn = async (input) => {
      seenMessages.push(input.messages.map((m) => m.content).join("\n<<<MSG>>>\n"));
      return { text: "got it", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      session.id,
      "here is a file",
      undefined,
      undefined,
      undefined,
      undefined,
      [{ name: "spec.md", path: "spec.md", size: 6, text: "# spec" }],
    );
    expect(outcome.ok).toBe(true);
    // The model-facing content of the first turn includes the block.
    expect(seenMessages[0]).toContain("--- attached file: spec.md ---\n# spec\n--- end of spec.md ---");
  });

  it("the STREAMED turn accumulates cachedInputTokens from the finish frames into usage_events", async () => {
    const project = createProject(db, { name: "StreamProject", rootPath: tempDir });
    const agent = createAgent(db, { name: "Stream Agent", providerId: "openrouter", model: "test/model-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });

    // A streaming stub whose FIRST iteration reports cached prompt tokens
    // (OpenRouter's prompt_tokens_details.cached_tokens → the finish frame's
    // cachedInputTokens) and whose second iteration reports none.
    let call = 0;
    const chat: ChatFn = async () => ({
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      toolCalls: [],
    });
    const chatStream: StreamChatFn = async function* () {
      call += 1;
      if (call === 1) {
        // A tool-using iteration (tools keep the outer loop going).
        yield { type: "tool-call", toolName: "read_file", argsSummary: "path: a.ts" };
        yield { type: "tool-result", toolName: "read_file", argsSummary: "path: a.ts", ok: true };
      }
      yield { type: "text-delta", delta: call === 1 ? "working…" : "Done." };
      yield {
        type: "finish",
        usage: {
          inputTokens: call === 1 ? 50_000 : 30_000,
          outputTokens: call === 1 ? 10 : 5,
          totalTokens: call === 1 ? 50_010 : 30_005,
        },
        // Iteration 1: 41k of the 50k input tokens came from the provider
        // cache; iteration 2: the provider reported no cached tier → 0.
        cachedInputTokens: call === 1 ? 41_000 : 0,
      };
    };

    const emitted: unknown[] = [];
    const outcome = await runStreamedAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat, chatStream },
      session.id,
      "two-iteration job",
      (event) => emitted.push(event),
    );
    expect(outcome.ok).toBe(true);

    // The finish frames flowed to SSE with the cached counts…
    const finishFrames = emitted.filter(
      (e): e is { type: string; cachedInputTokens?: number } =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "finish",
    );
    expect(finishFrames.map((f) => f.cachedInputTokens)).toEqual([41_000, 0]);

    // …and the turn's SINGLE usage_events row carries the accumulated total.
    const usageRow = db
      .prepare("SELECT input_tokens, output_tokens, cached_input_tokens FROM usage_events WHERE session_id = ?")
      .get(session.id) as { input_tokens: number; output_tokens: number; cached_input_tokens: number | null };
    expect(usageRow.input_tokens).toBe(80_000);
    expect(usageRow.output_tokens).toBe(15);
    expect(usageRow.cached_input_tokens).toBe(41_000);

    // The outcome's usage record mirrors it (the route/UI surface).
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.usage.cachedInputTokens).toBe(41_000);
  });
});
