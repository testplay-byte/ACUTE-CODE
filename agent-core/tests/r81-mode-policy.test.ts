/**
 * ROUND-81 (R81, ADR-0029) regression tests — the UNIFIED OPERATING MODES.
 *
 * The owner's one-picker redesign folded the six-builtin task-mode picker
 * (R73/R75) and the four-value permission switcher (R50-c1) into exactly
 * THREE operating modes (full / ask / plan). This suite pins the NEW shape:
 *
 *  · Pure policy: PLAN_MODE_TOOLS is now the EXTENDED read-only list (the
 *    retired review/explore READ_ONLY_EXTRAS — the git inspectors,
 *    analyze_image, job_status — folded in after switch_mode); every name
 *    is real TOOL_NAMES vocabulary. The R75 policy exports
 *    (TASK_MODE_TOOL_POLICY, TASK_MODE_READ_ONLY,
 *    narrowAllowListByTaskModePolicy, isReadOnlyTaskMode) are RETIRED —
 *    the module's surface is the one list.
 *  · The operating-mode intersection (runtime sessionToolAllowList): plan
 *    narrows (never widens; empty product → the NO_TOOLS sentinel), full/
 *    ask pass the agent allowlist through untouched (ask gates at the
 *    approval tier, not the toolset).
 *  · Turn integration: a PLAN session's toolset AND the prompt's toolNames
 *    both reflect the read-only list exactly (dark-tools honesty); a
 *    session with a read-only/working POSTURE active under full permission
 *    gets the FULL toolset (postures are guidance, not enforcement — the
 *    R75 task-mode policy tier, retired).
 *  · The debug command tier (R75) is RETIRED: an ask-tier command under
 *    activeMode 'debug' + ASK permission creates the approval and waits
 *    (not the R75 debug refusal); a non-interactive context gets the
 *    honest not-interactive refusal; FULL auto-approves.
 *  · switch_mode freely switches out of ANY posture (the R75 owner-pin is
 *    gone — postures are non-enforcing self-selection; the OPERATING mode
 *    is the owner's picker alone, which no tool can touch).
 *  · Delegation inheritance: a child session copies the parent's activeMode
 *    (unchanged by R81 — the posture pointer rides the row).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import { modeAllowList, runSingleAgentTurn, sessionToolAllowList } from "../src/agents/runtime";
import { PLAN_MODE_TOOLS } from "../src/agents/mode-policy";
import { requestCommandApproval, resolvePendingApproval } from "../src/approvals";
import { modesPlugin } from "../src/tools/plugins/modes";
import type { ToolDeps } from "../src/tools/index";
import { getOrchestrator } from "../src/agents/orchestrator";
import { aiSdkChat } from "../src/agents/chat";
import { TOOL_NAMES, createAgent } from "../src/storage/agents";
import { NO_TOOLS } from "../src/tools/index";
import { createProject } from "../src/storage/projects";
import { appendSessionEvent, createSession, getSession, updateSessionActiveMode } from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-r81-modepolicy";
let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r81-mp-"));
  db?.close();
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  generateTextMock.mockReset();
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/* ── Pure policy ───────────────────────────────────────────────────────────── */

