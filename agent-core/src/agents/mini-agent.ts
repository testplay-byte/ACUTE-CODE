/**
 * ROUND-132 (R132, Wave MA-core) — THE MINI AGENT: the light partner loop.
 *
 * The owner's directive (his words): the main agent dispatches a small
 * natural-language task to a mini agent — "a partner to it… not like a
 * sub-agent" — specialized in ONE skill (browser use, computer use, file
 * search — "it will be pre-given those details about it"), running "its
 * own" small model loop, performing "small, quick, smart approach tasks",
 * and returning "the response… and the main agent will know what happened
 * and what the current state is". Up to 3 run concurrently; they are
 * DISPOSABLE ("used one time and afterwards they will be scrapped… they
 * will not be able to have multiple long conversations, they cannot be
 * restarted"); they are NOT long-horizon workers (delegate_task owns that
 * surface).
 *
 * WHY A FRESH LOOP (not the delegation runner): delegation children get a
 * full child session + the 25K system prompt + resume semantics + the
 * Sub-agents panel — everything this directive explicitly does NOT want.
 * `runStreamedAgentTurn` is also unusable here: it writes `message.user`
 * and flips session status on the session it is handed — pointing it at
 * the PARENT session would corrupt the parent's log. So this module calls
 * the chat seam DIRECTLY (the debug analyst's side-loop precedent,
 * routes/sse.ts): a short `chatStream` with the SKILL BODY as the system
 * prompt, the skill's tool allowlist, a hard step budget, and its own
 * model (the `orchestration.miniagentModel` setting, else the parent
 * turn's effective pair).
 *
 * The mini's tool chatter NEVER enters the main model's context — only
 * the final REPORT returns as the mini_agent tool result (the efficiency
 * is the point); the actions surface as `mini-agent.*` frames on the
 * parent's SSE (the in-chat dedicated section) + `mini_agent.*`
 * session_events (the fold after reload), each attributed by a stable
 * `miniId` (the R128-W5 out-of-order-completion lesson: three minis in
 * one message complete in ANY order).
 *
 * CONCURRENCY: the AI SDK executes all tool calls of one assistant
 * message via Promise.all (ai@7 executeTools), so three mini_agent calls
 * in ONE message run natively in parallel — the 3-cap is enforced HERE,
 * inside the module (an atomic check-and-add on a Set; the honest
 * {ok:false} refusal, never a queue: the r79 cap's refusal shape).
 *
 * NEVER-THROW: the plugin's execute never throws (the wrapToolExecute
 * belt), and this module's own try/finally releases the slot whatever
 * happens — a mini that dies must not leak a permit for the whole turn.
 */
import { appendSessionEvent, recordUsage, getSession } from "../storage/sessions.js";
import { getProject } from "../storage/projects.js";
import { getOrchestrationSettings } from "../storage/settings.js";
import { getComputerUseSettings } from "../storage/computer-use.js";
import { BROWSER_USE_SKILL_BODY, COMPUTER_USE_SKILL_BODY } from "../storage/skills.js";
import { resolveKeyPool, resolveProvider } from "../providers/registry.js";
import { buildProjectTools, type ToolDeps } from "../tools/index.js";
import { computeCost } from "./runtime.js";
import type { ChatFn, StreamChatFn } from "./chat.js";

// ── the skills (the owner: "each of the mini agents will be skilled in
//    only one of its ways… pre-given those details about it") ────────────────

export type MiniAgentSkill = "browser" | "computer" | "search" | "custom";

/**
 * The COMPUTER tool family — the exact 42 names the computer-use plugin
 * registers when its master switch is on (verified against the plugin's
 * registrations; a pin test re-verifies the set so drift fails loudly).
 * The mini's computer specialization gets the WHOLE family: observation,
 * element actions, raw input, window management — the skill body teaches
 * the discipline.
 */
