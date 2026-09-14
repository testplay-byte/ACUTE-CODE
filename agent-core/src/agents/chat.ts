/**
 * Thin adapter over the Vercel AI SDK. The runtime depends only on the ChatFn
 * shape, so tests drive turns with a stub (or a module mock of "ai") instead
 * of the network, and this module is the single place that knows SDK types.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type {
  MessageAttachment,
  ModelReasoningSupport,
  ReasoningEffortLevel,
  ThinkingLevel,
} from "shared";
import { scrubSecretShapes } from "../lib/secret-shapes.js";

export interface ChatTurnMessage {
  role: "user" | "assistant";
  content: string;
}

/** ROUND-37 (owner: "he can select the API format… so that he can add any
 * kind of custom API provider as he wishes"): the wire protocol a provider
 * speaks, stored on the provider row and selectable in Settings. */
export type ApiFormat = "chat-completions" | "anthropic-messages" | "responses";

/** ROUND-94 (R94-D1, the owner's v0.91.0 field report: "the queued message
 * appeared right after the ORIGINAL message — wrong position and wrong
 * timing"): ONE claimed queue entry, handed to the adapter at a tool-call
 * boundary for mid-turn injection. The shape is the queue storage's payload
 * exactly ({content, attachments?} — what appendQueuedMessage persisted), so
 * the runtime's claim callback stays a plain pass-through of the storage row
 * (the claim/delete/persist/frame mechanics live with it in runtime.ts; the
 * adapter only decides WHEN a boundary is injectable and HOW the model sees
 * the message). */
export interface QueuedStepMessage {
  content: string;
  attachments?: MessageAttachment[];
}

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
   * here yet). NOT persisted; sub-agents never inherit it.
   *
   * ROUND-95 (R95-E): "medium" joins the vocabulary for models whose
   * detected ladder tops out below high (see reasoningSupport). */
  thinkingLevel?: ThinkingLevel;
  /** ROUND-96 (R96-J, the live-fire catch #2): the model's configured output
   * cap (resolveTurnBudget's maxOutputTokens — the row, the catalog, or the
   * 32K default). Rides the wire as `max_tokens` when the SDK call sends
   * none (OpenRouter prices an unspecified cap at the model's FULL default
   * — the paid-model credits rejection; see buildOutputCapFetch). */
  maxOutputTokens?: number;
  /** ROUND-95 (R95-E, THE R95-B E-CONTRACT): the model's DETECTED reasoning
   * capability (resolveModelReasoningSupport — migration 0035's
   * reasoning_support blob). Absent OR null = UNKNOWN — byte-identical R50
   * behavior (the level injects verbatim, never blocked on a guess).
   * `{supported: false}` → NO reasoning injected at all (the model takes no
   * reasoning parameter — injecting one is a 400 waiting to happen).
   * `{supported: true, efforts}` → the level maps onto the model's own
   * effort ladder + a per-level reasoning.max_tokens budget (see
   * buildThinkingFetch). */
  reasoningSupport?: ModelReasoningSupport | null;
  /** ROUND-94 (R94-D1): mid-turn QUEUED-MESSAGE injection. When set, the
   * adapter wires a prepareStep into the SDK call; at every STEP boundary
   * where the PRIOR step completed a tool call (the owner's contract: after
   * a tool call completes, never between two text-only steps) it calls this
   * ONCE — a returned entry is appended to the model-facing messages for
   * the upcoming step (and carries forward to the SDK's later steps per the
   * AI SDK 7 prepareStep contract); null means "nothing queued, no override"
   * and leaves the call byte-identical to a prepareStep-less one. Absent
   * entirely (every existing caller + every test stub) → prepareStep is not
   * passed to the SDK at all. */
  consumeQueuedForStep?: () => QueuedStepMessage | null;
  /** ROUND-97 (R97-D, owner: "give the user the option in the settings to
   * turn it on or off. By default it will be turned off"): the thinking-loop
   * guard's ARMING config, threaded by the runtime from
   * getThinkingLoopSettings. `enabled: false` (the default) → NO watchdog at
   * all — the model thinks as long as it needs to; `enabled: true` → the
   * R95-E stall watchdog runs with THESE thresholds (stallMs +
   * reasoningBytes, the conjunction). Absent → the same default-off
   * behavior (the runtime always passes it on the streamed path; tests
   * control it explicitly). */
  thinkingLoop?: { enabled: boolean; stallMs: number; reasoningBytes: number };
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