describe("R81: PLAN_MODE_TOOLS — the unified read-only vocabulary", () => {
  it("the extended list: the R50 plan set + the retired review/explore read-only extras, exact", () => {
    // The one read-only tier now carries the FULL read-only vocabulary:
    // the old PLAN_MODE_TOOLS (research/navigation/web/todos/memory/
    // delegation + read_skill + switch_mode) PLUS the R75 READ_ONLY_EXTRAS
    // folded in after switch_mode (git inspectors, analyze_image,
    // job_status) — there is no separate review/explore superset anymore.
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
        // ROUND-70 (R70-b): reading a skill is an observation (the SKILLS
        // prompt section is advertised in plan mode — the loader must not
        // be dark there).
        "read_skill",
        // ROUND-73/ROUND-81: posture management is an observation-level
        // session-state change — the agent in PLAN mode still picks its
        // posture discipline (the D4 honesty rule).
        "switch_mode",
        // ROUND-87 (R87): asking the owner questions is the planning tool
        // par excellence — pure clarification, no side effects.
        "ask_user",
        // ROUND-81: the retired review/explore extras — a reviewer reads
        // history, analyze_image reads screenshots, job_status watches a
        // running build.
        "git_status",
        "git_diff",
        "git_log",
        "analyze_image",
        "job_status",
      ].sort(),
    );
  });

  it("every name is real registry vocabulary (no invented tools)", () => {
    for (const tool of PLAN_MODE_TOOLS) expect(TOOL_NAMES).toContain(tool);
  });

  it("the mutating tools are all absent — and job_stop deliberately stays out (killing a process is a side effect)", () => {
    for (const tool of ["write_file", "edit_file", "create_dir", "delete_file", "run_command", "index_project", "job_stop"]) {
      expect(PLAN_MODE_TOOLS).not.toContain(tool);
    }
    // The escape hatch is present (the dark-tools honesty rule): a PLAN
    // agent can always manage its POSTURE pointer.
    expect(PLAN_MODE_TOOLS).toContain("switch_mode");
  });

  it("the R75 policy exports are RETIRED — the module's surface is the one list", async () => {
    // R75 exported TASK_MODE_TOOL_POLICY / TASK_MODE_READ_ONLY /
    // isReadOnlyTaskMode / narrowAllowListByTaskModePolicy; a static
    // import of any of them no longer compiles (restructured away above).
    // The honest runtime pin: the module namespace exports ONLY the list.
    const mod = await import("../src/agents/mode-policy");
    expect(Object.keys(mod).sort()).toEqual(["PLAN_MODE_TOOLS"]);
  });
});

/* ── The operating-mode intersection (runtime) ─────────────────────────────── */

describe("R81: sessionToolAllowList (the operating-mode intersection semantics)", () => {
  it("modeAllowList: plan → PLAN_MODE_TOOLS; full/ask → undefined (no restriction — ask gates at the approval tier)", () => {
    expect(modeAllowList("plan")).toEqual(PLAN_MODE_TOOLS);
    expect(modeAllowList("full")).toBeUndefined();
    expect(modeAllowList("ask")).toBeUndefined();
  });

  it("plan INTERSECTS the agent's own allowlist — a mode never widens it", () => {
    const session = { id: "s", parentSessionId: null, permissionMode: "plan" as const };
    // Agent restricted to research tools → plan keeps exactly the overlap.
    const researcher = { allowedTools: ["read_file", "web_search", "run_command"] };
    expect(sessionToolAllowList(session, researcher)).toEqual(["read_file", "web_search"]);
  });

  it("an ALL (empty) agent allowlist ∩ plan = the plan set itself", () => {
    const session = { id: "s", parentSessionId: null, permissionMode: "plan" as const };
    expect([...(sessionToolAllowList(session, { allowedTools: [] }) ?? [])].sort()).toEqual(
      [...PLAN_MODE_TOOLS].sort(),
    );
  });

  it("an empty intersection → the NO_TOOLS sentinel (never [] = ALL)", () => {
    const session = { id: "s", parentSessionId: null, permissionMode: "plan" as const };
    // Agent restricted to ONLY write tools in plan mode → empty product
    // becomes the NO_TOOLS sentinel (an empty array would mean "ALL").
    expect(sessionToolAllowList(session, { allowedTools: ["write_file", "edit_file"] })).toBe(NO_TOOLS);
  });

  it("full/ask pass the agent allowlist through UNTOUCHED (the toolset gate is plan-only)", () => {
    const researcher = { allowedTools: ["read_file", "web_search", "run_command"] };
    const full = { id: "s", parentSessionId: null, permissionMode: "full" as const };
    expect(sessionToolAllowList(full, researcher)).toBe(researcher.allowedTools);
    const ask = { id: "s", parentSessionId: null, permissionMode: "ask" as const };
    expect(sessionToolAllowList(ask, researcher)).toBe(researcher.allowedTools);
  });
});

/* ── Turn integration: the toolset + prompt honesty ───────────────────────── */

