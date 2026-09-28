// @vitest-environment node
//
// ROUND-132 (R132, Wave MA-core): THE MINI AGENT suite — the partner loop,
// the plugin, the cap, the frames, the events, the usage, the settings.
//
// What this suite pins (the round's contract, every clause):
//   1. THE CAP — reserve/release atomically; the honest refusal at 3 (never
//      a queue); the slot releases on EVERY path (failure, abort, success).
//   2. THE GATES — every honest refusal: no chat seam, no keyring, no root,
//      bad skill, empty task, custom without instructions, computer-use
//      master switch OFF, no model resolvable, no API key.
//   3. THE LOOP — a stubbed chatStream (text-deltas + tool-results +
//      finish) drives one mini run: the mini-agent.started/action/done
//      FRAMES ride the emit channel in order; the mini_agent.* EVENTS
//      persist on the parent session (the fold's source); the REPORT
//      returns as the tool result with the step/token header; the usage row
//      records origin "mini-agent"; the model resolution honors the
//      miniagentModel setting over the parent pair.
//   4. THE EMPTY REPORT — a loop that ends without text returns the honest
//      budget-exhausted failure (never a silent success).
//   5. THE NEVER-THROW — a chatStream that THROWS returns the honest
//      failure + the done frame still fires + the slot still releases.
//   6. THE PLUGIN — gated registration (no keyring/chatStream → no tool);
//      the tool dispatches through the loop; a broken loop never throws.
//   7. THE SETTINGS — miniagentModel read/write/clear via the shared
//      validator (the ref form, the legacy string form, the null clear, the
//      tool-capability rejection, the unknown-provider rejection); the
//      route PUT accepts the same three forms.
//   8. THE COMPUTER TOOL PIN — COMPUTER_MINI_TOOLS matches the real plugin
//      registrations exactly (drift fails loudly).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The AI SDK is mocked at the module boundary (the r79 pattern) — jsonSchema
// too, so buildProjectTools builds the REAL toolset.
vi.mock("ai", () => ({
  jsonSchema: <T>(schema: T) => schema,
}));

import type { StreamChatEvent, StreamChatFn } from "../src/agents/chat";
import {
  activeMiniAgentCount,
  COMPUTER_MINI_TOOLS,
  MINI_AGENT_CAP,
  MINI_SKILLS,
  miniAgentCapMessage,
  releaseMiniAgentSlot,
  reserveMiniAgentSlot,
  runMiniAgent,
} from "../src/agents/mini-agent";
import { miniAgentPlugin } from "../src/tools/plugins/mini-agent";
import { computerUsePlugin } from "../src/tools/plugins/computer-use";
import type { ToolDeps } from "../src/tools/index";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";
import { createAgent } from "../src/storage/agents";
import { createSession, listSessionEvents } from "../src/storage/sessions";
import { upsertModel } from "../src/storage/models";
import {
  getOrchestrationSettings,
  setOrchestrationSettings,
} from "../src/storage/settings";

const KEY = "sk-or-vtest-r132ma";

let db: SqliteDatabase;
let tempDir: string;
let projectRoot: string;
let sessionId: string;
let agentId: string;
let emitted: unknown[];
let toolDeps: ToolDeps;
let chatStub: StreamChatFn;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r132ma-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  projectRoot = mkdtempSync(join(tmpdir(), "acute-r132ma-proj-"));
  const project = createProject(db, { name: "R132 Project", rootPath: projectRoot });
  const agent = createAgent(db, {
    name: "R132 Parent",
    providerId: "openrouter",
    model: "test/r132-main",
  });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  agentId = agent.id;
  sessionId = session.id;
  emitted = [];
  toolDeps = {
    db,
    sessionId,
    agentId,
    projectId: project.id,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    chatStream: (input) => chatStub(input),
    emit: (event: unknown) => {
      emitted.push(event);
    },
    mainModel: { providerId: "openrouter", modelId: "test/r132-main" },
  };
  // The default stub — overwritten per test; a generator yielding a clean
  // one-step report.
  chatStub = async function* (): AsyncGenerator<StreamChatEvent> {
    yield { type: "text-delta", delta: "## REPORT\nOUTCOME: done\nSTATE: the file exists\nDETAILS: did the thing" };
    yield {
      type: "finish",
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    };
  };
});

