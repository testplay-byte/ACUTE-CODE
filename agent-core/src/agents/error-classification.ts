/**
 * ROUND-75 (R75): provider-error classification, extracted from
 * runtime.ts into its own pure module. The extraction exists because the
 * R75 retry ladder (lib/retry.ts) needs `ProviderErrorClass` and the
 * transient/non-transient split WITHOUT importing the whole 2.8k-line
 * runtime (which would cycle: runtime → retry → runtime). The code below
 * is byte-identical to the R71-e2 block it replaces; runtime.ts re-exports
 * the public surface so every existing import (tests, debug-analyst)
 * keeps working unchanged.
 *
 * ROUND-71 (R71-e2, D4) heritage — the original design note:
 * Every provider/stream failure used to flatten to the same generic
 * PROVIDER_ERROR 502 with a scrubbed message — the UI (and the model, on
 * retry) could not tell a rate limit from a dead key from a genuine
 * context-window overflow. cline classifies BEFORE flattening
 * ("context_window_exceeded | auth | unknown", status-only auth rule,
 * deliberate rate-limit VETO on the context-window patterns because
 * "tokens exceeded" also appears in TPM messages). We classify into six
 * classes, thread the class into the user-facing message + envelope
 * (additive — the existing prefix and retry policy are UNCHANGED), and
 * feed the class into the D5 overflow-recovery loop.
 *
 * ROUND-75 (R75): the same class drives the TRANSIENT-API retry ladder —
 * { rate_limit, network, timeout } are transient (the owner's spec: "if it
 * fails due to timeout or rate limit, retry; other failures do not
 * auto-retry"), everything else (auth, context_window_exceeded, unknown)
 * fails fast with the honest error card.
 *
 * ROUND-78 (R78, owner: "the UI shows 'rate-limited' no matter the real
 * cause… every other failure must show the API's ACTUAL returned error
 * text"): HONEST CLASSIFICATION. Two live-probed lies drove this rework:
 *  (1) The AI SDK v7 delivers exhausted internal retries as a RetryError
 *      wrapper ({name:"AI_RetryError", lastError, errors}) — the old
 *      classifier read the FLATTENED wrapper text, extractStatus saw NO
 *      statusCode at all, so a real 429 classified only by message-pattern
 *      luck. classifyProviderError now classifies the UNWRAPPED error
 *      (unwrapRetryError below) while keeping the wrapper message as
 *      fallback text; extractStatus additionally walks lastError/errors.
 *  (2) A 403 whose body says "This model is not available in your region"
 *      classified as auth ("the provider rejected the API key") — a lie
 *      that sent the owner hunting for a key problem. 403 stays auth ONLY
 *      when the real message does not clearly say otherwise (the
 *      REGION_OR_ACCESS patterns below); 401 remains status-only auth
 *      (cline's rule — quoted words in a provider body must not steal it).
 *  (3) userMessage is now the REAL provider text (the unwrapped error's
 *      message, scrubbed of API-key-shaped strings, ~240 chars) — the
 *      generic class one-liners demote to the fallback when the real text
 *      is empty. The class chip (UI) keeps carrying the class NAME.
 */

/** The provider-failure classes (R71-d design: A6; R94-D1 added the
 * seventh — malformed_response). */
export type ProviderErrorClass =
  | "context_window_exceeded"
  | "auth"
  | "rate_limit"
  | "network"
  | "timeout"
  | "malformed_response"
  | "unknown";

export interface ProviderErrorClassification {
  class: ProviderErrorClass;
  /** Class-specific honest one-liner (the "classified line" threaded into
   * the PROVIDER_ERROR detail — never a raw provider dump). */
  userMessage: string;
}

/** Auth statuses — BY STATUS ONLY (cline's rule: matching message text for
 * 401/403 would misfire on provider bodies that merely quote such words).
 * ROUND-78 (R78): 401 keeps the status-only rule; 403 gained the refinement
 * below (a region/moderation/availability 403 is NOT an auth failure). */
const AUTH_STATUSES = new Set([401, 403]);
/** Rate-limit status. */
const RATE_LIMIT_STATUSES = new Set([429]);
/** Statuses that unambiguously mean "the request payload is too large".
 * (A bare 400/422 is deliberately NOT overflow-classified: providers use
 * them for schema errors too — the message patterns carry the detection.) */