describe("R81: turn integration (prepareTurn)", () => {
  function newSession(opts: { permissionMode?: "full" | "ask" | "plan"; activeMode?: string } = {}): string {
    const root = mkdtempSync(join(tempDir, "proj-"));
    const project = createProject(db, { name: `R81MP-${randomUUID().slice(0, 8)}`, rootPath: root });
    const agent = createAgent(db, {
      name: "R81 MP Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/r81-mp",
    });
    const session = createSession(db, {
      agentId: agent.id,
      mode: "single",
      projectId: project.id,
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.activeMode !== undefined ? { activeMode: opts.activeMode } : {}),
    });
    return session.id;
  }

  async function captureToolsetAndPrompt(sessionId: string, message: string): Promise<{ toolNames: string[]; system: string }> {
    const toolNames: string[][] = [];
    const systems: string[] = [];
    generateTextMock.mockImplementation(async (input: { system?: unknown; tools?: unknown }) => {
      toolNames.push(input.tools !== undefined ? Object.keys(input.tools as object) : []);
      systems.push(typeof input.system === "string" ? input.system : (input.system as unknown as { text?: string })?.text ?? "");
      return {
        text: "done.",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });
    const outcome = await runSingleAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: aiSdkChat,
      },
      sessionId,
      message,
    );
    expect(outcome.ok).toBe(true);
    return { toolNames: toolNames[0] ?? [], system: systems[0] ?? "" };
  }

  it("a PLAN (operating-mode) session gets the read-only toolset — and the prompt's toolNames match exactly", async () => {
    const sessionId = newSession({ permissionMode: "plan" });
    const { toolNames, system } = await captureToolsetAndPrompt(sessionId, "plan this feature");

    expect(toolNames.sort()).toEqual([...PLAN_MODE_TOOLS].sort());
    for (const tool of ["write_file", "edit_file", "create_dir", "delete_file", "run_command", "index_project", "job_stop"]) {
      expect(toolNames).not.toContain(tool);
    }
    // Dark-tools honesty: the prompt never names a tool the model cannot
    // call — the toolNames line lists exactly the plan vocabulary.
    const toolsLine = system.match(/You have access to these tools: ([^\n]+)\./)?.[1] ?? "";
    for (const name of PLAN_MODE_TOOLS) expect(toolsLine).toContain(name);
    expect(toolsLine).not.toContain("write_file");
    expect(toolsLine).not.toContain("run_command");
    // The operating mode narrates honestly (the R81 section heading + text).
    expect(system).toContain("## OPERATING MODE");
    expect(system).toContain("You are in PLAN mode: read-only");
  });

  it("a read-only POSTURE (review) under FULL permission gets the FULL toolset — postures do not narrow (the R75 tier, retired)", async () => {
    const sessionId = newSession({ permissionMode: "full", activeMode: "review" });
    const { toolNames, system } = await captureToolsetAndPrompt(sessionId, "review this diff");

    expect(toolNames.sort()).toEqual([...TOOL_NAMES].sort());
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("run_command");
    // git_diff is present as FULL vocabulary now — not a special superset.
    expect(toolNames).toContain("git_diff");
    // The posture rides as GUIDANCE: the R81 heading + the discipline prose
    // (the ENFORCED/owner-pin paragraphs are gone).
    expect(system).toContain("## ACTIVE POSTURE — Review (review)");
    expect(system).toContain("Discipline, not permission:");
    expect(system).not.toContain("ENFORCED, not advisory");
  });

  it("an EXPLORE posture under full permission: FULL toolset (the same inversion)", async () => {
    const sessionId = newSession({ permissionMode: "full", activeMode: "explore" });
    const { toolNames } = await captureToolsetAndPrompt(sessionId, "explore the codebase");

    expect(toolNames.sort()).toEqual([...TOOL_NAMES].sort());
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("run_command");
  });

  it("a PLAN posture under full permission: FULL toolset — even plan's iron law is discipline, not permission now", async () => {
    // The strongest R75→R81 inversion: under R75 an active 'plan' task mode
    // narrowed the toolset regardless of the permission mode; now the ONLY
    // read-only gate is the operating mode, which the OWNER sets (migration
    // 0029 rewrote historical read-only-posture rows to permission 'plan'
    // so nothing the owner had is silently widened).
    const sessionId = newSession({ permissionMode: "full", activeMode: "plan" });
    const { toolNames, system } = await captureToolsetAndPrompt(sessionId, "plan the feature");

    expect(toolNames.sort()).toEqual([...TOOL_NAMES].sort());
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("run_command");
    // The posture body still carries the read-only DISCIPLINE in prose.
    expect(system).toContain("## ACTIVE POSTURE — Plan (plan)");
    expect(system).toContain("Discipline, not permission:");
  });

  it("a DEBUG posture under full permission KEEPS the full mutating toolset (the fix needs it)", async () => {
    const sessionId = newSession({ permissionMode: "full", activeMode: "debug" });
    const { toolNames } = await captureToolsetAndPrompt(sessionId, "debug this failure");

    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
    expect(toolNames).toContain("run_command");
  });

  it("a MODELESS session's toolset is the full registry set (unchanged by R81)", async () => {
    const sessionId = newSession();
    const { toolNames } = await captureToolsetAndPrompt(sessionId, "do the work");

    expect(toolNames.sort()).toEqual([...TOOL_NAMES].sort());
  });
});

