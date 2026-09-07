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
 */

/** The six provider-failure classes (R71-d design: A6). */
export type ProviderErrorClass =
  | "context_window_exceeded"
  | "auth"
  | "rate_limit"
  | "network"
  | "timeout"
  | "unknown";

export interface ProviderErrorClassification {
  class: ProviderErrorClass;
  /** Class-specific honest one-liner (the "classified line" threaded into
   * the PROVIDER_ERROR detail — never a raw provider dump). */
  userMessage: string;
}

/** Auth statuses — BY STATUS ONLY (cline's rule: matching message text for
 * 401/403 would misfire on provider bodies that merely quote such words). */
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

/** Extract a numeric HTTP status from a provider error object. The AI SDK
 * throws APICallError {statusCode}; wrapped/normalized errors carry it under
 * status/data — a shallow bounded walk (never a throw) covers the rest. */
function extractStatus(error: unknown): number | null {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): number | null => {
    if (value === null || typeof value !== "object" || depth > 3) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    try {
      const record = value as Record<string, unknown>;
      for (const key of ["statusCode", "status", "responseStatus"]) {
        const raw = record[key];
        if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
      }
      for (const child of [record.data, record.cause, record.error, record.response]) {
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

/** Was the error an abort/timeout (AbortSignal.timeout, a user stop that
 * reached the SDK, a provider-side timeout)? */
function isAbortLike(error: unknown, message: string): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" || /\b(?:timed?\s?out|timeout)\b/i.test(message);
}

const CLASS_MESSAGES: Record<ProviderErrorClass, string> = {
  context_window_exceeded: "context window exceeded — the request is larger than the model's context window",
  auth: "authentication failed — the provider rejected the API key",
  rate_limit: "rate limited — the provider is throttling requests",
  network: "network/server error — the provider connection failed",
  timeout: "timeout — the provider call did not complete in time",
  unknown: "unclassified provider error",
};

/** Classify a provider/stream error (R71-e2 D4). Pure; never throws. */
export function classifyProviderError(error: unknown): ProviderErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  const status = extractStatus(error);
  // 1. Abort/timeout shapes first — TimeoutError/AbortError are unambiguous,
  // and no later pattern should steal them.
  if (isAbortLike(error, message)) {
    return { class: "timeout", userMessage: CLASS_MESSAGES.timeout };
  }
  // 2. Status-only classes.
  if (status !== null && AUTH_STATUSES.has(status)) {
    return { class: "auth", userMessage: CLASS_MESSAGES.auth };
  }
  if (status !== null && RATE_LIMIT_STATUSES.has(status)) {
    return { class: "rate_limit", userMessage: CLASS_MESSAGES.rate_limit };
  }
  // 3. Rate-limit patterns (the deliberate VETO before overflow matching).
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(message))) {
    return { class: "rate_limit", userMessage: CLASS_MESSAGES.rate_limit };
  }
  // 4. Context-window overflow (message patterns or the 413 payload-too-large
  //    status — a bare 400/422 is deliberately not overflow-classified).
  if (CONTEXT_WINDOW_PATTERNS.some((re) => re.test(message)) || (status !== null && CONTEXT_OVERFLOW_STATUSES.has(status))) {
    return { class: "context_window_exceeded", userMessage: CLASS_MESSAGES.context_window_exceeded };
  }
  // 5. Network/transport (patterns or any 5xx).
  if (NETWORK_PATTERNS.some((re) => re.test(message)) || (status !== null && status >= 500)) {
    return { class: "network", userMessage: CLASS_MESSAGES.network };
  }
  return { class: "unknown", userMessage: CLASS_MESSAGES.unknown };
}

/** Error text for a 502 envelope — scrubbed of the API key, then length-capped. */
export function providerErrorDetail(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw.split(apiKey).join("***");
  return scrubbed.length > 500 ? `${scrubbed.slice(0, 500)}…` : scrubbed;
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
 */
export function isTransientApiFailure(classification: ProviderErrorClass): boolean {
  return classification === "rate_limit" || classification === "network" || classification === "timeout";
}