const CONTEXT_OVERFLOW_STATUSES = new Set([413]);

/** Message shapes that mean "the request does not fit the context window". */
const CONTEXT_WINDOW_PATTERNS: readonly RegExp[] = [
  /\bcontext[ _-]?(?:length|window|limit)s?[ _-]?exceed/i,
  /\bcontext\s+(?:length|window|limit)\b/i,
  /\bmaximum\s+(?:context|prompt|request|input)\s+(?:length|size|tokens?)\b/i,
  /\bmaximum.*\btokens?\b/i,
  /\b(?:prompt|request|input)\s+(?:is\s+)?too\s+long\b/i,
  /\btoo\s+many\s+(?:input\s+)?tokens\b/i,
  /\bexceeds?\s+(?:the\s+)?(?:maximum|allowed|context|token)\b/i,
  /\binput.*tokens?\s+exceed/i,
];

/** Message shapes that mean rate limiting (checked BEFORE the context-window
 * patterns — the veto: "tokens exceeded" wording also appears in TPM
 * rate-limit bodies, and a misfiled overflow would trigger D5 recovery on a
 * request that compaction cannot fix). */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\brate[ _-]?limit/i,
  /\btoo\s+many\s+requests\b/i,
  /\b(?:requests|tokens|TPM|RPM|quota)[ _-]?(?:limit|exceeded|exhausted)\b/i,
];

/** Message shapes that mean connection/transport failure. */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)\b/,
  /\bUND_ERR_(?:SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT)\b/,
  /\b(?:fetch|socket|network)\s+(?:failed|error)\b/i,
  /\bsocket\s+hang\s?up\b/i,
  /\b(?:connection|network)\s+(?:reset|refused|closed|error)\b/i,
  /\b(?:internal server error|service unavailable|bad gateway|server error)\b/i,
];

/** ROUND-94 (R94-D1, the owner's v0.91.0 field report: mid-task the
 * generation died with "Generation failed: unknown object" — an NVIDIA /
 * OpenRouter MALFORMED-RESPONSE error that classified `unknown` → fail-fast,
 * no retry, an instant dead end): message shapes that mean the provider
 * returned a RESPONSE we could not parse — not a transport failure, not a
 * rate limit, but garbage from the endpoint itself (a truncated/invalid
 * SSE chunk, an unexpected token where a JSON field belonged). Known
 * transient-in-practice on some endpoints (NVIDIA NIM's "unknown object",
 * OpenRouter's partial-model redirects), so the class maps TRANSIENT and
 * rides the existing retry ladder — never an instant dead end. Checked
 * AFTER the network patterns (a 5xx-shaped body keeps its honest network
 * class) and BEFORE the final `unknown` fallthrough. */
const MALFORMED_RESPONSE_PATTERNS: readonly RegExp[] = [
  // The owner's literal case, verbatim.
  /unknown object/i,
  /unexpected (?:token|chunk|part|object)/i,
  /invalid (?:response|chunk) (?:format|shape)/i,
  /malformed/i,
];

/** ROUND-78 (R78): message shapes that mean a 403 is about REGION / ACCESS /
 * AVAILABILITY, not the API key. Checked against the REAL (unwrapped)
 * message BEFORE the 403 → auth mapping — a hit reclassifies to `unknown`
 * (fail-fast: no retry ladder can heal a region block, a moderation gate,
 * or a model the account cannot access) with the real text as the
 * userMessage. The live probe that motivated this: OpenRouter's paid-model
 * 403 "This model is not available in your region." classified as auth —
 * the owner was sent hunting for a key problem that did not exist. */
const REGION_OR_ACCESS_PATTERNS: readonly RegExp[] = [
  /not available in your region/i,
  /\bregion\b/i,
  /\bmoderation\b/i,
  /\bpermission\b/i,
  /not available/i,
  /\bunavailable\b/i,
  /\bblocked\b/i,
];

