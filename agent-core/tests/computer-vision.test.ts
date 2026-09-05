/**
 * ROUND-61 (R61): the VISION relay tests — the owner's separation model:
 * off (honest refusal), separate (the dedicated provider/model/key via the
 * <providerId>-vision keyring slot), main (the turn's model ONLY when its
 * row has supports_vision). Both wire formats (chat-completions with an
 * image_url part, anthropic-messages with a base64 source) get a case.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { ProviderKeyring } from "../src/providers/registry";
import { describeRaster, resolveVisionKey, setVisionRetryDelaysForTest, resetVisionRetryDelaysForTest, VISION_RETRY_DELAYS_MS } from "../src/computer/vision";
import { listModels, upsertModel } from "../src/storage/models";
import type { VisionFetch } from "../src/computer/vision";

let db: SqliteDatabase;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-vision-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** A fetch that records the request and answers with a fixed completion. */
function makeFetch(response: string, status = 200): VisionFetch & { calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl: VisionFetch = async (url, init) => {
    calls.push({
      url,
      body: init.body !== undefined ? JSON.parse(String(init.body)) : null,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return new Response(response, { status, statusText: status === 200 ? "OK" : "ERR" });
  };
  return Object.assign(fetchImpl, { calls });
}

describe("ROUND-61 (R61): resolveVisionKey — the separate-key slot", () => {
  it("separate mode: the DEDICATED <providerId>-vision slot wins; primary is the fallback", () => {
    const keyring = new ProviderKeyring({
      ACUTE_PROVIDER_OPENROUTER_VISION: "vision-key",
      ACUTE_PROVIDER_OPENROUTER: "primary-key",
    });
    expect(resolveVisionKey(keyring, "openrouter", "separate")).toBe("vision-key");
    const onlyPrimary = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "primary-key" });
    expect(resolveVisionKey(onlyPrimary, "openrouter", "separate")).toBe("primary-key");
  });

  it("main mode: the provider's primary key", () => {
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "primary-key" });
    expect(resolveVisionKey(keyring, "openrouter", "main")).toBe("primary-key");
  });
});

describe("ROUND-61 (R61): describeRaster — chat-completions wire format", () => {
  it("separate mode: POSTs provider chat/completions with the image_url part + returns the text", async () => {
    const fetch = makeFetch(
      JSON.stringify({ choices: [{ message: { content: "A save dialog with a File name field" } }] }),
    );
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER_VISION: "sk-vision" });
    const result = await describeRaster(
      { db, keyring, fetchImpl: fetch, visionKeyringId: "openrouter-vision" },
      { mode: "separate", providerId: "openrouter", modelId: "google/gemini-2.5-flash" },
      { imageBase64: "aGVsbG8=", instruction: "Describe the dialog" },
    );
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.text).toContain("File name field");
      expect(result.model).toBe("google/gemini-2.5-flash");
      expect(result.mode).toBe("separate");
      expect(result.ms).toBeGreaterThanOrEqual(0);
    }
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.headers["authorization"]).toBe("Bearer sk-vision");
    const body = call.body as { model: string; messages: Array<{ role: string; content: unknown }> };
    expect(body.model).toBe("google/gemini-2.5-flash");
    const user = body.messages.find((m) => m.role === "user");
    const content = user?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(content.some((c) => c.type === "text" && c.text === "Describe the dialog")).toBe(true);
    expect(content.some((c) => c.type === "image_url" && c.image_url?.url === "data:image/png;base64,aGVsbG8=")).toBe(true);
  });

  it("no key → vision_no_key (never an empty-authorization call)", async () => {
    const fetch = makeFetch("{}");
    const result = await describeRaster(
      { db, keyring: new ProviderKeyring({}), fetchImpl: fetch },
      { mode: "separate", providerId: "openrouter", modelId: "m" },
      { imageBase64: "aa==", instruction: "x" },
    );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.code).toBe("vision_no_key");
    expect(fetch.calls).toHaveLength(0);
  });

  it("missing provider row → vision_no_provider", async () => {
    const result = await describeRaster(
      { db, keyring: new ProviderKeyring({}), fetchImpl: makeFetch("{}") },
      { mode: "separate", providerId: "ghost", modelId: "m" },
      { imageBase64: "aa==", instruction: "x" },
    );
    expect("error" in result && result.code).toBe("vision_no_provider");
  });

  it("HTTP failure → vision_request_failed with the status + body excerpt (ALL attempts 429 — the retry exhausts)", async () => {
    // R68-C (C6): 429 is RETRYABLE now — the single-response fetch here
    // answers 429 for every attempt, so the relay burns its two retries
    // and STILL fails honestly. The delays are shrunk via the test hook so
    // this pins the semantics without sleeping 4.5s.
    setVisionRetryDelaysForTest([0, 0]);
    try {
      const fetch = makeFetch(JSON.stringify({ error: "rate limited" }), 429);
      const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER_VISION: "k" });
      const result = await describeRaster(
        { db, keyring, fetchImpl: fetch },
        { mode: "separate", providerId: "openrouter", modelId: "m" },
        { imageBase64: "aa==", instruction: "x" },
      );
      expect("error" in result && result.code).toBe("vision_request_failed");
      if ("error" in result) expect(result.error).toContain("429");
      // Three POSTs: the attempt + the two retries.
      expect(fetch.calls).toHaveLength(3);
    } finally {
      resetVisionRetryDelaysForTest();
    }
  });

  it("empty content → vision_request_failed (never an empty success)", async () => {
    const fetch = makeFetch(JSON.stringify({ choices: [{ message: { content: "" } }] }));
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER_VISION: "k" });
    const result = await describeRaster(
      { db, keyring, fetchImpl: fetch },
      { mode: "separate", providerId: "openrouter", modelId: "m" },
      { imageBase64: "aa==", instruction: "x" },
    );
    expect("error" in result && result.code).toBe("vision_request_failed");
  });
});