/* ── The R75 debug command tier is RETIRED (approvals) ────────────────────── */

describe("R81: the debug posture no longer denies ask-tier commands (the R75 tier, retired)", () => {
  function newSession(): { sessionId: string; agentId: string; root: string } {
    const root = mkdtempSync(join(tempDir, "cmd-proj-"));
    const project = createProject(db, { name: `R81CMD-${randomUUID().slice(0, 8)}`, rootPath: root });
    const agent = createAgent(db, {
      name: "R81 CMD Agent",
      providerId: "openrouter",
      model: "test/r81-cmd",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    return { sessionId: session.id, agentId: agent.id, root };
  }

  function deps(sessionId: string, agentId: string, permissionMode: "full" | "ask" = "ask") {
    return {
      db,
      sessionId,
      agentId,
      interactive: true,
      permissionMode,
    };
  }

  it("debug + ASK: an ask-tier command CREATES the approval and waits (not the R75 debug refusal)", async () => {
    const { sessionId, agentId, root } = newSession();
    updateSessionActiveMode(db, sessionId, "debug");
    // Race the 120s wait with an immediate deny through the waiter map
    // (the permission-modes suite's pattern): the ask-tier flow OWNS the
    // command now — the posture never sees it.
    const emitted: Array<Record<string, unknown>> = [];
    const askDeps = {
      db,
      sessionId,
      agentId,
      interactive: true,
      permissionMode: "ask" as const,
      emit: (event: unknown) => emitted.push(event as Record<string, unknown>),
      appendEvent: (event: { type: "approval.requested" | "approval.resolved"; agentId: string; payload: Record<string, unknown> }) => {
        appendSessionEvent(db, sessionId, event);
      },
    };
    const gatePromise = requestCommandApproval(askDeps, "node server.js", { root });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const requested = emitted.find((e) => e.type === "approval.requested") as { approvalId: string } | undefined;
    expect(requested).toBeDefined();
    resolvePendingApproval(requested!.approvalId, "denied");
    const gate = await gatePromise;
    // The denial is the OWNER's decision — the R75 debug-mode refusal text
    // is gone entirely.
    expect(gate.allowed).toBe(false);
    expect(gate.note).not.toContain("debug mode");
    expect(gate.note).not.toContain("switch_mode");
  });

  it("debug + ASK, NON-interactive: the honest not-interactive refusal (fail-fast, not the debug note)", async () => {
    const { sessionId, agentId, root } = newSession();
    updateSessionActiveMode(db, sessionId, "debug");
    const outcome = await requestCommandApproval(
      { db, sessionId, agentId, interactive: false, permissionMode: "ask" },
      "node server.js",
      { root },
    );
    expect(outcome.allowed).toBe(false);
    expect(outcome.note).toContain("interactive approval");
    expect(outcome.note).not.toContain("debug mode");
  });

  it("debug + FULL permission AUTO-APPROVES the ask tier (R75 denied it — the posture no longer outranks the operating mode)", async () => {
    const { sessionId, agentId, root } = newSession();
    updateSessionActiveMode(db, sessionId, "debug");
    const outcome = await requestCommandApproval(deps(sessionId, agentId, "full"), "node server.js", { root });
    expect(outcome.allowed).toBe(true);
    expect(outcome.note).toContain("Full Access");
  });

  it("AUTO-tier commands still run under debug (diagnostics: read-only, build, test)", async () => {
    const { sessionId, agentId, root } = newSession();
    updateSessionActiveMode(db, sessionId, "debug");
    const outcome = await requestCommandApproval(deps(sessionId, agentId), "cat README.md", { root });
    expect(outcome.allowed).toBe(true);
  });
});

/* ── R81: switch_mode freely switches postures (the R75 owner-pin, retired) ── */

describe("R81: switch_mode switching is free (postures are self-selected guidance)", () => {
  function makeDeps(sessionId: string): ToolDeps {
    return { db, sessionId, agentId: "agt-r81-free" };
  }

  async function buildSwitchTool(sessionId: string) {
    const tools = await modesPlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps(sessionId),
    });
    return tools.find((t) => t.name === "switch_mode")!;
  }

  function postureSession(mode: string | null): string {
    const agent = createAgent(db, {
      name: "R81 Free Agent",
      providerId: "openrouter",
      model: "test/r81-free",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    if (mode !== null) updateSessionActiveMode(db, session.id, mode);
    return session.id;
  }

  it("a plan-posture session: switching OUT lands the new posture — the R75 owner-pin refusal, inverted", async () => {
    const sessionId = postureSession("plan");
    const tool = await buildSwitchTool(sessionId);

    const out = await tool.execute({ mode: "build" }, { root: tempDir });
    expect(out.ok).toBe(true);
    expect(out.output.startsWith("# Task mode ACTIVE: Build (build)")).toBe(true);
    // The row MOVED (nothing is pinned anymore).
    expect(getSession(db, sessionId)?.activeMode).toBe("build");
  });

  it("a plan-posture session: CLEARING is allowed too (the posture pointer returns to null)", async () => {
    const sessionId = postureSession("plan");
    const tool = await buildSwitchTool(sessionId);

    const clear = await tool.execute({ mode: "none" }, { root: tempDir });
    expect(clear.ok).toBe(true);
    expect(clear.output).toBe(
      "Task mode deactivated. The ACTIVE TASK MODE section leaves the system prompt from the next turn; default posture applies.",
    );
    expect(getSession(db, sessionId)?.activeMode).toBeNull();
  });

  it("EVERY read-only posture is freely leavable (review/explore — the whole R75 pin set)", async () => {
    for (const mode of ["review", "explore"]) {
      const sessionId = postureSession(mode);
      const tool = await buildSwitchTool(sessionId);
      const out = await tool.execute({ mode: "build" }, { root: tempDir });
      expect(out.ok).toBe(true);
      expect(out.output.startsWith("# Task mode ACTIVE: Build (build)")).toBe(true);
      expect(getSession(db, sessionId)?.activeMode).toBe("build");
    }
  });

  it("re-selecting the SAME posture returns the guide (no-op pass-through); LIST stays an observation", async () => {
    const sessionId = postureSession("plan");
    const tool = await buildSwitchTool(sessionId);
    const same = await tool.execute({ mode: "plan" }, { root: tempDir });
    expect(same.ok).toBe(true);
    expect(same.output).toContain("# Task mode ACTIVE: Plan (plan)");
    // LIST is also allowed (reading the index is an observation).
    const list = await tool.execute({}, { root: tempDir });
    expect(list.ok).toBe(true);
    expect(list.output).toContain("Currently active: plan (Plan).");
  });
});

/* ── Delegation inheritance (unchanged by R81) ─────────────────────────────── */

describe("R81: delegation still inherits the parent's active posture (the R50-c1 rule, one tier down)", () => {
  it("a child session copies the parent's activeMode", async () => {
    const root = mkdtempSync(join(tempDir, "del-proj-"));
    const project = createProject(db, { name: `R81DEL-${randomUUID().slice(0, 8)}`, rootPath: root });
    const agent = createAgent(db, {
      name: "R81 DEL Agent",
      providerId: "openrouter",
      model: "test/r81-del",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    updateSessionActiveMode(db, parent.id, "plan");

    generateTextMock.mockResolvedValue({
      text: "Sub-agent report: task done.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const orchestrator = getOrchestrator();
    const result = await orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: aiSdkChat },
      parent.id,
      "research the plan inputs",
      "researcher",
    );

    expect(result.ok).toBe(true);
    const child = getSession(db, result.sessionId!);
    expect(child?.activeMode).toBe("plan"); // inherited, not defaulted
    // A modeless parent's child is modeless too.
    const parent2 = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    const result2 = await orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: aiSdkChat },
      parent2.id,
      "plain work",
      "coder",
    );
    expect(getSession(db, result2.sessionId!)?.activeMode).toBeNull();
  });

  it("createSession accepts an explicit activeMode (the storage-level input)", () => {
    const agent = createAgent(db, { name: "R81 Store Agent", providerId: "openrouter", model: "test/r81-st" });
    const withMode = createSession(db, { agentId: agent.id, mode: "single", activeMode: "review" });
    expect(getSession(db, withMode.id)?.activeMode).toBe("review");
    const without = createSession(db, { agentId: agent.id, mode: "single" });
    expect(getSession(db, without.id)?.activeMode).toBeNull();
  });
});