/* ── ROUND-78 (R78): the RetryError unwrap ─────────────────────────────────
 *
 * The AI SDK v7 wraps its own internal retries: when streamText/generateText
 * exhausts maxRetries it throws a RetryError whose `name` is "AI_RetryError",
 * carrying the FINAL underlying provider error under `lastError` (and every
 * attempt under `errors`). Its own `message` is the flattened
 * "Failed after N attempts. Last error: …" — text that carries no statusCode
 * and buries the real cause. The classifier (and providerErrorDetail) want
 * the UNDERLYING error; the wrapper message survives only as fallback text
 * when the underlying error has none. */

/** True when the value looks like the AI SDK v7 RetryError wrapper. */
function isRetryError(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === "AI_RetryError"
  );
}

/**
 * ROUND-78 (R78): unwrap the AI SDK v7 RetryError — return its `lastError`
 * when present (falling back to the last element of its `errors` array);
 * any other value returns unchanged. Never throws, never recurses (one
 * level of unwrap — the SDK never nests RetryErrors; a nested provider
 * error still classifies through the bounded status walk below).
 */
export function unwrapRetryError(error: unknown): unknown {
  try {
    if (!isRetryError(error)) return error;
    const record = error as Record<string, unknown>;
    if (record.lastError !== undefined && record.lastError !== null) return record.lastError;
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      return record.errors[record.errors.length - 1];
    }
    return error;
  } catch {
    /* unreachable-object guard — return the input unchanged */
    return error;
  }
}

/** Extract a numeric HTTP status from a provider error object. The AI SDK
 * throws APICallError {statusCode}; wrapped/normalized errors carry it under
 * status/data — a shallow bounded walk (never a throw) covers the rest.
 * ROUND-78 (R78): the walk additionally descends into a RetryError's
 * `lastError` and `errors` (same depth ≤ 4 budget, same cycle guard) so a
 * wrapper's underlying APICallError statusCode is found — previously a
 * RetryError carried NO extractable status at all. */
function extractStatus(error: unknown): number | null {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): number | null => {
    if (value === null || typeof value !== "object" || depth > 4) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    try {
      const record = value as Record<string, unknown>;
      for (const key of ["statusCode", "status", "responseStatus"]) {
        const raw = record[key];
        if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
      }
      // R78: RetryError fields join the walk — `lastError` (the final
      // underlying error) and the tail of `errors` (most recent first is
      // what we care about, but the walk is order-agnostic and bounded).
      for (const child of [
        record.lastError,
        ...(Array.isArray(record.errors) ? record.errors.slice(-1) : []),
        record.data,
        record.cause,
        record.error,
        record.response,
      ]) {
        const found = walk(child, depth + 1);
        if (found !== null) return found;
      }
    } catch {
      /* unreachable-object guard — treat as no status */
    }
    return null;
  };
  return walk(error, 0);
}

/** ROUND-78 (R78): exported so tests can pin the FALLBACK lines — the
 * real-text userMessage demotes these to the empty-message fallback (the
 * class chip still carries the class name). */
export const CLASS_MESSAGES: Record<ProviderErrorClass, string> = {
  context_window_exceeded: "context window exceeded — the request is larger than the model's context window",
  auth: "authentication failed — the provider rejected the API key",
  rate_limit: "rate limited — the provider is throttling requests",
  network: "network/server error — the provider connection failed",
  timeout: "timeout — the provider call did not complete in time",
  // R94-D1: the human line for the new class (honestUserMessage's fallback
  // when the real provider text is empty — the card normally shows the
  // provider's own words).
  malformed_response: "the provider returned a malformed response (known transient class on some endpoints)",
  unknown: "unclassified provider error",
};

/** Cap for the real-text userMessage (R78). ROUND-80 (R80, owner: "for
 * error messages raw messages should be shown too"): 240 → 600 — the
 * one-line message is the card's fallback text when no providerError rode
 * the payload; the rawer it is, the less the owner has to expand anything.
 * The full text still rides providerErrorDetail. */
const USER_MESSAGE_MAX_CHARS = 600;

/** ROUND-78 (R78): the honest one-liner for a class — the REAL provider
 * text (message-shaped, whitespace-trimmed) truncated to USER_MESSAGE_MAX_CHARS
 * (600 since R80) with an ellipsis; the generic class line only when the real text is empty or not
 * message-shaped (non-Error objects stringify through String()). The
 * classifier never knows the API key, so the key-scrub happens at the
 * PERSISTENCE boundary (runtime's providerErrorDetail) — the envelope's
 * userMessage rides alongside the already-scrubbed providerError field. */