export const COMPUTER_MINI_TOOLS: readonly string[] = [
  // observe & resolve
  "list_apps", "open_application", "list_windows", "get_app_state", "find_elements",
  "get_tree", "get_children", "get_parent", "get_subtree", "windows_overview",
  "element_at", "app_profile", "screenshot", "zoom", "list_displays", "switch_display",
  "cursor_position",
  // act
  "left_click", "double_click", "triple_click", "right_click", "middle_click", "scroll",
  "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "type", "set_value",
  "select_text", "key", "hold_key", "perform_action",
  // lifecycle + clipboard + windows
  "request_access", "stop_computer_control", "wait", "read_clipboard", "write_clipboard",
  "move_window", "window_state", "focus_window", "window_action",
];

/**
 * The SEARCH tool family — read-only discovery (the "find the project on
 * my PC which had X in it" class: the mini derives its own keywords,
 * walks the tree, greps contents). Also the CUSTOM skill's default toolset:
 * a main-agent-defined specialty gets the safe read-only subset — the
 * instructions say what to look at, these tools let it look.
 */
export const SEARCH_MINI_TOOLS: readonly string[] = [
  "search_files",
  "search_code",
  "search_symbols",
  "list_dir",
  "read_file",
];

/** The BROWSER family — the embedded panel's single control surface. */
export const BROWSER_MINI_TOOLS: readonly string[] = ["browser_control"];

/** The search skill's body — the house style (imperative, budgeted, a
 * report contract), written for the mini's one-task shape. */
export const SEARCH_SKILL_BODY = `# Skill: search

Find files, code, and answers on THIS machine quickly and precisely. You get one task; derive your OWN keywords and strategy from it — the main agent gave you the goal, not the steps.

## Core loop
1. Derive 2-5 DISTINCT search keys from the task (names, extensions, distinctive substrings — a version number, a unique identifier beats a common word).
2. search_files / search_code with the sharpest key first; list_dir to walk a neighborhood when you know the area; read_file to confirm a hit (whole files arrive in one call — do not pre-split).
3. search_symbols when the target is a definition in an indexed project.
4. STOP at the first well-confirmed answer that satisfies the task — exhaustive sweeps are waste.

## Discipline
- Prefer precise over broad: search_code with a distinctive substring beats listing everything.
- A miss on one key is a signal, not a failure — try the next key, or the neighboring directory, before reporting blocked.
- Never modify anything — you are a finder, not an editor.
- Paths you report are the deliverable: absolute when found outside the project, project-relative when inside.`;

/** The custom skill's wrapper line — the main agent wrote the specialty. */
const CUSTOM_SKILL_PREFIX = `# Skill: custom

Your specialty was defined by the main agent (below). Follow it exactly; the tools you have are the safe read-only set — when the task needs more, report what you would have needed instead of improvising.

--- the main agent's instructions ---
`;

export interface MiniSkillSpec {
  /** The tool allowlist handed to buildProjectTools. */
  tools: readonly string[];
  /** The system prompt body under the wrapper (the pre-given playbook). */
  system: string;
}

/** The skill table — the plugin validates the name against these keys. */
export const MINI_SKILLS: Readonly<Record<MiniAgentSkill, (opts?: { instructions?: string }) => MiniSkillSpec>> = {
  browser: () => ({ tools: BROWSER_MINI_TOOLS, system: BROWSER_USE_SKILL_BODY }),
  computer: () => ({ tools: COMPUTER_MINI_TOOLS, system: COMPUTER_USE_SKILL_BODY }),
  search: () => ({ tools: SEARCH_MINI_TOOLS, system: SEARCH_SKILL_BODY }),
  custom: (opts) => ({
    tools: SEARCH_MINI_TOOLS,
    system:
      CUSTOM_SKILL_PREFIX +
      (opts?.instructions !== undefined && opts.instructions.trim() !== ""
        ? opts.instructions.trim()
        : "(no instructions were provided — report blocked with that fact)"),
  }),
};