/** ROUND-96 (R96-J, the live-fire catch): the OpenRouter APP ATTRIBUTION
 * headers ride EVERY outbound chat-completions call. OpenRouter's docs ask
 * apps to identify themselves (X-Title + HTTP-Referer), and some publishers
 * GATE their models on it — the live-fire's thinkingmachines/inkling-small:free
 * (the only free max-ladder model) answered "is only available on agentic
 * harnesses. Try plugging it into a coding agent or productivity app listed
 * on openrouter.ai/apps" until the headers identified us. Harmless for other
 * OpenAI-compatible providers (informational headers are ignored), and it
 * is the honest thing a well-behaved OpenRouter app does anyway. Exported
 * for tests. */
export const APP_ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = {
  "X-Title": "ACUTE-CODE",
  "HTTP-Referer": "https://github.com/testplay-byte/ACUTE-CODE",
};

export function withAppAttribution(
  inner: ((url: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined,
): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? undefined);
    for (const [key, value] of Object.entries(APP_ATTRIBUTION_HEADERS)) {
      if (headers.has(key) === false) headers.set(key, value);
    }
    const nextInit = { ...(init ?? {}), headers };
    return inner !== undefined ? inner(url, nextInit) : fetch(url, nextInit);
  };
}

/** ROUND-96 (R96-J, the live-fire catch #2): builds the fetch wrapper that
 * injects the model's configured `max_tokens` onto the wire when the SDK
 * call sends none. OpenRouter PRICES an unspecified max_tokens at the
 * MODEL'S FULL default output ceiling — the live deepseek-v4.1-flash call
 * (effort 'max', no max_tokens) was rejected with "This request requires
 * more credits, or fewer max_tokens. You requested up to 131072 tokens, but
 * can only afford 22738" even though a one-word reply needed a few hundred.
 * Safety rules: a provider-set max_tokens is NEVER overwritten, and a body
 * carrying `reasoning.max_tokens` (the ladder-less thinking budget — the
 * R95 live-verified shape, lesson #96's XOR territory) is left ALONE.
 * Non-JSON bodies pass through untouched. Exported for tests. */
