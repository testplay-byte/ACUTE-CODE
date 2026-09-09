/**
 * Thin adapter over the Vercel AI SDK. The runtime depends only on the ChatFn
 * shape, so tests drive turns with a stub (or a module mock of "ai") instead
 * of the network, and this module is the single place that knows SDK types.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import type { ThinkingLevel } from "shared";

export interface ChatTurnMessage {
  role: "user" | "assistant";
  content: string;
}

/** ROUND-37 (owner: "he can select the API format… so that he can add any
 * kind of custom API provider as he wishes"): the wire protocol a provider
 * speaks, stored on the provider row and selectable in Settings. */
export type ApiFormat = "chat-completions" | "anthropic-messages" | "responses";

export interface ChatTurnInput {
  provider: { id: string; baseUrl: string | null; apiFormat?: string };
  apiKey: string;
  model: string;
  system: string;
  messages: ChatTurnMessage[];
  temperature: number;
  maxTurns: number;
  /** Agentic Coding MVP: project file tools (list/read/write/edit) when the session has a project. */
  tools?: ToolSet;
  /** ROUND-48 (R48-e1, stretch): LIVE per-step notification. generateText can
   * run maxTurns internal tool round-trips in ONE call; without this hook the
   * caller (runSingleAgentTurn forwarding sub-agent events to the parent's
   * SSE) sees nothing until the whole call completes. The adapter invokes the
   * callback once per finished step with a normalized snapshot — the same
   * tool-call summary conversion the post-call extractToolCalls() uses.
   * Purely informational; the caller's persistence ordering is unchanged. */
  onStepFinish?: (step: ChatStepSnapshot) => void;
  /** ROUND-46 (R46 live-battery find): hard ceiling for ONE provider call.
   * A stalled provider connection used to hang the turn forever — the
   * session stayed "running" indefinitely and the outer loop never
   * returned. Defaults to PROVIDER_CALL_TIMEOUT_MS. */
  timeoutMs?: number;
  /** ROUND-50 (R50-c1, the composer's thinking-level selector): per-send
   * reasoning-effort hint. For the chat-completions format a non-default
   * level wraps the provider fetch to inject `"reasoning": { "effort": … }`
   * into the outgoing JSON body (see buildThinkingFetch); the
   * anthropic-messages and responses formats silently skip it (honest
   * limitation — those wire formats have no equivalent passthrough wired
   * here yet). NOT persisted; sub-agents never inherit it. */
  thinkingLevel?: ThinkingLevel;
}

/** Round-46: 10 minutes per provider call — generous enough for slow
 * free-tier generations with many tool round-trips, bounded enough that a
 * dead connection aborts into the normal error path (turn.error + status
 * reset + retryable 502) instead of hanging the session forever. */
export const PROVIDER_CALL_TIMEOUT_MS = 600_000;

/** Resolve the provider's wire format (unknown/absent → chat-completions). */
export function resolveApiFormat(raw: string | undefined): ApiFormat {
  return raw === "anthropic-messages" || raw === "responses" ? raw : "chat-completions";
}

/**
 * ROUND-37: build the LanguageModel for the provider's selected API format.
 * All three formats support tools + multi-step via the AI SDK's shared core;
 * the branch exists only at client construction. Anthropic-messages and
 * responses are wired + unit-tested but live-untested (no keys) — honest
 * limitation, documented in IMPLEMENTED-API.md.
 */
/** ROUND-43: builds the fetch wrapper that rewrites single-model OpenRouter
 * requests into a `models` fallback array (see buildModel). Exported for tests. */
export function buildModelFallbackFetch(): (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  return async (url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (typeof body.model === "string" && Array.isArray(body.models) === false) {
          body.models = [body.model, "openrouter/free"];
          delete body.model;
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        // not JSON — pass through untouched
      }
    }
    return fetch(url, init);
  };
}

/**
 * ROUND-50 (R50-c1, the composer's thinking-level selector): builds the
 * fetch wrapper that injects `"reasoning": { "effort": <level> }` into the
 * outgoing chat-completions JSON body (the OpenRouter/OpenAI
 * reasoning-effort knob). Mirrors the buildModelFallbackFetch pattern: parse
 * the body only when it is a non-empty JSON string, MERGE with any existing
 * `reasoning` object (never clobber provider-set fields), and pass everything
 * else through untouched. Non-JSON bodies are forwarded verbatim.
 *
 * `inner` lets the OpenRouter free-model fallback wrapper compose UNDER this
 * one (thinking decides the effort, fallback decides the model chain) —
 * otherwise the global fetch is used. Exported for tests.
 */