describe("ROUND-61 (R61): describeRaster — anthropic wire format", () => {
  it("anthropic-messages: x-api-key + base64 image source", async () => {
    const fetch = makeFetch(
      JSON.stringify({ content: [{ type: "text", text: "the panel is open" }] }),
    );
    // The anthropic built-in provider row (seeded at open, apiFormat
    // anthropropic-messages + its baseUrl) — no custom insert needed.
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_ANTHROPIC: "ak" });
    const result = await describeRaster(
      { db, keyring, fetchImpl: fetch },
      { mode: "main", providerId: "anthropic", modelId: "claude-sonnet-4" },
      { imageBase64: "aGVsbG8=", instruction: "what do you see" },
    );
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.text).toBe("the panel is open");
    const call = fetch.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe("ak");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    const body = call.body as { messages: Array<{ content: Array<{ type: string; source?: { data: string } }> }> };
    const image = body.messages[0]?.content.find((c) => c.type === "image");
    expect(image?.source?.data).toBe("aGVsbG8=");
  });
});

describe("ROUND-61 (R61): main-mode gating — supports_vision on the model row", () => {
  it("a model row with supports_vision=false is refused (the honest gate)", () => {
    // The gate itself is implemented in the plugin's relayVision; the ROW
    // flag round-trips through upsertModel + listModels.
    upsertModel(db, "openrouter", { modelId: "text-only-model", supportsVision: false });
    upsertModel(db, "openrouter", { modelId: "vision-model", supportsVision: true });
    const rows = listModels(db, "openrouter");
    expect(rows.find((m) => m.modelId === "text-only-model")?.supportsVision).toBe(false);
    expect(rows.find((m) => m.modelId === "vision-model")?.supportsVision).toBe(true);
  });

  it("catalog prefill: a known vision model inserted without the flag gets supports_vision=true", () => {
    // "google/gemini-2.5-flash" is in the catalog with supportsVision.
    upsertModel(db, "openrouter", { modelId: "google/gemini-2.5-flash" });
    expect(listModels(db, "openrouter").find((m) => m.modelId === "google/gemini-2.5-flash")?.supportsVision).toBe(true);
  });
});

/* ── R68-C (C6): the 429/5xx retry — the owner's trace had "Vision ──────────
 * rate-limited (429)" killing observations MID-FLOW. One 429 no longer
 * ends the observation: up to 2 retries with backoff (the delays are
 * shrunk via the test hook — no sleeping in tests). */