export function buildOutputCapFetch(
  maxOutputTokens: number,
  inner?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (url: string | URL | Request, init?: RequestInit) => {
    let nextInit = init;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const reasoning =
          typeof body.reasoning === "object" && body.reasoning !== null
            ? (body.reasoning as { max_tokens?: unknown })
            : null;
        if (
          typeof body.max_tokens !== "number" &&
          (reasoning === null || reasoning.max_tokens === undefined)
        ) {
          body.max_tokens = maxOutputTokens;
          nextInit = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        // not JSON — pass through untouched
      }
    }
    return inner !== undefined ? inner(url, nextInit) : fetch(url, nextInit);
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
 *
 * ROUND-95 (R95-E, the owner: "The reasoning level… was supposed to be
 * model-specific… Our program should be able to properly detect the models'
 * thinking options"): the wrapper is now CAPABILITY-AWARE via `support`
 * (ChatTurnInput.reasoningSupport — the R95-B storage contract):
 *
 *  · support null/absent (UNKNOWN — never block on a guess): the R50
 *    behavior byte-for-byte — `reasoning.effort = level` verbatim, no
 *    budget. Non-OpenRouter providers and undetected rows keep exactly
 *    what they had.
 *  · support.supported === false: NOTHING is injected — the catalog says
 *    this model takes no reasoning parameter, so sending one is a provider
 *    400 waiting to happen (the level is skipped entirely).
 *  · support.supported === true: the level maps onto the model's OWN effort
 *    ladder (mapThinkingLevelToEffort — the chosen rung rides VERBATIM when
 *    the ladder holds it, else it STEPS DOWN to the nearest supported rung
 *    at-or-below; never up, never a 400). The per-level reasoning.max_tokens
 *    BUDGET rides only for ladder-less reasoning models (see the live-fire
 *    correction note inside — OpenRouter refuses effort + max_tokens
 *    TOGETHER). Both merge into any existing reasoning object; a
 *    provider-set max_tokens is never overwritten.
 *
 * ROUND-96 (R96-F, the owner: "I tested a model which supported high and
 * max but it apparently did not detect that properly and was showing the
 * default options"): the ladder vocabulary is the WIDER six-rung one —
 * a ['max','high','low'] model (deepseek-v4.1-flash, live 2026-09-13) now
 * receives reasoning.effort "max" VERBATIM on a Max pick, and an
 * ['xhigh','high'] model receives "xhigh" (a Max pick steps down, a
 * stored X-High pick rides verbatim). The R95 fold sent both to "high",
 * which was the owner's exact report. defaultEffort
 * (ModelReasoningSupport.defaultEffort) rides the support blob for the
 * UI's honesty note only — a "Default" pick still injects NOTHING (the
 * provider applies its own published default).
 */
export function buildThinkingFetch(
  level: ThinkingLevel,
  support?: ModelReasoningSupport | null,
  inner?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (url: string | URL | Request, init?: RequestInit) => {
    // R95-E: the supported:false gate lives INSIDE the wrapper too (the
    // buildModel call site already refuses to wrap at all in that case —
    // this is the belt to that brace, so a direct test/harness call can
    // never smuggle a reasoning parameter into a non-reasoning model).
    if (
      typeof init?.body === "string" &&
      init.body.length > 0 &&
      level !== "default" &&
      support?.supported !== false
    ) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const reasoning =
          typeof body.reasoning === "object" && body.reasoning !== null
            ? (body.reasoning as Record<string, unknown>)
            : {};
        // ROUND-95 (R95-E + the R95-G live-fire correction): OpenRouter
        // REJECTS a request carrying BOTH reasoning.effort and
        // reasoning.max_tokens ("Only one of reasoning.effort and
        // reasoning.max_tokens can be specified" — proven against the real
        // API with nvidia/nemotron-3-super). The two knobs are MUTUALLY
        // EXCLUSIVE by design:
        //   · UNKNOWN support (null/absent — never block on a guess) → the
        //     R50 wire shape: effort verbatim, no budget;
        //   · supported + a detected effort ladder → the level MAPPED onto
        //     the ladder (effort only — the thinking-loop watchdog covers
        //     runaway reasoning);
        //   · supported but NO ladder (the plain reasoning-only catalog
        //     entries, e.g. nemotron-3.5-lightning) → the max_tokens BUDGET
        //     only (the sole bound available for ladder-less reasoning);
        //   · supported:false → nothing (gated above).
        // A provider-set max_tokens always wins over ours in every branch.
        const efforts = support?.supported === true ? support.efforts : [];
        const hasLadder = efforts.length > 0;
        const effort: string | undefined =
          support?.supported !== true || hasLadder
            ? hasLadder
              ? mapThinkingLevelToEffort(level, efforts)
              : level
            : undefined;
        const budget =
          support?.supported === true && !hasLadder ? REASONING_BUDGET_BY_LEVEL[level] : undefined;
        body.reasoning = {
          ...reasoning,
          ...(effort !== undefined ? { effort } : {}),
          ...(reasoning.max_tokens === undefined && budget !== undefined ? { max_tokens: budget } : {}),
        };
        init = { ...init, body: JSON.stringify(body) };
      } catch {
        // not JSON — pass through untouched
      }
    }
    return inner !== undefined ? inner(url, init) : fetch(url, init);
  };
}

/** ROUND-95 (R95-E): the shared effort ladder's rank (lowest → highest) —
 * the ordering mapThinkingLevelToEffort walks. Mirrors REASONING_EFFORT_LEVELS
 * in shared/src (kept local: shared stays types-only). ROUND-96 (R96-F):
 * "xhigh" and "max" join as REAL rungs — a detected ['max','high','low']
 * ladder keeps its own top; nothing folds down anymore. */
const EFFORT_RANK: Record<ReasoningEffortLevel, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/**
 * ROUND-95 (R95-E) → ROUND-96 (R96-F): map a composer ThinkingLevel onto
 * the model's OWN supported efforts — the WIRE contract for what
 * `reasoning.effort` carries:
 *
 *  · the chosen level rides VERBATIM when the ladder holds it (a
 *    ['max','high','low'] model + Max → "max", NOT "high" — the R95 fold
 *    was the owner's exact bug report);
 *  · an unheld level STEPS DOWN to the nearest supported rung ≤ the chosen
 *    one (max → xhigh → high → medium → low → minimal) — never up, never
 *    a 400 (an ['xhigh','high'] model + Max → "xhigh");
 *  · when even that does not exist (e.g. "low" on a ["medium","high"]
 *    model) the LOWEST supported effort stands in — never a 400, never a
 *    silent skip.
 *
 * Pure; expects a NON-EMPTY efforts list (the empty case is handled by the
 * caller — verbatim passthrough there). Exported for tests.
 */