// ── the wrapper (the mini's identity + report contract) ────────────────────

/**
 * The wrapper that frames every skill body. SHORT by design (the bodies
 * carry the craft); it teaches the three things the owner's directive
 * demands: the ONE-TASK disposable shape (no questions mid-task — the
 * main agent cannot answer them), the small-quick-smart budget, and the
 * REPORT shape (outcome + CURRENT STATE + details — "the main agent will
 * know what happened and what the current state is").
 */
const MINI_WRAPPER = `You are a MINI AGENT — a small, specialized partner dispatched inside the Acute workspace. You get ONE task, run a short loop, report back, and you are done. There is no follow-up: the main agent cannot answer questions mid-task, so include everything you need in your own reasoning.

## Your budget
- You have at most ~8 tool steps. Small, quick, smart: prefer the single decisive call over exploration chains; stop the moment the task is satisfied.
- If the task cannot be finished in the budget, finish what you can and report precisely what remains — never thrash, never loop on the same call.

## Your report (your LAST message, verbatim shape)
## REPORT
OUTCOME: done | blocked | failed — one line why
STATE: the current state the main agent needs to continue (the page URL, the app/window, the file paths — whatever this task's surface is)
DETAILS: what you did, in 2-5 lines

The report is ALL the main agent sees of your work — its quality IS your work.`;

// ── the budgets ─────────────────────────────────────────────────────────────

/** The step ceiling for one mini run (the SDK's internal tool loop). */
export const MINI_MAX_TURNS = 8;
/** The wall-clock ceiling for one mini run (the chat seam's timeout). */
export const MINI_TIMEOUT_MS = 180_000;
/** The output-token cap (a mini report is small; the cap refuses runaway). */
export const MINI_MAX_OUTPUT_TOKENS = 4_000;
/** The temperature — deterministic-ish for quick precise work. */
export const MINI_TEMPERATURE = 0.2;
/** The concurrency cap (the owner: "for starters, let's cap the limit at
 * three… in the future we might increase the limit"). */
export const MINI_AGENT_CAP = 3;

// ── the concurrency cap (module scope = process scope) ─────────────────────

const activeMiniAgents = new Set<string>();

/** The honest busy-refusal message (named after the cap so callers/tests
 * can assert it without stringly coupling). */
export function miniAgentCapMessage(): string {
  return `mini agent limit reached (${MINI_AGENT_CAP} already running) — wait for one to finish before dispatching another`;
}

/** Reserve a slot atomically (check-and-add is indivisible on the single
 * JS thread — the tryReserveSlot law, mini edition). Test-visible. */
export function reserveMiniAgentSlot(miniId: string): boolean {
  if (activeMiniAgents.size >= MINI_AGENT_CAP || activeMiniAgents.has(miniId)) return false;
  activeMiniAgents.add(miniId);
  return true;
}

/** Release a slot (idempotent — a double-release is harmless). */
export function releaseMiniAgentSlot(miniId: string): void {
  activeMiniAgents.delete(miniId);
}

/** How many minis are running right now (test-visible + the done frame). */
export function activeMiniAgentCount(): number {
  return activeMiniAgents.size;
}

// ── the run input/result ────────────────────────────────────────────────────

export interface MiniAgentRunInput {
  skill: MiniAgentSkill;
  task: string;
  /** custom skill only — the main agent's specialty instructions. */
  instructions?: string;
}

export interface MiniAgentModelPair {
  providerId: string;
  modelId: string;
}

export interface MiniAgentRunResult {
  ok: boolean;
  /** The model-facing tool result (the report, or the honest refusal). */
  output: string;
}

/** One action row as it rides the frames + the persisted events. */
export interface MiniAgentActionRecord {
  miniId: string;
  seq: number;
  tool: string;
  argsSummary: string;
  ok: boolean;
  outputSummary: string | null;
}

// ── the model resolution ────────────────────────────────────────────────────