describe("ROUND-68 (R68-C): describeRaster retries 429/5xx (terminal 4xx fails fast)", () => {
  /** Answers the first `failTimes` calls with the status, then succeeds. */
  function flakyFetch(failStatus: number, failTimes: number, successBody: string): VisionFetch & { callCount: () => number } {
    let calls = 0;
    const fetchImpl: VisionFetch = async (_url, _init) => {
      calls += 1;
      if (calls <= failTimes) {
        return new Response(JSON.stringify({ error: "rate limited" }), { status: failStatus, statusText: "ERR" });
      }
      return new Response(successBody, { status: 200, statusText: "OK" });
    };
    return Object.assign(fetchImpl, { callCount: () => calls });
  }

  const COMPLETION = JSON.stringify({ choices: [{ message: { content: "A save dialog with a File name field" } }] });

  it("429 ONCE then success → the retry RECOVERS the observation (the owner's live failure shape)", async () => {
    setVisionRetryDelaysForTest([0, 0]);
    try {
      const fetch = flakyFetch(429, 1, COMPLETION);
      const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER_VISION: "k" });
      const result = await describeRaster(
        { db, keyring, fetchImpl: fetch },
        { mode: "separate", providerId: "openrouter", modelId: "m" },
        { imageBase64: "aa==", instruction: "x" },
      );
      expect("error" in result).toBe(false);
      if (!("error" in result)) expect(result.text).toContain("File name field");
      expect(fetch.callCount()).toBe(2); // the attempt + ONE retry
    } finally {
      resetVisionRetryDelaysForTest();
    }
  });

  it("5xx is retryable too (503 overload then success)", async () => {
    setVisionRetryDelaysForTest([0, 0]);
    try {
      const fetch = flakyFetch(503, 2, COMPLETION); // both retries needed
      const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER_VISION: "k" });
      const result = await describeRaster(
        { db, keyring, fetchImpl: fetch },
        { mode: "separate", providerId: "openrouter", modelId: "m" },
        { imageBase64: "aa==", instruction: "x" },
      );
      expect("error" in result).toBe(false);
      expect(fetch.callCount()).toBe(3); // attempt + two retries
    } finally {
      resetVisionRetryDelaysForTest();
    }
  });

  it("4xx OTHER than 429 is TERMINAL — one attempt, no retry (auth/shape errors fail fast)", async () => {
    setVisionRetryDelaysForTest([0, 0]);
    try {
      const fetch = flakyFetch(401, 5, COMPLETION);
      const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER_VISION: "k" });
      const result = await describeRaster(
        { db, keyring, fetchImpl: fetch },
        { mode: "separate", providerId: "openrouter", modelId: "m" },
        { imageBase64: "aa==", instruction: "x" },
      );
      expect("error" in result && result.code).toBe("vision_request_failed");
      if ("error" in result) expect(result.error).toContain("401");
      expect(fetch.callCount()).toBe(1); // NEVER retried
    } finally {
      resetVisionRetryDelaysForTest();
    }
  });

  it("the ANTHROPIC wire format rides the SAME retry loop (both formats share attempt())", async () => {
    setVisionRetryDelaysForTest([0, 0]);
    try {
      const anthropicBody = JSON.stringify({ content: [{ type: "text", text: "the panel is open" }] });
      const fetch = flakyFetch(529, 1, anthropicBody); // anthropic's overload status, 5xx-class
      const keyring = new ProviderKeyring({ ACUTE_PROVIDER_ANTHROPIC: "ak" });
      const result = await describeRaster(
        { db, keyring, fetchImpl: fetch },
        { mode: "main", providerId: "anthropic", modelId: "claude-sonnet-4" },
        { imageBase64: "aGVsbG8=", instruction: "what do you see" },
      );
      expect("error" in result).toBe(false);
      if (!("error" in result)) expect(result.text).toBe("the panel is open");
      expect(fetch.callCount()).toBe(2);
    } finally {
      resetVisionRetryDelaysForTest();
    }
  });

  it("VISION_RETRY_DELAYS_MS ships the documented backoff; the hook restores it", () => {
    expect([...VISION_RETRY_DELAYS_MS]).toEqual([1500, 3000]);
    setVisionRetryDelaysForTest([1, 2]);
    resetVisionRetryDelaysForTest();
    // The reset restores the SHIPPED values (the mutation is copy-on-set —
    // the exported const itself is never mutated).
    expect([...VISION_RETRY_DELAYS_MS]).toEqual([1500, 3000]);
  });
});
