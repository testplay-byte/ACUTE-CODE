/**
 * ROUND-78 (R78) regression tests — the HONEST-ERRORS classifier rework.
 *
 * The owner's verbatim ask: "the UI shows 'rate-limited' no matter the real
 * cause… only a REAL rate limit may show as one; every other failure must
 * show the API's ACTUAL returned error text. Robustify the whole error
 * chain — no random/mismatched messages."
 *
 * Coverage:
 *  · unwrapRetryError: the AI SDK v7 RetryError wrapper ({name:
 *    "AI_RetryError", lastError, errors}) unwraps to its lastError (else the
 *    last errors[] element); everything else passes through; never throws.
 *  · classifyProviderError classifies the UNWRAPPED error — a RetryError
 *    wrapping an APICallError with statusCode 429/500/timeout names the
 *    REAL class (the old classifier saw no status at all and rode the
 *    flattened wrapper text by message-pattern luck).
 *  · extractStatus walks lastError + errors (bounded, cycle-safe).
 *  · The 403 refinement: region/moderation/permission/availability wording
 *    → class `unknown` (fail-fast, no ladder) with the REAL text; a plain
 *    403 stays auth; 401 stays status-only auth.
 *  · userMessage is the REAL provider text (the unwrapped message), capped
 *    at 600 chars since R80 (240 before); empty real text falls back to the
 *    generic class line (CLASS_MESSAGES stays exported for exactly this pin).
 *  · providerErrorDetail unwraps the RetryError — the envelope carries the
 *    real body, not "Failed after 5 attempts. Last error: …", and still
 *    scrubs the API key.
 *  · Model-availability wording (the 404 "unavailable for free" probe)
 *    stays `unknown` but now with the REAL text as the userMessage.
 */
import { describe, expect, it } from "vitest";

import {
  CLASS_MESSAGES,
  classifyProviderError,
  isTransientApiFailure,
  providerErrorDetail,
  unwrapRetryError,
} from "../src/agents/error-classification";

/** Build the AI SDK v7 RetryError wrapper shape around an underlying error. */
function retryError(underlying: unknown): Error {
  const message = `Failed after 5 attempts. Last error: ${
    underlying instanceof Error ? underlying.message : String(underlying)
  }`;
  const err = new Error(message);
  err.name = "AI_RetryError";
  const wrapped = err as Error & { lastError?: unknown; errors?: unknown[] };
  wrapped.lastError = underlying;
  wrapped.errors = [new Error("first attempt failed"), underlying];
  return err;
}

/** The AI SDK's APICallError shape ({statusCode} + a real body). */
function apiCallError(statusCode: number, message: string): Error {
  const err = new Error(message);
  err.name = "AI_APICallError";
  (err as Error & { statusCode?: number }).statusCode = statusCode;
  return err;
}

/* ── unwrapRetryError ─────────────────────────────────────────────────────── */

describe("R78: unwrapRetryError", () => {
  it("an AI_RetryError returns its lastError", () => {
    const underlying = apiCallError(429, "Rate limit exceeded: free-models-per-day");
    const wrapper = retryError(underlying);
    expect(unwrapRetryError(wrapper)).toBe(underlying);
  });

  it("without lastError, the LAST errors[] element is the unwrap target", () => {
    const underlying = apiCallError(500, "Internal Server Error");
    const wrapper = new Error("Failed after 3 attempts.");
    wrapper.name = "AI_RetryError";
    (wrapper as Error & { errors?: unknown[] }).errors = [
      apiCallError(429, "first failure"),
      underlying,
    ];
    expect(unwrapRetryError(wrapper)).toBe(underlying);
  });

  it("a RetryError with neither field returns unchanged (never undefined)", () => {
    const wrapper = new Error("Failed after 2 attempts.");
    wrapper.name = "AI_RetryError";
    expect(unwrapRetryError(wrapper)).toBe(wrapper);
  });

  it("non-RetryErrors pass through untouched", () => {
    const plain = apiCallError(401, "User not found.");
    expect(unwrapRetryError(plain)).toBe(plain);
    expect(unwrapRetryError(new Error("boom"))).toBeInstanceOf(Error);
    expect(unwrapRetryError("a string error")).toBe("a string error");
    expect(unwrapRetryError(undefined)).toBeUndefined();
  });

  it("never throws on hostile shapes", () => {
    expect(() => unwrapRetryError(null)).not.toThrow();
    const cyclic: Record<string, unknown> = { name: "AI_RetryError" };
    cyclic.lastError = cyclic;
    expect(() => unwrapRetryError(cyclic)).not.toThrow();
  });
});