export function buildThinkingFetch(
  level: ThinkingLevel,
  inner?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const reasoning =
          typeof body.reasoning === "object" && body.reasoning !== null
            ? (body.reasoning as Record<string, unknown>)
            : {};
        body.reasoning = { ...reasoning, effort: level };
        init = { ...init, body: JSON.stringify(body) };
      } catch {
        // not JSON — pass through untouched
      }
    }
    return inner !== undefined ? inner(url, init) : fetch(url, init);
  };
}

function buildModel(input: ChatTurnInput): LanguageModel {
  const format = resolveApiFormat(input.provider.apiFormat);
  if (format === "anthropic-messages") {
    const anthropic = createAnthropic({
      baseURL: input.provider.baseUrl ?? undefined,
      apiKey: input.apiKey,
    });
    return anthropic(input.model);
  }
  if (format === "responses") {
    const openai = createOpenAI({
      baseURL: input.provider.baseUrl ?? undefined,
      apiKey: input.apiKey,
    });
    return openai.responses(input.model);
  }
  const provider = createOpenAICompatible({
    name: input.provider.id,
    baseURL: input.provider.baseUrl ?? "",
    apiKey: input.apiKey,
    includeUsage: true,
    // ROUND-43: free OpenRouter models rate-limit hard at peak (owner's live
    // battery hit 429s across keys within seconds). OpenRouter natively
    // supports a `models` fallback array — when the turn targets a :free
    // model we rewrite the request body to [model, openrouter/free] so the
    // provider-side router transparently retries other free models before
    // the call fails. The meta-router itself rotates across all free models,
    // so a two-entry chain is enough. Non-JSON bodies pass through untouched.
    //
    // ROUND-50 (R50-c1): the composer's thinking level composes ON TOP (the
    // thinking wrapper runs first, then hands off to the fallback wrapper) —
    // both rewrite the same JSON body and are chat-completions-only; the
    // anthropic-messages/responses formats above silently skip the level
    // (no reasoning-effort passthrough wired there — honest limitation).
    ...((() => {
      const fallbackFetch =
        input.provider.id === "openrouter" &&
        input.model.endsWith(":free") &&
        input.model !== "openrouter/free"
          ? buildModelFallbackFetch()
          : undefined;
      const level = input.thinkingLevel;
      if (level !== undefined && level !== "default") {
        return { fetch: buildThinkingFetch(level, fallbackFetch) };
      }
      return fallbackFetch !== undefined ? { fetch: fallbackFetch } : {};
    })()),
  });
  return provider.chatModel(input.model);
}

export interface ChatToolCall {
  name: string;
  argsSummary: string;
  ok: boolean;
  /** Round-34: compact model-facing output summary (persisted for history). */
  outputSummary?: string;
}

/** ROUND-48 (R48-e1, stretch): one finished generateText step, normalized —
 * `text` is the step's own text ("" when the step only called tools) and
 * `toolCalls` are the step's executed tool calls summarized exactly like the
 * post-call list (extractToolCalls). The runtime forwards these as live
 * tool-call/tool-result/text-delta events while the call is still running. */
export interface ChatStepSnapshot {
  text: string;
  toolCalls: ChatToolCall[];
}

export interface ChatTurnOutput {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** ROUND-50 (R50-c1): prompt tokens served from the provider cache
     * (AI SDK v7 usage.inputTokenDetails.cacheReadTokens — OpenRouter maps
     * prompt_tokens_details.cached_tokens into it). Undefined when the
     * provider didn't report a cached tier. */
    cachedInputTokens?: number;
  };
  /** Executed tool calls in order (empty when no tools were provided/used). */
  toolCalls: ChatToolCall[];
}

export type ChatFn = (input: ChatTurnInput) => Promise<ChatTurnOutput>;