afterEach(() => {
  // Belt: release anything a failed test leaked (the cap is module-scope).
  while (activeMiniAgentCount() > 0) {
    releaseMiniAgentSlot(`leak-${activeMiniAgentCount()}`);
  }
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/* ── 1. THE CAP ─────────────────────────────────────────────────────────── */

describe("R132-MA: the concurrency cap", () => {
  it("reserves atomically and refuses honestly at the cap (never a queue)", () => {
    expect(reserveMiniAgentSlot("m1")).toBe(true);
    expect(reserveMiniAgentSlot("m2")).toBe(true);
    expect(reserveMiniAgentSlot("m3")).toBe(true);
    // R132-MA: the fourth is the honest refusal — the owner's "for
    // starters, let's cap the limit at three".
    expect(reserveMiniAgentSlot("m4")).toBe(false);
    expect(activeMiniAgentCount()).toBe(MINI_AGENT_CAP);
    releaseMiniAgentSlot("m2");
    expect(reserveMiniAgentSlot("m5")).toBe(true);
    releaseMiniAgentSlot("m1");
    releaseMiniAgentSlot("m3");
    releaseMiniAgentSlot("m5");
    expect(activeMiniAgentCount()).toBe(0);
  });

  it("a duplicate id is refused (the set semantics)", () => {
    expect(reserveMiniAgentSlot("dup")).toBe(true);
    expect(reserveMiniAgentSlot("dup")).toBe(false);
    releaseMiniAgentSlot("dup");
  });

  it("the cap message names the number", () => {
    expect(miniAgentCapMessage()).toContain("3");
    expect(miniAgentCapMessage()).toContain("already running");
  });
});

/* ── 2. THE GATES (every honest refusal, never a throw) ─────────────────── */

describe("R132-MA: the honest gates", () => {
  it("no chat seam (neither streamed nor sync) → the honest channel refusal", async () => {
    const result = await runMiniAgent(
      { ...toolDeps, chatStream: undefined, chat: undefined },
      { skill: "search", task: "find it" },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no chat seam");
  });

  it("the SYNC channel: chat without chatStream lands the whole run in one call (frames at completion)", async () => {
    const syncChat = async (): Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      toolCalls: { name: string; argsSummary: string; ok: boolean; outputSummary?: string }[];
    }> => ({
      text: "## REPORT\nOUTCOME: done\nSTATE: the config lives at config/app.json\nDETAILS: searched + read",
      usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
      toolCalls: [
        { name: "search_files", argsSummary: "pattern: app.json", ok: true, outputSummary: "1 hit" },
        { name: "read_file", argsSummary: "path: config/app.json", ok: true, outputSummary: "42 lines" },
      ],
    });
    const result = await runMiniAgent(
      { ...toolDeps, chatStream: undefined, chat: syncChat },
      { skill: "search", task: "find the config" },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("mini agent (search) — 2 steps");
    expect(result.output).toContain("OUTCOME: done");
    // The frames fired (started → action ×2 → done) even without a stream.
    const types = emitted.map((e) => (e as { type: string }).type);
    expect(types).toEqual([
      "mini-agent.started",
      "mini-agent.action",
      "mini-agent.action",
      "mini-agent.done",
    ]);
    // The usage row recorded on the sync channel too.
    const usageRow = db
      .prepare("SELECT * FROM usage_events WHERE origin = 'mini-agent'")
      .get() as { input_tokens: number };
    expect(usageRow.input_tokens).toBe(80);
  });

  it("no keyring → the honest keyring refusal", async () => {
    const result = await runMiniAgent({ ...toolDeps, keyring: undefined }, { skill: "search", task: "find it" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("keyring");
  });

  it("no project root → the honest workspace refusal", async () => {
    const bare = createSession(db, { agentId, mode: "single" });
    const result = await runMiniAgent({ ...toolDeps, sessionId: bare.id }, { skill: "search", task: "find it" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no project root");
  });

  it("a bad skill → the honest grammar refusal", async () => {
    const result = await runMiniAgent(toolDeps, { skill: "banana" as never, task: "find it" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("browser, computer, search, or custom");
  });

  it("an empty task → the honest task refusal", async () => {
    const result = await runMiniAgent(toolDeps, { skill: "search", task: "   " });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("needs a task");
  });

  it("custom without instructions → the honest instructions refusal", async () => {
    const result = await runMiniAgent(toolDeps, { skill: "custom", task: "do the thing" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("needs instructions");
  });

  it("computer skill with the master switch OFF → the honest switch refusal", async () => {
    // Default settings: computerUse.enabled is false.
    const result = await runMiniAgent(toolDeps, { skill: "computer", task: "open notepad" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("master switch is OFF");
  });

  it("no model resolvable (no setting, no parent pair, no provider row) → the honest model refusal", async () => {
    const result = await runMiniAgent(
      { ...toolDeps, mainModel: undefined },
      { skill: "search", task: "find it" },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no model");
  });

  it("an unknown provider on the SETTING → the honest provider refusal", async () => {
    // The validator rejects unknown providers at WRITE time (the pinned
    // behavior); a directly-written row (a legacy/corrupt-class value)
    // still READS as a well-formed ref — and the run then refuses
    // honestly on the unresolvable provider (never a silent fallback to
    // the parent's model: a configured override that cannot serve must
    // SAY so).
    expect(() =>
      setOrchestrationSettings(db, {
        miniagentModel: { providerId: "prv_missing_r132", modelId: "x/y" },
      }),
    ).toThrow(/does not exist/);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('orchestration.miniagentModel', ?)").run(
      JSON.stringify({ providerId: "prv_missing_r132", modelId: "x/y" }),
    );
    const result = await runMiniAgent(toolDeps, { skill: "search", task: "find it" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("without a usable baseUrl");
  });
});

/* ── 3. THE LOOP (frames + events + report + usage) ─────────────────────── */

describe("R132-MA: the light partner loop", () => {
  it("one run: the frames ride the emit channel in order; the events persist; the report returns", async () => {
    chatStub = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "tool-call", toolName: "search_files", argsSummary: "pattern: hello" };
      yield { type: "tool-result", toolName: "search_files", argsSummary: "pattern: hello", ok: true, outputSummary: "2 hits" };
      yield { type: "text-delta", delta: "## REPORT\nOUTCOME: done\nSTATE: 2 files at /tmp\nDETAILS: searched + confirmed" };
      yield { type: "finish", usage: { inputTokens: 220, outputTokens: 60, totalTokens: 280 } };
    };
    const result = await runMiniAgent(toolDeps, { skill: "search", task: "find files named hello" });

    // The tool result = the report, with the step/token header.
    expect(result.ok).toBe(true);
    expect(result.output).toContain("mini agent (search) — 1 step");
    expect(result.output).toContain("OUTCOME: done");

    // The FRAMES: started → action → done, in order, attributed by miniId.
    const types = emitted.map((e) => (e as { type: string }).type);
    expect(types).toEqual(["mini-agent.started", "mini-agent.action", "mini-agent.done"]);
    const started = emitted[0] as { miniId: string; skill: string; task: string; model: { providerId: string; modelId: string } };
    expect(started.skill).toBe("search");
    expect(started.task).toBe("find files named hello");
    expect(started.model).toEqual({ providerId: "openrouter", modelId: "test/r132-main" });
    const action = emitted[1] as { miniId: string; seq: number; tool: string; ok: boolean; outputSummary: string | null };
    expect(action.miniId).toBe(started.miniId);
    expect(action.seq).toBe(1);
    expect(action.tool).toBe("search_files");
    expect(action.ok).toBe(true);
    expect(action.outputSummary).toBe("2 hits");
    const done = emitted[2] as { miniId: string; ok: boolean; steps: number; usage: { inputTokens: number } | null };
    expect(done.ok).toBe(true);
    expect(done.steps).toBe(1);
    expect(done.usage).toEqual({ inputTokens: 220, outputTokens: 60 });

    // The EVENTS persist on the PARENT session (the fold's source).
    const events = listSessionEvents(db, sessionId);
    const miniEvents = events.filter((e) => e.type.startsWith("mini_agent."));
    expect(miniEvents.map((e) => e.type)).toEqual(["mini_agent.started", "mini_agent.action", "mini_agent.done"]);

    // The USAGE row: origin "mini-agent" with the finish usage.
    const usageRow = db
      .prepare("SELECT * FROM usage_events WHERE origin = 'mini-agent'")
      .get() as { provider: string; model: string; input_tokens: number; output_tokens: number; session_id: string };
    expect(usageRow.provider).toBe("openrouter");
    expect(usageRow.model).toBe("test/r132-main");
    expect(usageRow.input_tokens).toBe(220);
    expect(usageRow.output_tokens).toBe(60);
    expect(usageRow.session_id).toBe(sessionId);

    // The slot released.
    expect(activeMiniAgentCount()).toBe(0);
  });

  it("the miniagentModel SETTING overrides the parent pair (the model + provider resolution)", async () => {
    // The openrouter row is seeded; give it a configured model row so the
    // validator's tool-capability check passes.
    upsertModel(db, "openrouter", { modelId: "test/r132-mini", supportsTools: true });
    setOrchestrationSettings(db, {
      miniagentModel: { providerId: "openrouter", modelId: "test/r132-mini" },
    });
    const seenModels: string[] = [];
    chatStub = async function* (input): AsyncGenerator<StreamChatEvent> {
      seenModels.push(input.model);
      yield { type: "text-delta", delta: "## REPORT\nOUTCOME: done\nSTATE: x\nDETAILS: y" };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    };
    const result = await runMiniAgent(toolDeps, { skill: "search", task: "find it" });
    expect(result.ok).toBe(true);
    expect(seenModels).toEqual(["test/r132-mini"]);
    const started = emitted[0] as { model: { modelId: string } };
    expect(started.model.modelId).toBe("test/r132-mini");
    setOrchestrationSettings(db, { miniagentModel: null });
    expect(getOrchestrationSettings(db).miniagentModel).toBeNull();
  });

  it("the loop's system prompt = the wrapper + the SKILL BODY (pre-given details)", async () => {
    const systems: string[] = [];
    chatStub = async function* (input): AsyncGenerator<StreamChatEvent> {
      systems.push(input.system);
      yield { type: "text-delta", delta: "## REPORT\nOUTCOME: done\nSTATE: x\nDETAILS: y" };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    };
    await runMiniAgent(toolDeps, { skill: "browser", task: "open example.com" });
    await runMiniAgent(toolDeps, { skill: "search", task: "find it" });
    await runMiniAgent(toolDeps, {
      skill: "custom",
      task: "inspect the config",
      instructions: "You are the config auditor: read config files and summarize keys.",
    });
    // The browser body rides the browser run.
    expect(systems[0]).toContain("# Skill: browser-use");
    // The search body rides the search run.
    expect(systems[1]).toContain("# Skill: search");
    // The custom instructions ride the custom run, under the wrapper.
    expect(systems[2]).toContain("You are the config auditor");
    // The wrapper's report contract + one-task law rides every run.
    for (const system of systems) {
      expect(system).toContain("## REPORT");
      expect(system).toContain("OUTCOME: done | blocked | failed");
      expect(system).toContain("at most ~8 tool steps");
    }
  });

  it("the tool subset: the mini's chat call receives ONLY the skill's tools", async () => {
    const toolSets: string[][] = [];
    chatStub = async function* (input): AsyncGenerator<StreamChatEvent> {
      toolSets.push(input.tools !== undefined ? Object.keys(input.tools) : []);
      yield { type: "text-delta", delta: "## REPORT\nOUTCOME: done\nSTATE: x\nDETAILS: y" };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    };
    await runMiniAgent(toolDeps, { skill: "search", task: "find it" });
    expect(new Set(toolSets[0])).toEqual(new Set(MINI_SKILLS.search().tools));
    for (const name of toolSets[0]) {
      expect(["search_files", "search_code", "search_symbols", "list_dir", "read_file"]).toContain(name);
    }
  });

  it("a long action output is capped at 400 chars in the frame/event", async () => {
    chatStub = async function* (): AsyncGenerator<StreamChatEvent> {
      yield {
        type: "tool-result",
        toolName: "search_code",
        argsSummary: "pattern: x",
        ok: true,
        outputSummary: "y".repeat(1000),
      };
      yield { type: "text-delta", delta: "## REPORT\nOUTCOME: done\nSTATE: x\nDETAILS: y" };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    };
    await runMiniAgent(toolDeps, { skill: "search", task: "find it" });
    const action = emitted[1] as { outputSummary: string | null };
    expect(action.outputSummary?.length).toBe(401); // 400 + the ellipsis char
    expect(action.outputSummary?.endsWith("…")).toBe(true);
  });
});

/* ── 4/5. THE EMPTY REPORT + THE NEVER-THROW ─────────────────────────────── */

describe("R132-MA: the honest outcomes", () => {
  it("a loop that ends without text returns the honest budget-exhausted failure", async () => {
    chatStub = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "tool-result", toolName: "search_files", argsSummary: "pattern: x", ok: true, outputSummary: "1 hit" };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    };
    const result = await runMiniAgent(toolDeps, { skill: "search", task: "find it" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("ended without a final report");
    expect(result.output).toContain("1 tool step");
    // The done frame still fired (the section's terminal state).
    expect(emitted.map((e) => (e as { type: string }).type)).toContain("mini-agent.done");
    expect(activeMiniAgentCount()).toBe(0);
  });

  it("a chatStream that THROWS: the honest failure, the done frame, the released slot", async () => {
    chatStub = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "text-delta", delta: "partial" };
      throw new Error("provider 502");
    };
    const result = await runMiniAgent(toolDeps, { skill: "search", task: "find it" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("failed: provider 502");
    const done = emitted[emitted.length - 1] as { type: string; ok: boolean };
    expect(done.type).toBe("mini-agent.done");
    expect(done.ok).toBe(false);
    expect(activeMiniAgentCount()).toBe(0);
  });

  it("the cap refusal mid-turn: a 4th concurrent run refuses honestly (no started frame)", async () => {
    // Occupy the 3 slots directly (the Promise.all world's parallel calls).
    expect(reserveMiniAgentSlot("hold-1")).toBe(true);
    expect(reserveMiniAgentSlot("hold-2")).toBe(true);
    expect(reserveMiniAgentSlot("hold-3")).toBe(true);
    const result = await runMiniAgent(toolDeps, { skill: "search", task: "find it" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("mini agent limit reached");
    expect(emitted).toEqual([]); // no frames — the run never started
    releaseMiniAgentSlot("hold-1");
    releaseMiniAgentSlot("hold-2");
    releaseMiniAgentSlot("hold-3");
  });
});

/* ── 6. THE PLUGIN ───────────────────────────────────────────────────────── */

describe("R132-MA: the mini_agent plugin", () => {
  it("registers gated: no keyring or no chatStream → no tool (the declaration world)", async () => {
    const bare = await miniAgentPlugin.createTools({ root: projectRoot });
    expect(bare).toEqual([]);
    const noKeyring = await miniAgentPlugin.createTools({
      root: projectRoot,
      toolDeps: { ...toolDeps, keyring: undefined },
    });
    expect(noKeyring).toEqual([]);
    const noStream = await miniAgentPlugin.createTools({
      root: projectRoot,
      toolDeps: { ...toolDeps, chatStream: undefined, chat: undefined },
    });
    expect(noStream).toEqual([]);
    // The full deps DO register the tool.
    const tools = await miniAgentPlugin.createTools({ root: projectRoot, toolDeps });
    expect(tools.map((t) => t.name)).toEqual(["mini_agent"]);
    expect(tools[0].description).toContain("browser");
    expect(tools[0].description).toContain("custom");
  });

  it("the tool executes through the loop and never throws (even on loop errors)", async () => {
    const tools = await miniAgentPlugin.createTools({ root: projectRoot, toolDeps });
    const miniTool = tools[0];
    const result = await miniTool.execute({ skill: "search", task: "find the config" }, {
      root: projectRoot,
      toolDeps,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("OUTCOME: done");

    // A loop that throws (the chat seam dying) → the honest failure result,
    // never a throw.
    chatStub = async function* (): AsyncGenerator<StreamChatEvent> {
      throw new Error("dead");
    };
    const failed = await miniTool.execute({ skill: "search", task: "find the config" }, {
      root: projectRoot,
      toolDeps,
    });
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain("failed");
  });

  it("a bad skill input → the honest grammar refusal (never a throw)", async () => {
    const tools = await miniAgentPlugin.createTools({ root: projectRoot, toolDeps });
    const result = await tools[0].execute({ skill: "nope", task: "x" }, { root: projectRoot, toolDeps });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("browser, computer, search, or custom");
  });
});

/* ── 7. THE SETTINGS (the shared validator) ──────────────────────────────── */

describe("R132-MA: the miniagentModel setting", () => {
  it("defaults to null (use the main one) and round-trips the ref form", () => {
    expect(getOrchestrationSettings(db).miniagentModel).toBeNull();
    upsertModel(db, "openrouter", { modelId: "test/r132-mini", supportsTools: true });
    const updated = setOrchestrationSettings(db, {
      miniagentModel: { providerId: "openrouter", modelId: "test/r132-mini" },
    });
    expect(updated.miniagentModel).toEqual({ providerId: "openrouter", modelId: "test/r132-mini" });
    // The clear (null) — "Inherits main model".
    const cleared = setOrchestrationSettings(db, { miniagentModel: null });
    expect(cleared.miniagentModel).toBeNull();
  });

  it("rejects an unknown provider and an explicitly tool-incapable model (naming the field)", () => {
    expect(() =>
      setOrchestrationSettings(db, {
        miniagentModel: { providerId: "prv_missing_r132", modelId: "x/y" },
      }),
    ).toThrow(/miniagentModel provider 'prv_missing_r132' does not exist/);
    upsertModel(db, "openrouter", { modelId: "test/r132-noTools", supportsTools: false });
    expect(() =>
      setOrchestrationSettings(db, {
        miniagentModel: { providerId: "openrouter", modelId: "test/r132-noTools" },
      }),
    ).toThrow(/miniagentModel 'test\/r132-noTools' is marked as NOT tool-capable/);
    // Nothing persisted.
    expect(getOrchestrationSettings(db).miniagentModel).toBeNull();
  });

  it("the legacy plain-string form reads back openrouter-scoped (the shared grammar)", () => {
    upsertModel(db, "openrouter", { modelId: "test/r132-legacy", supportsTools: true });
    // A direct row write of the legacy form (the validator's string arm
    // needs a known catalog id; the storage read normalizes either way).
    db.prepare("INSERT INTO settings (key, value) VALUES ('orchestration.miniagentModel', ?)").run(
      "test/r132-legacy",
    );
    expect(getOrchestrationSettings(db).miniagentModel).toEqual({
      providerId: "openrouter",
      modelId: "test/r132-legacy",
    });
  });
});

/* ── 8. THE COMPUTER TOOL PIN ────────────────────────────────────────────── */

describe("R132-MA: the COMPUTER_MINI_TOOLS pin (drift fails loudly)", () => {
  it("matches the computer-use plugin's registrations exactly", async () => {
    // Enable the master switch so createTools registers the family.
    db.prepare("INSERT INTO settings (key, value) VALUES ('computerUse.enabled', 'true')").run();
    const tools = await computerUsePlugin.createTools({ root: projectRoot, toolDeps });
    expect(tools.length).toBeGreaterThan(0);
    const registered = new Set(tools.map((t) => t.name));
    const miniSet = new Set(COMPUTER_MINI_TOOLS);
    // Every mini tool exists in the plugin's registrations…
    for (const name of miniSet) expect(registered.has(name)).toBe(true);
    // …and every plugin tool is in the mini's set (the whole family rides).
    expect([...registered].every((name) => miniSet.has(name))).toBe(true);
    expect(COMPUTER_MINI_TOOLS.length).toBe(registered.size);
  });
});