/* ── classification of the UNWRAPPED error ────────────────────────────────── */

describe("R78: classifyProviderError reads the UNWRAPPED error", () => {
  it("a RetryError wrapping a 429 APICallError → rate_limit (the status is found through lastError)", () => {
    const err = retryError(apiCallError(429, "Rate limit exceeded: free-models-per-day. Add 10 credits"));
    const classified = classifyProviderError(err);
    expect(classified.class).toBe("rate_limit");
    expect(isTransientApiFailure(classified.class)).toBe(true);
  });

  it("a RetryError wrapping a 500 APICallError → network", () => {
    const err = retryError(apiCallError(500, "Internal Server Error"));
    expect(classifyProviderError(err).class).toBe("network");
  });

  it("a RetryError wrapping a TimeoutError → timeout (the REAL error's name, not the wrapper's)", () => {
    const underlying = new Error("The operation was aborted due to timeout");
    underlying.name = "TimeoutError";
    const err = retryError(underlying);
    expect(classifyProviderError(err).class).toBe("timeout");
  });

  it("the wrapper's flattened 'Last error: …' text never classifies alone — the truth is the underlying error", () => {
    // A 401 underlying error whose wrapper text MENTIONS a rate limit-ish
    // phrase: the old classifier (message-only) would have said rate_limit.
    const underlying = apiCallError(401, "User not found.");
    const wrapper = retryError(underlying);
    expect(classifyProviderError(wrapper).class).toBe("auth");
  });

  it("the status walk is cycle-safe and never throws", () => {
    const underlying = apiCallError(429, "quota");
    const wrapper = retryError(underlying);
    (wrapper as Error & { cause?: unknown }).cause = wrapper; // cycle through cause
    expect(() => classifyProviderError(wrapper)).not.toThrow();
    expect(classifyProviderError(wrapper).class).toBe("rate_limit");
  });
});

/* ── the 403 refinement ───────────────────────────────────────────────────── */

describe("R78: the 403 refinement (region/access vs auth)", () => {
  it("403 'not available in your region' → unknown (NOT auth), with the REAL text", () => {
    // The live probe that motivated the round: OpenRouter's paid-model 403
    // classified as auth — a lying message.
    const err = apiCallError(403, "This model is not available in your region.");
    const classified = classifyProviderError(err);
    expect(classified.class).toBe("unknown");
    expect(classified.userMessage).toContain("not available in your region");
    // Fail-fast: a region block is never ladder-transient.
    expect(isTransientApiFailure(classified.class)).toBe(false);
  });

  it("other region/moderation/permission/unavailable/blocked 403 bodies → unknown", () => {
    for (const message of [
      "This model has been blocked by moderation",
      "You do not have permission to access this model",
      "This model is not available on your current plan",
      "The requested model is unavailable",
    ]) {
      expect(classifyProviderError(apiCallError(403, message)).class).toBe("unknown");
    }
  });

  it("a PLAIN 403 (no region/access wording) stays auth", () => {
    expect(classifyProviderError(apiCallError(403, "Forbidden")).class).toBe("auth");
  });

  it("401 stays status-only auth (even when the body quotes region-ish words)", () => {
    expect(classifyProviderError(apiCallError(401, "User not found.")).class).toBe("auth");
    // The refinement is 403-ONLY: a 401 that says "not available" is still a
    // key rejection by status (cline's rule).
    expect(classifyProviderError(apiCallError(401, "account not available")).class).toBe("auth");
  });

  it("a RetryError-wrapped 403 region block ALSO refines (unwrap happens first)", () => {
    const err = retryError(apiCallError(403, "This model is not available in your region."));
    expect(classifyProviderError(err).class).toBe("unknown");
  });
});