export function mapThinkingLevelToEffort(
  level: ThinkingLevel,
  efforts: readonly ReasoningEffortLevel[],
): ReasoningEffortLevel {
  if (efforts.length === 0) {
    // Defensive direct-call shape (buildThinkingFetch passes only non-empty
    // lists — verbatim passthrough there): "default" has no rung of its own,
    // so it rides the LOWEST effort rather than a non-vocabulary value.
    return level === "default" ? "minimal" : (level as ReasoningEffortLevel);
  }
  if (level === "default") {
    // "default" injects nothing on the wire (buildThinkingFetch gates it
    // out); this defensive branch keeps a direct call honest — the lowest
    // supported rung stands in.
    return efforts.reduce(
      (lowest, e) => (EFFORT_RANK[e] < EFFORT_RANK[lowest] ? e : lowest),
      efforts[0],
    );
  }
  const target = level as ReasoningEffortLevel; // low | medium | high | xhigh | max
  if ((efforts as readonly string[]).includes(target)) return target;
  // Nearest supported rung at-or-below the chosen one; when none is lower,
  // the lowest one.
  let fallback: ReasoningEffortLevel | null = null;
  for (const e of efforts) {
    if (EFFORT_RANK[e] < EFFORT_RANK[target] && (fallback === null || EFFORT_RANK[e] > EFFORT_RANK[fallback])) {
      fallback = e;
    }
  }
  if (fallback !== null) return fallback;
  return efforts.reduce((lowest, e) => (EFFORT_RANK[e] < EFFORT_RANK[lowest] ? e : lowest), efforts[0]);
}

/**
 * ROUND-95 (R95-E): the per-level reasoning.max_tokens BUDGET for models
 * with DETECTED reasoning support — the provider-level bound on runaway
 * thinking (the owner: models "stuck in the thinking loop… think for way too
 * long, more than they even need to"). low caps at 2048, medium at the
 * 4096 midpoint, high at 8192, max at 16384; ROUND-96 (R96-F) adds xhigh
 * at the 12288 midpoint between high and max (the rung is real now — the
 * ladder vocabulary keeps the model's own top rungs verbatim).
 * "default" injects nothing at all, so it has no budget entry. Applied ONLY
 * when a reasoning object is being injected in the first place, and never
 * over a provider-set max_tokens.
 */
export const REASONING_BUDGET_BY_LEVEL: Readonly<Record<Exclude<ThinkingLevel, "default">, number>> = {
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 12288,
  max: 16384,
};

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
    //
    // ROUND-95 (R95-E): capability-aware — a model the catalog marks
    // NOT reasoning-capable (support.supported === false) gets NO thinking
    // wrapper at all (no reasoning key on the wire), and a detected ladder
    // maps the level + budget inside the wrapper (buildThinkingFetch).
    ...((() => {
      const fallbackFetch =
        input.provider.id === "openrouter" &&
        input.model.endsWith(":free") &&
        input.model !== "openrouter/free"
          ? buildModelFallbackFetch()
          : undefined;
      const level = input.thinkingLevel;
      let chain:
        | ((url: string | URL | Request, init?: RequestInit) => Promise<Response>)
        | undefined = fallbackFetch;
      if (level !== undefined && level !== "default" && input.reasoningSupport?.supported !== false) {
        chain = buildThinkingFetch(level, input.reasoningSupport, fallbackFetch);
      }
      // ROUND-96 (R96-J): the output cap rides UNDER the attribution wrapper
      // and OVER the thinking/fallback chain (see buildOutputCapFetch — the
      // paid-model credits catch) when the input carries the resolved budget
      // number. NOTE: for a ladder-less thinking model the thinking wrapper
      // injects reasoning.max_tokens — the cap wrapper then stands down for
      // that body (the R95 live-verified shape owns it).
      if (typeof input.maxOutputTokens === "number" && Number.isFinite(input.maxOutputTokens)) {
        const prevChain = chain;
        chain = buildOutputCapFetch(input.maxOutputTokens, prevChain);
      }
      // ROUND-96 (R96-J): the app-attribution wrapper rides OUTERMOST —
      // every outbound chat-completions call identifies the app to
      // OpenRouter (see withAppAttribution: the live-fire's
      // publisher-gated model catch).
      return { fetch: withAppAttribution(chain) };
    })()),
  });
  return provider.chatModel(input.model);
}