/** The production ChatFn: format-branched via the AI SDK, agentic tools when given. */
export const aiSdkChat: ChatFn = async (input) => {
  const result = await generateText({
    model: buildModel(input),
    // ROUND-50 (owner's third Windows test: a rate-limited sub-agent run
    // "failed after three attempts" — that is the AI SDK's DEFAULT
    // maxRetries: 2, i.e. 3 total attempts). The owner wants at least five
    // attempts: maxRetries: 4 = 1 initial + 4 retries with the SDK's
    // exponential backoff (OpenRouter 429s clear within seconds).
    maxRetries: 4,
    system: input.system === "" ? undefined : input.system,
    messages: input.messages,
    temperature: input.temperature,
    // Multi-step agentic loop: each tool round-trip is one step.
    stopWhen: stepCountIs(Math.max(1, input.maxTurns)),
    // ROUND-46: bounded — a stalled connection aborts into the turn-error
    // path instead of hanging the session at "running" forever.
    abortSignal: AbortSignal.timeout(input.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    // ROUND-48 (R48-e1, stretch): per-step live notification passthrough —
    // generateText calls it once per finished step (tool round-trip). The
    // step is normalized through the same extractToolCalls conversion the
    // post-call audit list uses, so live events and persisted events carry
    // identical summaries.
    ...(input.onStepFinish !== undefined
      ? {
          onStepFinish: (step: { text?: unknown; toolResults?: unknown }) => {
            input.onStepFinish!({
              text: typeof step.text === "string" ? step.text : "",
              toolCalls: extractToolCalls([step]),
            });
          },
        }
      : {}),
  });
  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  // ROUND-50 (R50-c1): cached prompt tokens — the openai-compatible provider
  // maps OpenRouter's prompt_tokens_details.cached_tokens here; other
  // providers leave it undefined (the usage row then stores NULL).
  const cachedInputTokens = result.usage.inputTokenDetails?.cacheReadTokens;
  return {
    text: result.text,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: result.usage.totalTokens ?? inputTokens + outputTokens,
      ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
    },
    toolCalls: extractToolCalls(result.steps),
  };
};

/** Flatten per-step tool results into an ordered audit list for the event log. */
function extractToolCalls(steps: Array<unknown>): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  if (!Array.isArray(steps)) return calls;
  for (const step of steps) {
    const responses = (step as { toolResults?: Array<{ toolName?: unknown; input?: unknown; output?: unknown }> })
      .toolResults;
    if (!Array.isArray(responses)) continue;
    for (const r of responses) {
      if (typeof r.toolName !== "string") continue;
      calls.push({
        name: r.toolName,
        argsSummary: summarizeArgs(r.input),
        ok:
          typeof r.output === "object" && r.output !== null && "ok" in r.output
            ? Boolean((r.output as { ok: unknown }).ok)
            : true,
        outputSummary: summarizeToolOutput(r.output, r.toolName),
      });
    }
  }
  return calls;
}

/**
 * ROUND-34 (Cline-pattern tool feedback): compact, model-facing summary of a
 * tool's OUTPUT. Head+tail truncation keeps the informative ends (test/build
 * errors live at the END of command output); the raw string is truncated
 * BEFORE wrapping so the result stays valid. Secrets (keyring-held API keys,
 * sk-… patterns) are scrubbed — run_command inherits process.env which holds
 * ACUTE_PROVIDER_* values.
 *
 * ROUND-70 (R70-b, D3): STICKY RESULT TOOLS. read_skill and memory_recall
 * results are INSTRUCTIONS/durable facts, not data — they must survive the
 * whole task (the outer loop replays them every iteration; stubbing the
 * loaded skill body mid-task made the model drop its own procedure). Those
 * two tools get STICKY_OUTPUT_BUDGET instead of the 4000-char head+tail
 * budget at BOTH call sites below (this is the persistence-side half of the
 * fix; runtime.ts assembleHistory is the replay-side half). Both sources are
 * already bounded upstream (read_skill caps its output at 60K,
 * memory_recall returns a handful of facts), so the larger budget cannot
 * make the event log unbounded.
 */
export const STICKY_RESULT_TOOLS: readonly string[] = ["read_skill", "memory_recall"];

export function isStickyResultTool(toolName: string): boolean {
  return STICKY_RESULT_TOOLS.includes(toolName);
}

const STICKY_OUTPUT_BUDGET = 60_000;

export function summarizeToolOutput(output: unknown, toolName?: string): string {
  let text: string;
  if (typeof output === "string") {
    text = output;
  } else if (
    typeof output === "object" &&
    output !== null &&
    "output" in output &&
    typeof (output as { output: unknown }).output === "string"
  ) {
    text = (output as { output: string }).output;
  } else {
    try {
      text = JSON.stringify(output) ?? "";
    } catch {
      text = String(output);
    }
  }
  // Scrub obvious secret shapes (defense-in-depth; the runtime scrubs
  // keyring values too, but this guard lives at the source).
  text = text.replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-***");
  text = text.replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***");
  // ROUND-80 (R80): the NVIDIA NIM key prefix (nvapi-…) joins the
  // pattern scrub — run_command output and tool summaries must never leak it.
  text = text.replace(/nvapi-[A-Za-z0-9_-]{16,}/g, "nvapi-***");
  // Head+tail budget: command/read outputs keep 2000 head + 2000 tail chars.
  // Sticky tools (R70-b D3) keep a 60K budget instead — see the header.
  const budget = toolName !== undefined && isStickyResultTool(toolName) ? STICKY_OUTPUT_BUDGET : 4000;
  if (text.length > budget) {
    const head = text.slice(0, budget / 2);
    const tail = text.slice(-budget / 2);
    const omitted = text.length - budget;
    text = `${head}\n…[truncated ${omitted} chars]…\n${tail}`;
  }
  return text;
}

