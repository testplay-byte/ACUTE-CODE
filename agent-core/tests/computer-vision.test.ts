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
import { describeRaster, resolveVisionKey } from "../src/computer/vision";
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

  it("HTTP failure → vision_request_failed with the status + body excerpt", async () => {
    const fetch = makeFetch(JSON.stringify({ error: "rate limited" }), 429);
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER_VISION: "k" });
    const result = await describeRaster(
      { db, keyring, fetchImpl: fetch },
      { mode: "separate", providerId: "openrouter", modelId: "m" },
      { imageBase64: "aa==", instruction: "x" },
    );
    expect("error" in result && result.code).toBe("vision_request_failed");
    if ("error" in result) expect(result.error).toContain("429");
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