export interface ChatToolCall {
  name: string;
  argsSummary: string;
  /** ROUND-96 (R96-B, the owner's loop-guard report: "the model was reading
   * a file: it read the first half, then the second, then the fourth… our
   * loop guard stopped it while it was clearly not stuck"): the RAW tool
   * arguments (the SDK's `input` object), threaded for EXACT-CALL IDENTITY —
   * the display `argsSummary` deliberately DROPS every non-string arg
   * (summarizeArgs), so paged reads of one file (read_file offset 1 / 5000 /
   * 10000…) rendered IDENTICAL summaries and the R51 guard false-positived
   * on healthy paging. The guard compares the canonical RAW args; every
   * display/persisted surface keeps using argsSummary (raw args are NEVER
   * persisted or emitted — write bodies and paths ride them). */
  args?: unknown;
  ok: boolean;
  /** Round-34: compact model-facing output summary (persisted for history). */
  outputSummary?: string;
}

// ── ROUND-94 (R94-D1): the attachment renderer + the prepareStep wiring ──────
//
// renderAttachments moved here VERBATIM from runtime.ts (its only other
// consumer — assembleHistory — imports it back; runtime.ts already imports
// from this module, so no cycle). The move exists because the mid-turn
// injection must build the model-facing user message EXACTLY the way the
// normal send path does (attachments rendered INTO the content string —
// never SDK message parts; that is how every other user message in this
// codebase reaches the model), and duplicating the renderer would fork the
// analyze_image teaching contract between the two files.

/** ROUND-67 (R67-A): image-extension test for the attachment render (see
 * renderAttachments — the same set vision.ts's IMAGE_EXT_RE uses). */
const ATTACHED_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/**
 * ROUND-50 (R50-c1): render a message.user event's attachments into the
 * model-facing content AFTER the user text. The RAW event payload stays
 * clean ({role, content, attachments}) — this block exists only in the
 * model-facing history, so the display never sees it. Binary/unreadable
 * attachments (text: null) render a one-line placeholder instead.
 *
 * ROUND-67 (R67-A, the owner's #1 v0.66.0 complaint: "the agent said the
 * image doesn't exist"): attachments persisted through POST
 * /attachments/upload now carry a path, and the model is TAUGHT what to do
 * with it instead of guessing (the old render showed a.name only, so the
 * model invented paths and analyze_image ENOENT'd):
 *   - image extension + path + no text → an explicit `attached image` block
 *     naming the path AND the exact analyze_image call to make;
 *   - anything else with a path → the existing render plus a trailing
 *     "(file saved at …)" line;
 *   - path-less attachments (inline-dropped text, legacy rows) render
 *     EXACTLY as before.
 */
export function renderAttachments(content: string, attachments: readonly MessageAttachment[]): string {
  let out = content;
  for (const a of attachments) {
    // ROUND-67 (R67-A): the same extension set as vision.ts's IMAGE_EXT_RE
    // (kept local — the plugin must stay import-free from the history
    // renderer). Check both the display name and the path; the sanitized
    // upload name keeps its extension either way.
    const path = typeof a.path === "string" && a.path !== "" ? a.path : null;
    const text = typeof a.text === "string" && a.text !== "" ? a.text : null;
    const isImage = path !== null && (ATTACHED_IMAGE_EXT_RE.test(a.name) || ATTACHED_IMAGE_EXT_RE.test(path));
    if (isImage && text === null) {
      out += `\n\n--- attached image: ${a.name} (saved in the project at ${path}) ---\nUse analyze_image with path "${path}" to view it.`;
    } else if (text !== null) {
      out += `\n\n--- attached file: ${a.name} ---\n${text}\n--- end of ${a.name} ---${path !== null ? `\n(file saved at ${path})` : ""}`;
    } else {
      out += `\n\n--- attached file: ${a.name} (no readable text) ---${path !== null ? `\n(file saved at ${path})` : ""}`;
    }
  }
  return out;
}