/* ── honest userMessage (the real provider text) ──────────────────────────── */

describe("R78: userMessage is the REAL provider text", () => {
  it("a 429 whose body says 'Rate limit exceeded: free-models-per-day. Add 10 credits' carries THAT text", () => {
    const real = "Rate limit exceeded: free-models-per-day. Add 10 credits to get more";
    const classified = classifyProviderError(apiCallError(429, real));
    expect(classified.class).toBe("rate_limit");
    expect(classified.userMessage).toContain("Rate limit exceeded: free-models-per-day");
    // NOT the generic one-liner — the owner's exact complaint.
    expect(classified.userMessage).not.toBe(CLASS_MESSAGES.rate_limit);
  });

  it("truncates the real text at 600 chars with an ellipsis (R80 raised 240 → 600)", () => {
    const long = "R".repeat(900);
    const classified = classifyProviderError(apiCallError(429, long));
    expect(classified.userMessage.length).toBe(601); // 600 + ellipsis
    expect(classified.userMessage.endsWith("…")).toBe(true);
    // A 600-char real message now rides WHOLE (the R80 raw-visibility ask).
    expect(classifyProviderError(apiCallError(429, "R".repeat(600))).userMessage.length).toBe(600);
  });

  it("an empty real message falls back to the generic class line", () => {
    const silent = apiCallError(429, "");
    expect(classifyProviderError(silent).userMessage).toBe(CLASS_MESSAGES.rate_limit);
    const silentAuth = apiCallError(401, "");
    expect(classifyProviderError(silentAuth).userMessage).toBe(CLASS_MESSAGES.auth);
  });

  it("a RetryError whose underlying error has NO message falls back to the WRAPPER's text", () => {
    const underlying = new Error("");
    underlying.name = "AI_APICallError";
    (underlying as Error & { statusCode?: number }).statusCode = 500;
    const wrapper = retryError(underlying);
    // The wrapper's own message is real evidence — better than the generic line.
    expect(classifyProviderError(wrapper).userMessage).toContain("Failed after 5 attempts");
  });
});

/* ── model-availability wording (the 404 probe) ───────────────────────────── */

describe("R78: model-availability 404", () => {
  it("404 'unavailable for free' stays unknown (fail-fast) with the REAL text", () => {
    const err = apiCallError(404, "This model is unavailable for free users — add credits or pick a free model");
    const classified = classifyProviderError(err);
    expect(classified.class).toBe("unknown");
    expect(classified.userMessage).toContain("unavailable for free");
    expect(isTransientApiFailure(classified.class)).toBe(false);
  });
});

/* ── providerErrorDetail unwraps + scrubs ────────────────────────────────── */

describe("R78: providerErrorDetail unwraps the RetryError", () => {
  it("returns the underlying body, NOT 'Failed after N attempts. Last error: …'", () => {
    const underlying = apiCallError(429, "Rate limit exceeded: free-models-per-day");
    const detail = providerErrorDetail(retryError(underlying), "sk-test-key");
    expect(detail).toContain("Rate limit exceeded: free-models-per-day");
    expect(detail).not.toContain("Failed after 5 attempts");
  });

  it("still scrubs the API key out of the real text", () => {
    const underlying = apiCallError(401, "User not found (key sk-live-abcdef123)");
    const detail = providerErrorDetail(underlying, "sk-live-abcdef123");
    expect(detail).toContain("***");
    expect(detail).not.toContain("sk-live-abcdef123");
  });

  it("a non-RetryError keeps today's behavior (message + scrub + the R80 4000-char cap)", () => {
    const detail = providerErrorDetail(new Error("plain failure"), "nope");
    expect(detail).toBe("plain failure");
    // R80 (owner: "raw messages should be shown too"): 500 → 4000 — a
    // 600-char body rides WHOLE (the old cap truncated real payloads).
    const ridesWhole = providerErrorDetail(new Error("x".repeat(600)), "nope");
    expect(ridesWhole.length).toBe(600);
    const long = providerErrorDetail(new Error("x".repeat(4500)), "nope");
    expect(long.length).toBe(4001); // 4000 + ellipsis
  });
});