/** Compact, log-safe argument summary (paths yes; full file contents no). */
function summarizeArgs(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const args = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    if ((key === "content" || key === "newString") && value.length > 0) {
      parts.push(`${key}: ${value.length} chars`);
      continue;
    }
    parts.push(`${key}: ${value.length > 80 ? `${value.slice(0, 80)}…` : value}`);
  }
  return parts.join(", ");
}


// ─────────────────────────────────────────────────────────────────────────────
// Streaming variant (round-16: live responses in the chat UI)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalized streaming event — the runtime/SSE layer never sees SDK types. */
export type StreamChatEvent =
  | { type: "text-delta"; delta: string }
  /** ROUND-35 (owner: "implement thinking functionality… shown separately in
   * a dialed-out tone"): reasoning/thinking tokens from reasoning models,
   * streamed separately from the visible answer. */
  | { type: "thinking-delta"; delta: string }
  /** ROUND-58 (R58-c): the model started streaming a tool call's ARGUMENTS
   * (AI SDK v7 `tool-input-start`). Forwarded so the UI can render a live
   * "writing file…" preview while the model is still generating the JSON —
   * previously nothing appeared until the whole arg object arrived. */
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  /** ROUND-58 (R58-c): one text chunk of a tool call's streamed JSON
   * arguments (AI SDK v7 `tool-input-delta`). The client accumulates these
   * per toolCallId and renders the partial file content as it grows. */
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool-call"; toolName: string; argsSummary: string }
  | { type: "tool-result"; toolName: string; argsSummary: string; ok: boolean; outputSummary?: string }
  | {
      type: "finish";
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      /** ROUND-50 (R50-c1): prompt tokens served from the provider cache
       * (usage.inputTokenDetails.cacheReadTokens on the finish-step/total
       * usage). 0 when absent — the runtime accumulates it into the turn's
       * usage_events row for the context meter's cache-hit-rate line. */
      cachedInputTokens?: number;
    };

export interface StreamChatInput extends ChatTurnInput {
  signal?: AbortSignal;
}

export type StreamChatFn = (input: StreamChatInput) => AsyncGenerator<StreamChatEvent>;

/**
 * Production streaming adapter: streamText over the same openai-compatible
 * provider, multi-step (tool round-trips) like generateText. fullStream parts
 * are normalized; usage = awaited totals CROSS-CHECKED against per-step
 * finish usage sums (some provider streams report usage only per step, and
 * totalUsage can resolve empty — take the larger of the two sources).
 */