/**
 * ROUND-94 (R94-D1): the prepareStep the adapter wires into BOTH SDK call
 * sites (generateText + streamText) when the input carries
 * consumeQueuedForStep. The boundary contract, verbatim from the owner's
 * field report: the queued prompt is injected "right after a tool call
 * completes / a sub-agent task finishes, when the agent is about to continue" —
 * so the gate is BOTH (a) stepNumber > 0 (at least one step completed — never
 * step 0) AND (b) the prior step actually completed tool calls (inspected on
 * the SDK's `steps` array; a text-only prior step ends the loop anyway and
 * must never trigger an injection). ONE consumeQueuedForStep() call per
 * boundary — the runtime claims at most one queue entry per boundary, so the
 * next boundary can take the next message ("sent midway when the current call
 * completed"). A null return leaves the SDK untouched (no override → the
 * call is byte-identical to a prepareStep-less one).
 *
 * The messages override carries forward to later steps per the AI SDK 7
 * prepareStep contract (verified against ai@7.0.73's types: "If you return a
 * `messages` override, those messages carry forward to later steps"), so a
 * multi-step tool loop keeps seeing the injected user message on every
 * subsequent request of the same SDK call.
 */
function buildQueuedInjectionPrepareStep(
  consumeQueuedForStep: () => QueuedStepMessage | null,
): (
  options: {
    stepNumber: number;
    steps: ReadonlyArray<{ toolResults?: ReadonlyArray<unknown> }>;
    messages: ReadonlyArray<ModelMessage>;
  },
) => { messages: Array<ModelMessage> } | undefined {
  return (options) => {
    // (a) The injection boundary is BETWEEN steps — step 0 has no completed
    // step before it, so nothing can have "just finished".
    if (options.stepNumber <= 0) return undefined;
    // (b) The prior step must have COMPLETED TOOL CALLS (its toolResults
    // array is the SDK's own record of executed calls — the boundary the
    // owner described). A text-only prior step is not an injection point.
    const prior = options.steps[options.steps.length - 1];
    if (prior === undefined) return undefined;
    const priorToolResults = prior.toolResults;
    if (!Array.isArray(priorToolResults) || priorToolResults.length === 0) return undefined;
    // ONE claim per boundary; null → no override, no behavior change.
    const entry = consumeQueuedForStep();
    if (entry === null) return undefined;
    // The model-facing user message mirrors the normal send path exactly:
    // content string with the attachments rendered in (renderAttachments —
    // the same renderer assembleHistory applies to every other user
    // message; the queue storage's raw payload shape is preserved on the
    // PERSISTED side, in runtime.ts).
    return {
      messages: [
        ...options.messages,
        { role: "user", content: renderAttachments(entry.content, entry.attachments ?? []) },
      ],
    };
  };
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
    // ROUND-94 (R94-D1): mid-turn queued-message injection — prepareStep is
    // handed to the SDK ONLY when a consumer is attached (every legacy caller
    // and test stub stays on the prepareStep-less call, byte-identical).
    ...(input.consumeQueuedForStep !== undefined
      ? { prepareStep: buildQueuedInjectionPrepareStep(input.consumeQueuedForStep) }
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
        // ROUND-96 (R96-B): the RAW input rides the call — the loop guard's
        // exact-match identity (see ChatToolCall.args). Never persisted.
        args: r.input,
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
  // ROUND-82 (R82): the shape block moved to lib/secret-shapes.ts (the
  // model-test probe in providers/registry.ts needed the same three
  // prefixes — one shared definition now; see that module's header for the
  // consolidation history).
  text = scrubSecretShapes(text);
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
  /** ROUND-96 (R96-B): the RAW tool arguments for exact-call identity — the
   * loop guard's repeat detection needs them (paged reads differ by offset,
   * not by the string-only display summary). Consumed by the runtime's guard
   * feed ONLY; never forwarded over SSE (the runtime strips the field before
   * emitting) and never persisted. */
  | { type: "tool-call"; toolName: string; argsSummary: string; args?: unknown }
  /** ROUND-96 (R96-B): same raw-args threading on the result (the guard
   * fires per EXECUTED call — the result is the honest per-call feed). */
  | { type: "tool-result"; toolName: string; argsSummary: string; args?: unknown; ok: boolean; outputSummary?: string }
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

/* ── ROUND-95 (R95-E): the thinking-loop watchdog ─────────────────────────── */

/** The reasoning-stall window: no text, tool activity, or finish for this
 * long while reasoning keeps flowing = a likely thinking loop (the owner:
 * "They will think for way too long, more than they even need to, and they
 * won't even get out of the thinking"). */
export const THINKING_STALL_MS = 120_000;

/** The reasoning volume that qualifies a stall as a LOOP: below this the
 * model may legitimately be chewing a hard problem inside one long burst. */
export const THINKING_STALL_REASONING_BYTES = 24_000;

/**
 * ROUND-95 (R95-E): thrown by streamAiSdkChat's reasoning-stall watchdog
 * when the model streamed >24KB of reasoning with NO text-delta, tool
 * activity, or finish for 120s — the dedicated, honestly-named error for the
 * thinking-loop failure mode. The runtime's classifier maps it to the
 * `thinking_loop` class (error-classification.ts matches the error NAME,
 * keeping that module free of chat.ts imports), and the streamed runner
 * gives it ONE de-escalating retry (thinking level forced down) before the
 * honest terminal path.
 *
 * STREAMED-path only for now (the owner's report is about the live chat);
 * the SYNC sub-agent path (aiSdkChat/generateText) can adopt the same
 * watchdog later — its per-step onStepFinish snapshots are the natural
 * progress markers.
 */
export class ThinkingLoopError extends Error {
  constructor() {
    super(
      "the model produced >24KB of reasoning with no text, tool call, or finish " +
        "for 120s — likely stuck in a reasoning loop",
    );
    this.name = "ThinkingLoopError";
  }
}

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
    // ROUND-94 (R94-D1): mid-turn queued-message injection on the STREAMED
    // path — the owner's exact scenario (the message rides the LIVE turn's
    // still-open stream, injected at the tool-call boundary). Same
    // conditional wiring as generateText above: no consumer → no prepareStep.
    ...(input.consumeQueuedForStep !== undefined
      ? { prepareStep: buildQueuedInjectionPrepareStep(input.consumeQueuedForStep) }
      : {}),
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
  // ROUND-95 (R95-E): the thinking-loop watchdog's state. `lastProgressTs` —
  // the last part that was NOT a reasoning-delta (text, tool activity, a
  // finish-step — every other part type); `reasoningBytesSinceProgress` — the
  // reasoning-delta bytes accumulated since that mark. A model that keeps
  // REASONING (and only reasoning) past the stall window with enough volume
  // is looping, not thinking. Progress of ANY other kind resets both.
  let lastProgressTs = Date.now();
  let reasoningBytesSinceProgress = 0;
  // ROUND-97 (R97-D, owner: "we should give the user the option in the
  // settings to turn it on or off. By default it will be turned off so that
  // the model can think as much as it needs to"): the guard is OPT-IN now.
  // `thinkingLoop` absent or enabled:false → the watchdog NEVER fires (the
  // checks below short-circuit on the disabled flags); enabled:true → the
  // thresholds come from the SETTINGS the owner edited (stallMs from
  // stallSeconds, reasoningBytes from reasoningBytesKB — not the R95
  // hardcoded constants).
  const loopEnabled = input.thinkingLoop?.enabled === true;
  const loopStallMs = input.thinkingLoop?.stallMs ?? THINKING_STALL_MS;
  const loopReasoningBytes = input.thinkingLoop?.reasoningBytes ?? THINKING_STALL_REASONING_BYTES;
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
    if (part.type === "reasoning-delta") {
      // ROUND-95 (R95-E): reasoning is the ONE part type that is not
      // progress — accumulate it and check the stall. The abort happens
      // cleanly BETWEEN parts: throwing from the for-await ends this
      // generator (the SDK stream's implicit return() closes it), no signal
      // needed — the runtime's existing error path owns the fallout.
      // ROUND-97 (R97-D): loopEnabled=false → no check at all — the model
      // thinks as much as it needs to (the owner's default-off directive).
      reasoningBytesSinceProgress += part.text.length;
      if (
        loopEnabled &&
        Date.now() - lastProgressTs > loopStallMs &&
        reasoningBytesSinceProgress > loopReasoningBytes
      ) {
        throw new ThinkingLoopError();
      }
    } else {
      lastProgressTs = Date.now();
      reasoningBytesSinceProgress = 0;
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
      yield { type: "tool-call", toolName: part.toolName, argsSummary, args: part.input };
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
        // ROUND-96 (R96-B): the raw input for the guard's exact-match identity.
        args: part.input,
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
