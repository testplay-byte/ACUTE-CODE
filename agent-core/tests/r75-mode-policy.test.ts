/**
 * ROUND-75 (R75) regression tests — TASK-MODE HARD ENFORCEMENT.
 *
 * Until R75, the six builtin task modes (plan/debug/build/review/explore/
 * refactor) were PURE PROMPT SUGGESTION: the mode body said "NO EDITS" in
 * prose while the turn's toolset still carried write_file / edit_file /
 * run_command (the owner's report: plan mode "tried to make edits to the
 * files, it tried to run commands"). This suite pins the enforcement layer:
 *
 *  · Pure policy: plan/review/explore read-only sets (plan = the R50
 *    PLAN_MODE_TOOLS verbatim; review/explore add the git inspectors +
 *    analyze_image + job_status), debug/build/refactor full.
 *  · narrowAllowListByTaskModePolicy: intersection semantics, the NO_TOOLS
 *    sentinel, untouched pass-throughs (undefined mode, no policy entry),
 *    custom modes shadowing read-only builtins.
 *  · Turn integration: a plan-mode session's toolset + the system prompt's
 *    toolNames both exclude every mutating tool (the dark-tools honesty
 *    rule); debug keeps run_command; review/explore keep the read-only
 *    superset; a modeless session's toolset is byte-identical to pre-R75.
 *  · The debug command tier (approvals): an ask-tier command is DENIED
 *    under debug (with the switch_mode note) even in full-permission
 *    sessions; auto-tier commands still run.
 *  · Delegation inheritance: a child session copies the parent's
 *    activeMode (the R50-c1 rule, one tier down).
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

import { runSingleAgentTurn } from "../src/agents/runtime";
import { BUILTIN_MODES, findMode, type TaskMode } from "../src/agents/modes";
import {
  PLAN_MODE_TOOLS,
  TASK_MODE_READ_ONLY,
  TASK_MODE_TOOL_POLICY,
  isReadOnlyTaskMode,
  narrowAllowListByTaskModePolicy,
} from "../src/agents/mode-policy";
import { requestCommandApproval } from "../src/approvals";
import { modesPlugin } from "../src/tools/plugins/modes";
import type { ToolDeps } from "../src/tools/index";
import { getOrchestrator } from "../src/agents/orchestrator";
import { aiSdkChat } from "../src/agents/chat";
import { TOOL_NAMES, createAgent } from "../src/storage/agents";
import { NO_TOOLS } from "../src/tools/index";
import { createProject } from "../src/storage/projects";
import { createSession, getSession, updateSessionActiveMode } from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-r75-modepolicy";
let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r75-mp-"));
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

describe("R75: the builtin task-mode tool policy", () => {
  it("plan = the R50 PLAN_MODE_TOOLS verbatim (the owner's read-only spec)", () => {
    expect(TASK_MODE_TOOL_POLICY.plan).toEqual(PLAN_MODE_TOOLS);
    // The mutating tools are all absent.
    for (const tool of ["write_file", "edit_file", "create_dir", "delete_file", "run_command", "index_project", "job_stop"]) {
      expect(PLAN_MODE_TOOLS).not.toContain(tool);
    }
    // The escape hatch is present (the dark-tools honesty rule).
    expect(PLAN_MODE_TOOLS).toContain("switch_mode");
  });

  it("review and explore = plan + git inspectors + analyze_image + job_status", () => {
    for (const id of ["review", "explore"]) {
      const policy = TASK_MODE_TOOL_POLICY[id];
      expect(policy).toBeDefined();
      for (const tool of PLAN_MODE_TOOLS) expect(policy).toContain(tool);
      for (const extra of ["git_status", "git_diff", "git_log", "analyze_image", "job_status"]) {
        expect(policy).toContain(extra);
      }
      for (const tool of ["write_file", "edit_file", "create_dir", "delete_file", "run_command", "index_project", "job_stop"]) {
        expect(policy).not.toContain(tool);
      }
    }
  });

  it("debug / build / refactor have NO policy entry (full toolset; debug's gate is the command tier)", () => {
    expect(TASK_MODE_TOOL_POLICY.debug).toBeUndefined();
    expect(TASK_MODE_TOOL_POLICY.build).toBeUndefined();
    expect(TASK_MODE_TOOL_POLICY.refactor).toBeUndefined();
  });

  it("TASK_MODE_READ_ONLY = {plan, review, explore}", () => {
    expect([...TASK_MODE_READ_ONLY].sort()).toEqual(["explore", "plan", "review"]);
    expect(isReadOnlyTaskMode("plan")).toBe(true);
    expect(isReadOnlyTaskMode("build")).toBe(false);
    expect(isReadOnlyTaskMode(null)).toBe(false);
    expect(isReadOnlyTaskMode(undefined)).toBe(false);
  });

  it("every policy name is real registry vocabulary (no invented tools)", () => {
    for (const policy of Object.values(TASK_MODE_TOOL_POLICY)) {
      for (const tool of policy) expect(TOOL_NAMES).toContain(tool);
    }
  });
});

describe("R75: narrowAllowListByTaskModePolicy (the intersection semantics)", () => {
  const planMode = findMode(BUILTIN_MODES, "plan")!;
  const buildMode = findMode(BUILTIN_MODES, "build")!;

  it("undefined mode → untouched", () => {
    expect(narrowAllowListByTaskModePolicy(["read_file", "run_command"], undefined)).toEqual(["read_file", "run_command"]);
    expect(narrowAllowListByTaskModePolicy(undefined, undefined)).toBeUndefined();
  });

  it("a mode with no policy entry (build/debug/refactor/custom id) → untouched", () => {
    expect(narrowAllowListByTaskModePolicy(["read_file", "write_file"], buildMode)).toEqual(["read_file", "write_file"]);
    const custom: TaskMode = { ...buildMode, id: "custom-work", source: "file" };
    expect(narrowAllowListByTaskModePolicy(["read_file", "write_file"], custom)).toEqual(["read_file", "write_file"]);
  });

  it("undefined/[] allowlist (ALL) ∩ plan = the plan set itself", () => {
    expect(narrowAllowListByTaskModePolicy(undefined, planMode)).toEqual(PLAN_MODE_TOOLS);
    expect(narrowAllowListByTaskModePolicy([], planMode)).toEqual(PLAN_MODE_TOOLS);
  });

  it("the policy INTERSECTS a narrower allowlist (never widens)", () => {
    expect(narrowAllowListByTaskModePolicy(["read_file", "run_command"], planMode)).toEqual(["read_file"]);
  });

  it("an empty intersection → the NO_TOOLS sentinel (never [] = ALL)", () => {
    expect(narrowAllowListByTaskModePolicy(["run_command", "write_file"], planMode)).toEqual(NO_TOOLS);
  });

  it("NO_TOOLS passes through (already nothing)", () => {
    expect(narrowAllowListByTaskModePolicy(NO_TOOLS, planMode)).toEqual(NO_TOOLS);
  });

  it("a CUSTOM mode shadowing a read-only builtin stays read-only (id-keyed)", () => {
    const shadow: TaskMode = { ...planMode, source: "file" };
    expect(narrowAllowListByTaskModePolicy(["read_file", "write_file"], shadow)).toEqual(["read_file"]);
    // Frontmatter cannot widen a read-only shadow either (composition:
    // frontmatter ∩ policy).
    const withTools: TaskMode = { ...planMode, source: "file", tools: ["read_file", "write_file"] };
    // The frontmatter narrowing runs FIRST (R73) — ["read_file"] after
    // validation against the registry — then the policy keeps it read-only.
    expect(narrowAllowListByTaskModePolicy(["read_file", "write_file"], withTools)).toEqual(["read_file"]);
  });
});

/* ── Turn integration: the toolset + prompt honesty ───────────────────────── */