export const streamAiSdkChat: StreamChatFn = async function* (input) {
  // ROUND-46: the same per-call ceiling as the sync path, combined with the
  // caller's abort (client Stop / session signal) — whichever fires first.
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS);
  const callSignal =
    input.signal !== undefined ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const result = streamText({
    model: buildModel(input),
    // ROUND-50: same retry policy as generateText above (see the comment
    // there) — the owner's "failed after three attempts" hit the STREAMED
    // main-agent path just as hard as the sync sub-agent path.
    maxRetries: 4,
    system: input.system === "" ? undefined : input.system,
    messages: input.messages,
    temperature: input.temperature,
    stopWhen: stepCountIs(Math.max(1, input.maxTurns)),
    abortSignal: callSignal,
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
  });

  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let stepInput = 0;
  let stepOutput = 0;
  // ROUND-50 (R50-c1): cached prompt tokens — summed from per-step finish
  // usage and cross-checked against the awaited totals exactly like the
  // input/output token counts (some providers report only one of the two).
  let stepCached = 0;
  // ROUND-80 (R80, owner: "the chat ends without any error message or
  // anything some times"): the silent-truncation witnesses. A HEALTHY
  // provider stream always carries at least one finish-step part (the
  // chat-completions finish_reason mapped by the SDK — one per step); a
  // provider/proxy that closes the SSE connection CLEANLY mid-generation
  // ends the for-await with NO error part and NO finish-step — the old
  // adapter synthesized a finish below, the runtime treated the truncated
  // text as a complete conversational reply, and the chat just stopped with
  // no error. Zero finish-steps + content deltas streamed = truncation.
  let stepFinishCount = 0;
  let sawContentDelta = false;
  for await (const part of result.fullStream) {
    // ROUND-75 (R75, the live 429 find): the SDK surfaces mid-stream
    // failures — provider errors AFTER its internal retries (429 rate
    // limits, 5xx, timeouts) — as ERROR PARTS on the fullStream, not
    // iterator throws (agentic steps with tools especially). The parts
    // were silently skipped here, so the only error the runtime ever saw
    // was the generic NoOutputGenerated rejection at the totals await
    // below — "Check the stream for errors", no status, no message
    // patterns → class unknown → NO retry ladder on REAL rate limits
    // (exactly the "stops halfway, no error class" failure the owner
    // reported). Re-throw the ORIGINAL error: the runtime's classifier
    // sees the true shape (APICallError{statusCode}/RetryError with the
    // provider text) and the transient-API ladder engages for real.
    if (part.type === "error") {
      throw (part as { error: unknown }).error;
    }
    if (part.type === "text-delta") {
      sawContentDelta = true;
      yield { type: "text-delta", delta: part.text };
    } else if (part.type === "reasoning-delta") {
      sawContentDelta = true;
      // ROUND-35: thinking tokens stream as a separate channel so the UI can
      // render them in a muted, collapsible block apart from the answer.
      yield { type: "thinking-delta", delta: part.text };
    } else if (part.type === "tool-input-start") {
      sawContentDelta = true;
      // ROUND-58 (R58-c): the model started generating a tool call's JSON
      // arguments — emit immediately so the UI can open a live preview row.
      // (fullStream part shape: {id, toolName} — normalized to toolCallId
      // here so nothing downstream sees SDK types.)
      yield { type: "tool-input-start", toolCallId: part.id, toolName: part.toolName };
    } else if (part.type === "tool-input-delta") {
      // ROUND-58 (R58-c): a chunk of the streamed JSON arguments — forwarded
      // verbatim; the client accumulates per toolCallId. (fullStream part
      // shape: {id, delta}.)
      yield {
        type: "tool-input-delta",
        toolCallId: part.id,
        inputTextDelta: part.delta,
      };
    } else if (part.type === "tool-call") {
      const argsSummary = summarizeArgs(part.input);
      yield { type: "tool-call", toolName: part.toolName, argsSummary };
    } else if (part.type === "tool-result") {
      const output = part.output as unknown;
      const ok =
        typeof output === "object" && output !== null && "ok" in output
          ? Boolean((output as { ok: unknown }).ok)
          : true;
      yield {
        type: "tool-result",
        toolName: part.toolName,
        argsSummary: summarizeArgs(part.input),
        ok,
        outputSummary: summarizeToolOutput(part.output, part.toolName),
      };
    } else if (part.type === "finish-step") {
      stepFinishCount += 1;
      const stepUsage = (part as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
      if (stepUsage) {
        stepInput += stepUsage.inputTokens ?? 0;
        stepOutput += stepUsage.outputTokens ?? 0;
        stepCached +=
          (part as { usage?: { inputTokenDetails?: { cacheReadTokens?: number } } }).usage
            ?.inputTokenDetails?.cacheReadTokens ?? 0;
      }
    }
  }
  // ROUND-80 (R80): the silent-truncation guard — zero finish-step parts
  // while content deltas streamed means the provider closed the stream
  // mid-response without an error part (the clean-close drop). Throw the
  // honest truncation error INSTEAD of synthesizing a finish: the runtime's
  // classifier reads it as `network` (transient → the retry ladder can
  // wait it out), the partial text is preserved by the R75 flush, and the
  // owner sees a real error card instead of a chat that just stops.
  // Conservative by design: only fires when content WAS streaming (a
  // contentless empty stream stays on the existing NoOutputGenerated /
  // R77 NO_OUTPUT paths — no false positives on legitimately-empty replies).
  if (stepFinishCount === 0 && sawContentDelta) {
    throw new Error(
      "provider stream ended without a finish signal — the connection closed mid-response (truncated output)",
    );
  }
  const totals = (await result.totalUsage) ?? (await result.usage);
  usage.inputTokens = Math.max(totals.inputTokens ?? 0, stepInput);
  usage.outputTokens = Math.max(totals.outputTokens ?? 0, stepOutput);
  usage.totalTokens = totals.totalTokens ?? usage.inputTokens + usage.outputTokens;
  // Same larger-of-the-two-sources rule as the token counts above.
  const cachedInputTokens = Math.max(
    totals.inputTokenDetails?.cacheReadTokens ?? 0,
    stepCached,
  );
  yield { type: "finish", usage, cachedInputTokens };
};