function honestUserMessage(realText: string, fallbackClass: ProviderErrorClass): string {
  const trimmed = realText.trim();
  if (trimmed === "") return CLASS_MESSAGES[fallbackClass];
  return trimmed.length > USER_MESSAGE_MAX_CHARS
    ? `${trimmed.slice(0, USER_MESSAGE_MAX_CHARS)}…`
    : trimmed;
}

/** ROUND-78 (R78): extract displayable text from the (unwrapped) error —
 * Error.message when present; String() otherwise; the WRAPPER's message
 * when the underlying error says NOTHING of its own (an empty message is no
 * message — the "Failed after N attempts" line is real evidence too, better
 * than a generic class line). */
function realMessageText(unwrapped: unknown, wrapperMessage: string): string {
  let own = "";
  if (unwrapped instanceof Error) {
    own = typeof unwrapped.message === "string" ? unwrapped.message : "";
  } else if (typeof unwrapped === "object" && unwrapped !== null) {
    const raw = (unwrapped as { message?: unknown }).message;
    own = typeof raw === "string" ? raw : "";
  } else if (unwrapped !== undefined && unwrapped !== null) {
    own = String(unwrapped);
  }
  return own !== "" ? own : wrapperMessage;
}

/** Classify a provider/stream error (R71-e2 D4). Pure; never throws.
 * ROUND-78 (R78): classifies the UNWRAPPED error (RetryError → its
 * lastError) — status, name, and message patterns all read the REAL
 * underlying failure; the wrapper's flattened message survives only as
 * userMessage fallback text when the underlying error says nothing. */
export function classifyProviderError(error: unknown): ProviderErrorClassification {
  const wrapperMessage = error instanceof Error ? error.message : "";
  const unwrapped = unwrapRetryError(error);
  const message = realMessageText(unwrapped, wrapperMessage);
  const status = extractStatus(unwrapped);
  // The real error's own name ("TimeoutError" on the underlying abort, not
  // "AI_RetryError" on the wrapper) — the unwrap is what makes this read.
  const errorName = unwrapped instanceof Error ? unwrapped.name : "";
  // 1. Abort/timeout shapes first — TimeoutError/AbortError are unambiguous,
  // and no later pattern should steal them.
  if (
    errorName === "TimeoutError" ||
    errorName === "AbortError" ||
    /\b(?:timed?\s?out|timeout)\b/i.test(message)
  ) {
    return { class: "timeout", userMessage: honestUserMessage(message, "timeout") };
  }
  // 2. Status-only classes.
  if (status !== null && AUTH_STATUSES.has(status)) {
    // R78 403 refinement: region / moderation / permission / availability
    // wording means the failure is NOT about the API key. Reclassify to
    // `unknown` (fail-fast — no ladder) with the REAL text as the line.
    // 401 keeps the status-only rule (a key rejection says so by status).
    if (status === 403 && REGION_OR_ACCESS_PATTERNS.some((re) => re.test(message))) {
      return { class: "unknown", userMessage: honestUserMessage(message, "unknown") };
    }
    return { class: "auth", userMessage: honestUserMessage(message, "auth") };
  }
  if (status !== null && RATE_LIMIT_STATUSES.has(status)) {
    return { class: "rate_limit", userMessage: honestUserMessage(message, "rate_limit") };
  }
  // 3. Rate-limit patterns (the deliberate VETO before overflow matching).
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(message))) {
    return { class: "rate_limit", userMessage: honestUserMessage(message, "rate_limit") };
  }
  // 4. Context-window overflow (message patterns or the 413 payload-too-large
  //    status — a bare 400/422 is deliberately not overflow-classified).
  if (CONTEXT_WINDOW_PATTERNS.some((re) => re.test(message)) || (status !== null && CONTEXT_OVERFLOW_STATUSES.has(status))) {
    return { class: "context_window_exceeded", userMessage: honestUserMessage(message, "context_window_exceeded") };
  }
  // 5. Network/transport (patterns or any 5xx).
  if (NETWORK_PATTERNS.some((re) => re.test(message)) || (status !== null && status >= 500)) {
    return { class: "network", userMessage: honestUserMessage(message, "network") };
  }
  // 6. ROUND-94 (R94-D1): malformed/unknown-object provider RESPONSE bodies —
  // the owner's "Generation failed: unknown object" dead end. Before the
  // final `unknown` fallthrough so a body that says BOTH (a 500-shaped
  // network wording — see 5) keeps the network class, while a shapeless
  // parse failure from a healthy connection lands here: TRANSIENT, ladder-
  // retryable, never an instant dead end.
  if (MALFORMED_RESPONSE_PATTERNS.some((re) => re.test(message))) {
    return { class: "malformed_response", userMessage: honestUserMessage(message, "malformed_response") };
  }
  return { class: "unknown", userMessage: honestUserMessage(message, "unknown") };
}