/**
 * Resolve the mini's model: the `orchestration.miniagentModel` setting
 * first (the owner's "the user can select which model the mini agent
 * should use, which provider it should use, or should it use the main
 * one"), else the parent turn's effective pair (toolDeps.mainModel).
 * Returns the provider row + key + model id, or an honest reason.
 */
function resolveMiniModel(
  db: import("better-sqlite3").Database,
  keyring: NonNullable<ToolDeps["keyring"]>,
  parentModel: MiniAgentModelPair | undefined,
): { ok: true; providerId: string; model: string; apiKey: string } | { ok: false; reason: string } {
  const settings = getOrchestrationSettings(db);
  const ref = settings.miniagentModel ?? {
    providerId: parentModel?.providerId ?? "",
    modelId: parentModel?.modelId ?? "",
  };
  if (ref.providerId === "" || ref.modelId === "") {
    return {
      ok: false,
      reason:
        "the mini agent has no model: no miniagentModel is configured and this turn carries no main model pair — set one in Settings (Sub-agents & Mini agents) or retry from a session with a model",
    };
  }
  const provider = resolveProvider(db, ref.providerId);
  if (provider === undefined || provider.baseUrl === null) {
    return {
      ok: false,
      reason: `the mini agent's model references provider '${ref.providerId}' without a usable baseUrl — fix it in Settings → Models & Providers`,
    };
  }
  if (provider.enabled === false) {
    return {
      ok: false,
      reason: `provider '${provider.id}' is disabled — enable it in Settings → Models & Providers before dispatching mini agents`,
    };
  }
  const pool = resolveKeyPool(keyring, provider.id);
  if (pool.length === 0) {
    return {
      ok: false,
      reason: `no API key for provider '${provider.id}' — add one in Settings → Models & Providers`,
    };
  }
  return { ok: true, providerId: provider.id, model: ref.modelId, apiKey: pool[0].key };
}

/**
 * The session's EFFECTIVE ROOT — the same ladder prepareTurn resolves
 * (the Scratchpad's session.rootPath override, else the project's
 * root_path; the R129-S law). The mini's tools build against THIS root.
 */
function miniRootFor(
  db: import("better-sqlite3").Database,
  sessionId: string,
): string | undefined {
  const session = getSession(db, sessionId);
  if (session === undefined) return undefined;
  if (session.rootPath !== null && session.rootPath !== "") return session.rootPath;
  if (session.projectId !== null) return getProject(db, session.projectId)?.rootPath;
  return undefined;
}

// ── the run (the light partner loop) ────────────────────────────────────────

/**
 * Run ONE mini agent to completion. NEVER THROWS — every failure path
 * returns an honest {ok:false, output} (the wrapToolExecute belt exists,
 * but the slot-release finally and the done-frame guarantee live HERE).
 *
 * The frames (emitted on the parent's SSE via toolDeps.emit, mirrored to
 * the events bus by the route's send() wrapper):
 *   {type:"mini-agent.started", miniId, skill, task, model:{providerId,modelId}}
 *   {type:"mini-agent.action",  miniId, seq, tool, argsSummary, ok, outputSummary}
 *   {type:"mini-agent.done",    miniId, ok, result, steps, usage|null}
 * The persisted events (session_events, the fold's source after reload):
 *   mini_agent.started / mini_agent.action / mini_agent.done — same payloads.
 */