describe("R75: turn integration (prepareTurn)", () => {
  function newSession(rootPath?: string): string {
    const root = rootPath ?? mkdtempSync(join(tempDir, "proj-"));
    const project = createProject(db, { name: `R75MP-${randomUUID().slice(0, 8)}`, rootPath: root });
    const agent = createAgent(db, {
      name: "R75 MP Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/r75-mp",
    });
    return createSession(db, { agentId: agent.id, mode: "single", projectId: project.id }).id;
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

  it("a PLAN-mode session gets the read-only toolset — and the prompt's toolNames match exactly", async () => {
    const sessionId = newSession();
    updateSessionActiveMode(db, sessionId, "plan");
    const { toolNames, system } = await captureToolsetAndPrompt(sessionId, "plan this feature");

    expect(toolNames.sort()).toEqual([...PLAN_MODE_TOOLS].sort());
    for (const tool of ["write_file", "edit_file", "create_dir", "delete_file", "run_command", "index_project", "job_stop"]) {
      expect(toolNames).not.toContain(tool);
      // Dark-tools honesty: the prompt never names a tool the model cannot call.
      expect(system).not.toMatch(new RegExp(`\\b${tool}\\b.*available`));
    }
    // The enforced fact rides the mode body (instruction + fact).
    expect(system).toContain("ENFORCED, not advisory");
  });

  it("a REVIEW-mode session gets the read-only superset (git inspectors + job_status + analyze_image)", async () => {
    const sessionId = newSession();
    updateSessionActiveMode(db, sessionId, "review");
    const { toolNames } = await captureToolsetAndPrompt(sessionId, "review this diff");

    expect(toolNames.sort()).toEqual([...TASK_MODE_TOOL_POLICY.review].sort());
    expect(toolNames).toContain("git_diff");
    expect(toolNames).not.toContain("write_file");
  });

  it("an EXPLORE-mode session gets the read-only superset", async () => {
    const sessionId = newSession();
    updateSessionActiveMode(db, sessionId, "explore");
    const { toolNames } = await captureToolsetAndPrompt(sessionId, "explore the codebase");

    expect(toolNames.sort()).toEqual([...TASK_MODE_TOOL_POLICY.explore].sort());
    expect(toolNames).not.toContain("run_command");
  });

  it("a DEBUG-mode session KEEPS the full mutating toolset (the fix needs it)", async () => {
    const sessionId = newSession();
    updateSessionActiveMode(db, sessionId, "debug");
    const { toolNames } = await captureToolsetAndPrompt(sessionId, "debug this failure");

    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
    expect(toolNames).toContain("run_command");
  });

  it("a MODELESS session's toolset is the full registry set (byte-identical to pre-R75)", async () => {
    const sessionId = newSession();
    const { toolNames } = await captureToolsetAndPrompt(sessionId, "do the work");

    expect(toolNames.sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("a BUILD-mode session's toolset is the full registry set", async () => {
    const sessionId = newSession();
    updateSessionActiveMode(db, sessionId, "build");
    const { toolNames } = await captureToolsetAndPrompt(sessionId, "build the feature");

    expect(toolNames.sort()).toEqual([...TOOL_NAMES].sort());
  });
});

/* ── The debug command tier (approvals) ────────────────────────────────────── */

describe("R75: the debug-mode command tier (approvals)", () => {
  function newSession(): { sessionId: string; agentId: string; root: string } {
    const root = mkdtempSync(join(tempDir, "cmd-proj-"));
    const project = createProject(db, { name: `R75CMD-${randomUUID().slice(0, 8)}`, rootPath: root });
    const agent = createAgent(db, {
      name: "R75 CMD Agent",
      providerId: "openrouter",
      model: "test/r75-cmd",
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

  it("an ASK-tier command is DENIED under debug — with the honest switch_mode note", async () => {
    const { sessionId, agentId, root } = newSession();
    updateSessionActiveMode(db, sessionId, "debug");
    const outcome = await requestCommandApproval(deps(sessionId, agentId), "node server.js", { root });
    expect(outcome.allowed).toBe(false);
    expect(outcome.note).toContain("debug mode");
    expect(outcome.note).toContain("switch_mode");
  });

  it("debug + FULL permission still denies the ask tier (the task mode outranks the widening)", async () => {
    const { sessionId, agentId, root } = newSession();
    updateSessionActiveMode(db, sessionId, "debug");
    const outcome = await requestCommandApproval(deps(sessionId, agentId, "full"), "node server.js", { root });
    expect(outcome.allowed).toBe(false);
    expect(outcome.note).toContain("debug mode");
  });

  it("AUTO-tier commands still run under debug (diagnostics: read-only, build, test)", async () => {
    const { sessionId, agentId, root } = newSession();
    updateSessionActiveMode(db, sessionId, "debug");
    const outcome = await requestCommandApproval(deps(sessionId, agentId), "cat README.md", { root });
    expect(outcome.allowed).toBe(true);
  });

  it("a NON-debug session keeps the ask flow (the gate is debug-only)", async () => {
    const { sessionId, agentId, root } = newSession();
    const outcome = await requestCommandApproval(deps(sessionId, agentId, "full"), "node server.js", { root });
    // Full permission auto-approves the ask tier exactly as before R75.
    expect(outcome.allowed).toBe(true);
    expect(outcome.note).toContain("Full Access");
  });
});

/* ── Delegation inheritance ────────────────────────────────────────────────── */

describe("R75: delegation inherits the parent's active task mode", () => {
  it("a child session copies the parent's activeMode (the R50-c1 rule, one tier down)", async () => {
    const root = mkdtempSync(join(tempDir, "del-proj-"));
    const project = createProject(db, { name: `R75DEL-${randomUUID().slice(0, 8)}`, rootPath: root });
    const agent = createAgent(db, {
      name: "R75 DEL Agent",
      providerId: "openrouter",
      model: "test/r75-del",
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
    const agent = createAgent(db, { name: "R75 Store Agent", providerId: "openrouter", model: "test/r75-st" });
    const withMode = createSession(db, { agentId: agent.id, mode: "single", activeMode: "review" });
    expect(getSession(db, withMode.id)?.activeMode).toBe("review");
    const without = createSession(db, { agentId: agent.id, mode: "single" });
    expect(getSession(db, without.id)?.activeMode).toBeNull();
  });
});

/* ── R75: read-only modes are OWNER-PINNED (switch_mode cannot leave them) ─── */

describe("R75: switch_mode pinning (the read-only postures)", () => {
  function makeDeps(sessionId: string): ToolDeps {
    return { db, sessionId, agentId: "agt-r75-pin" };
  }

  async function buildSwitchTool(sessionId: string) {
    const tools = await modesPlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps(sessionId),
    });
    return tools.find((t) => t.name === "switch_mode")!;
  }

  function pinnedSession(mode: string | null): string {
    const agent = createAgent(db, {
      name: "R75 Pin Agent",
      providerId: "openrouter",
      model: "test/r75-pin",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    if (mode !== null) updateSessionActiveMode(db, session.id, mode);
    return session.id;
  }

  it("a plan-mode session: switching OUT or clearing is REFUSED with the honest owner-pinned note", async () => {
    const sessionId = pinnedSession("plan");
    const tool = await buildSwitchTool(sessionId);

    const out = await tool.execute({ mode: "build" }, { root: tempDir });
    expect(out.ok).toBe(false);
    expect(out.output).toContain("read-only posture the OWNER set");
    expect(out.output).toContain("mode picker");

    const clear = await tool.execute({ mode: "none" }, { root: tempDir });
    expect(clear.ok).toBe(false);
    expect(clear.output).toContain("read-only posture the OWNER set");

    // The row is untouched in both cases.
    expect(getSession(db, sessionId)?.activeMode).toBe("plan");
  });

  it("a plan-mode session: re-selecting the SAME mode is a no-op pass-through (the guide returns)", async () => {
    const sessionId = pinnedSession("plan");
    const tool = await buildSwitchTool(sessionId);
    const same = await tool.execute({ mode: "plan" }, { root: tempDir });
    expect(same.ok).toBe(true);
    expect(same.output).toContain("# Task mode ACTIVE: Plan (plan)");
    // LIST is also allowed (reading the index is an observation).
    const list = await tool.execute({}, { root: tempDir });
    expect(list.ok).toBe(true);
    expect(list.output).toContain("Currently active: plan (Plan).");
  });

  it("a NON-read-only mode (debug/build): switch_mode keeps full control", async () => {
    const sessionId = pinnedSession("build");
    const tool = await buildSwitchTool(sessionId);
    const out = await tool.execute({ mode: "plan" }, { root: tempDir });
    expect(out.ok).toBe(true);
    expect(out.output).toContain("# Task mode ACTIVE: Plan (plan)");
    expect(getSession(db, sessionId)?.activeMode).toBe("plan");
  });
});