/** Error text for a 502 envelope — scrubbed of the API key, then length-capped.
 * ROUND-78 (R78): unwraps the RetryError FIRST — the envelope must carry the
 * real underlying body ("Rate limit exceeded: free-models-per-day…"), not
 * the wrapper's "Failed after N attempts. Last error: …" burial. */
export function providerErrorDetail(error: unknown, apiKey: string): string {
  const unwrapped = unwrapRetryError(error);
  // Same fallback ladder as classifyProviderError: the underlying error's
  // message, else the wrapper's own message (real evidence), else String().
  let raw = realMessageText(unwrapped, error instanceof Error ? error.message : "");
  if (raw === "") {
    raw = error instanceof Error ? error.message : String(error);
  }
  const scrubbed = raw.split(apiKey).join("***");
  // ROUND-80 (R80, owner: "for error messages raw messages should be shown
  // too"): 500 → 4000 — the cap existed for card readability, but the UI's
  // R77 expand-toggle already collapses long text with a scrollable mono
  // block, so the cap only ever HID the provider's real payload. 4000 chars
  // covers every real provider error body (OpenRouter 429s, NVIDIA NIM
  // validation dumps) while keeping frames/rows bounded.
  return scrubbed.length > 4000 ? `${scrubbed.slice(0, 4000)}…` : scrubbed;
}

/** R71-e2 D4: the user-facing PROVIDER_ERROR message — the existing prefix
 * (tests pin it) with the class appended; a classified terminal line for the
 * D5 "overflow even after compaction" case.
 * ROUND-75 (R75): `attempts` (the retry ladder's total attempts when it ran)
 * appends the honest exhaustion line — additive, only when > 1. */
export function providerFailureMessage(
  providerId: string,
  sessionId: string,
  classified: ProviderErrorClassification,
  overflowAlreadyRecovered: boolean,
  attempts?: number,
): string {
  const base = `provider '${providerId}' call failed for session ${sessionId} (class: ${classified.class})`;
  if (classified.class === "context_window_exceeded" && overflowAlreadyRecovered) {
    return `${base} — context window exceeded even after compaction — start a new session or /compact`;
  }
  if (attempts !== undefined && attempts > 1) {
    return `${base} — failed after ${attempts} attempts (auto-retry ladder exhausted)`;
  }
  return base;
}

/* ── ROUND-75 (R75): the transient split for the retry ladder ───────────────── */

/**
 * True for the classes the owner's R75 retry ladder treats as TRANSIENT
 * ("if it fails due to timeout or due to some rate limit or something like
 * that, it retries"): rate limiting (the provider is throttling — waiting
 * genuinely helps), network/transport (connection blips, 5xx), and provider
 * timeouts. False for auth (a dead key never heals by waiting), context
 * overflow (has its own D5 recovery path — compaction, not waiting), and
 * unknown (no evidence waiting helps — fail fast with the honest card).
 *
 * ROUND-94 (R94-D1): malformed_response JOINS the transient set — the
 * owner's "Generation failed: unknown object" dead end was exactly this
 * class, and it is transient-in-practice on the endpoints that produce it
 * (a rerun typically succeeds). The ladder's existing rungs handle it with
 * no special-casing beyond this classification.
 */
export function isTransientApiFailure(classification: ProviderErrorClass): boolean {
  return (
    classification === "rate_limit" ||
    classification === "network" ||
    classification === "timeout" ||
    classification === "malformed_response"
  );
}