export async function runMiniAgent(
  toolDeps: ToolDeps,
  input: MiniAgentRunInput,
): Promise<MiniAgentRunResult> {
  const db = toolDeps.db;
  const sessionId = toolDeps.sessionId;
  const emit = toolDeps.emit;
  // R132-MA: BOTH channels serve the mini — the STREAMED seam (the live
  // SSE turn, frames as they happen) and the SYNC chat fn (the plain
  // message route + channel-less runs: the whole loop lands in one call,
  // the frames/events fire at completion — correct, just not live).
  const chatStream = toolDeps.chatStream as StreamChatFn | undefined;
  const chatSync = toolDeps.chat as ChatFn | undefined;
  const root = miniRootFor(db, sessionId);
  const miniId = `mini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // ── the honest gates (every one returns, never throws) ──
  if (chatStream === undefined && chatSync === undefined) {
    return { ok: false, output: "mini_agent is unavailable on this turn's channel (no chat seam)" };
  }
  // The plugin gates on keyring before dispatching; the belt here keeps
  // runMiniAgent safe for direct/test callers too.
  if (toolDeps.keyring === undefined) {
    return { ok: false, output: "mini_agent needs the provider keyring (no keyring on this turn's deps)" };
  }
  if (root === undefined) {
    return { ok: false, output: "mini_agent needs a project workspace — this session has no project root" };
  }
  if (input.skill !== "browser" && input.skill !== "computer" && input.skill !== "search" && input.skill !== "custom") {
    return { ok: false, output: `mini_agent skill must be browser, computer, search, or custom (got '${String(input.skill)}')` };
  }
  if (input.task.trim() === "") {
    return { ok: false, output: "mini_agent needs a task — the natural-language goal for the mini agent" };
  }
  if (input.skill === "custom" && (input.instructions ?? "").trim() === "") {
    return {
      ok: false,
      output:
        "the custom skill needs instructions — the specialty the mini agent should run with (what it is for, how it should work)",
    };
  }
  if (input.skill === "computer" && getComputerUseSettings(db).enabled !== true) {
    return {
      ok: false,
      output:
        "the computer-use master switch is OFF (Settings → Computer Use) — the computer mini agent cannot run until it is enabled",
    };
  }
  if (!reserveMiniAgentSlot(miniId)) {
    return { ok: false, output: miniAgentCapMessage() };
  }

  // ── the model ──
  const modelResolution = resolveMiniModel(db, toolDeps.keyring, toolDeps.mainModel);
  if (!modelResolution.ok) {
    releaseMiniAgentSlot(miniId);
    return { ok: false, output: modelResolution.reason };
  }

  // ── the persistence + frame helpers (the parent's event log + SSE) ──
  const persist = (type: string, payload: Record<string, unknown>): void => {
    appendSessionEvent(db, sessionId, {
      type,
      agentId: toolDeps.agentId,
      payload,
    });
  };
  const frame = (event: Record<string, unknown>): void => {
    emit?.({ ...event } as unknown);
  };

  const spec = MINI_SKILLS[input.skill]({ instructions: input.instructions });
  const system = `${MINI_WRAPPER}\n\n${spec.system}`;

  // The started frame + event (BEFORE the loop — the section opens with
  // the prompt the main agent gave, live).
  const startedModel = { providerId: modelResolution.providerId, modelId: modelResolution.model };
  frame({ type: "mini-agent.started", miniId, skill: input.skill, task: input.task.trim(), model: startedModel });
  persist("mini_agent.started", { miniId, skill: input.skill, task: input.task.trim(), model: startedModel });

  // ── the loop ──
  let steps = 0;
  let report = "";
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  let outcome: { ok: boolean; output: string } | null = null;

  try {
    const tools = await buildProjectTools(root, spec.tools, toolDeps);
    const providerRow = resolveProvider(db, modelResolution.providerId)!;
    const chatInput = {
      provider: {
        id: modelResolution.providerId,
        // resolveMiniModel already verified baseUrl is non-null.
        baseUrl: providerRow.baseUrl,
      },
      apiKey: modelResolution.apiKey,
      model: modelResolution.model,
      system,
      messages: [{ role: "user" as const, content: input.task.trim() }],
      temperature: MINI_TEMPERATURE,
      maxTurns: MINI_MAX_TURNS,
      timeoutMs: MINI_TIMEOUT_MS,
      maxOutputTokens: MINI_MAX_OUTPUT_TOKENS,
      tools,
      ...(toolDeps.signal !== undefined ? { signal: toolDeps.signal } : {}),
    };

    // One action row per completed tool call (the shared emitter — the
    // frames ride the parent's SSE, the events persist for the fold).
    const recordAction = (toolName: string, argsSummary: string, ok: boolean, outputSummary: string | undefined): void => {
      steps += 1;
      const action: MiniAgentActionRecord = {
        miniId,
        seq: steps,
        tool: toolName,
        argsSummary,
        ok,
        outputSummary:
          outputSummary !== undefined && outputSummary !== ""
            ? outputSummary.length > 400
              ? `${outputSummary.slice(0, 400)}…`
              : outputSummary
            : null,
      };
      frame({ type: "mini-agent.action", ...action });
      persist("mini_agent.action", { ...action });
    };

    if (chatStream !== undefined) {
      // ── the STREAMED channel: frames as they happen ──
      for await (const event of chatStream(chatInput)) {
        if (event.type === "text-delta") {
          report += event.delta;
        } else if (event.type === "tool-result") {
          recordAction(event.toolName, event.argsSummary, event.ok, event.outputSummary);
        } else if (event.type === "finish") {
          // The finish frame's usage is the CONTEXT truth (the newest step's
          // own request) — for a mini's small loop the billing delta is the
          // same magnitude; record the finish usage as the run's spend.
          usage = { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens };
        }
        // thinking-delta / tool-input-* / tool-call are observed but not
        // forwarded: the section shows completed ACTIONS + the report (the
        // main pill's liveness covers the in-flight window).
      }
    } else {
      // ── the SYNC channel: the whole loop lands in ONE call ──
      const result = await chatSync!(chatInput);
      report = result.text;
      for (const call of result.toolCalls) {
        recordAction(call.name, call.argsSummary, call.ok, call.outputSummary);
      }
      usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      };
    }

    // ── the result to the MAIN model ──
    const cleanReport = report.trim();
    if (cleanReport === "") {
      outcome = {
        ok: false,
        output:
          `the mini agent (${input.skill}) ran ${steps} tool step${steps === 1 ? "" : "s"} but ended without a final report ` +
          "(its step budget may have run out mid-task) — dispatch it again with a tighter goal, or do the task directly",
      };
    } else {
      const header = `mini agent (${input.skill}) — ${steps} step${steps === 1 ? "" : "s"}${usage !== null ? `, ${usage.inputTokens + usage.outputTokens} tokens` : ""}:\n\n`;
      outcome = { ok: true, output: `${header}${cleanReport}` };
    }
  } catch (error) {
    // Honest failures: abort (the parent's Stop cascades), timeout, provider
    // errors. The slot releases in the finally below regardless.
    const aborted = toolDeps.signal?.aborted === true;
    const message = error instanceof Error ? error.message : String(error);
    outcome = {
      ok: false,
      output: aborted
        ? `the mini agent (${input.skill}) was stopped with the turn`
        : `the mini agent (${input.skill}) failed: ${message}`,
    };
  } finally {
    releaseMiniAgentSlot(miniId);
  }

  // ── the done frame + event + usage row ──
  const result = outcome ?? { ok: false, output: `the mini agent (${input.skill}) ended without an outcome` };
  frame({
    type: "mini-agent.done",
    miniId,
    ok: result.ok,
    result: result.output,
    steps,
    usage,
  });
  persist("mini_agent.done", { miniId, ok: result.ok, result: result.output, steps, usage });
  if (usage !== null) {
    recordUsage(
      db,
      {
        agentId: toolDeps.agentId,
        sessionId,
        provider: modelResolution.providerId,
        model: modelResolution.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: computeCost(db, modelResolution.providerId, modelResolution.model, usage.inputTokens, usage.outputTokens),
        ts: new Date().toISOString(),
      },
      0,
      { providerCalls: 1, origin: "mini-agent" },
    );
  }
  return result;
}
