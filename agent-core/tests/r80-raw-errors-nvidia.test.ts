/**
 * ROUND-80 (R80): the RAW-error caps and the NVIDIA provider — the owner's
 * asks "for error messages raw messages should be shown too" and "make sure
 * it works with the nvidia api key too".
 *
 *  · providerErrorDetail: the 4000-char cap (was 500 — the R77 expand
 *    toggle was revealing a truncated payload); an nvapi-/sk- key is
 *    scrubbed anywhere it appears.
 *  · classifyProviderError's userMessage: the 600-char cap (was 240).
 *  · The NVIDIA built-in seed: the row exists on every fresh database with
 *    the integrate.api.nvidia.com/v1 base URL + chat-completions format,
 *    the id is RESERVED (custom rows cannot claim it), and the keyring
 *    reads ACUTE_PROVIDER_NVIDIA.
 *  · The nvapi- scrub pattern (chat.ts summarizeToolOutput).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { providerErrorDetail, classifyProviderError } from "../src/agents/error-classification";
import { listProviderRecords, RESERVED_PROVIDER_IDS } from "../src/storage/providers";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r80raw";
let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r80raw-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({}),
  });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function authInject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/* ── The raw-error caps ──────────────────────────────────────────────────── */

describe("R80: providerErrorDetail carries the RAW provider text (cap 4000, was 500)", () => {
  it("a 2500-char provider body survives UNTRUNCATED (the UI's expand toggle now reveals the real payload)", () => {
    const longBody = `429 Too Many Requests: ${"quota storm detail ".repeat(120)}`.slice(0, 2500);
    const detail = providerErrorDetail(new Error(longBody), "sk-irrelevant");
    expect(detail.length).toBe(longBody.length);
    expect(detail).toContain("quota storm detail");
  });

  it("a truly giant body still caps at 4000 (frames and rows stay bounded)", () => {
    const giant = "x".repeat(6000);
    const detail = providerErrorDetail(new Error(giant), "sk-irrelevant");
    expect(detail.length).toBe(4001); // 4000 + the ellipsis
    expect(detail.endsWith("…")).toBe(true);
  });

  it("an API key quoted anywhere in the body is scrubbed — including an nvapi- key", () => {
    const body = `NVIDIA NIM 401: invalid key nvapi-yJpvQvoFAKEFAKEFAKE for model llama`;
    const nvapiScrubbed = providerErrorDetail(new Error(body), "nvapi-yJpvQvoFAKEFAKEFAKE");
    expect(nvapiScrubbed).not.toContain("nvapi-yJpvQvoFAKEFAKEFAKE");
    expect(nvapiScrubbed).toContain("***");
    // The value-based split covers ANY key shape (nvapi- included) even
    // without a regex — the R80 nvapi- patterns are defense-in-depth.
    const skBody = `401: bad key sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa`;
    expect(providerErrorDetail(new Error(skBody), "sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa")).not.toContain(
      "sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });
});

describe("R80: the honest userMessage cap is 600 (was 240)", () => {
  it("a 500-char real message survives as the class line", () => {
    const message = `rate limit exceeded: ${"detail ".repeat(70)}`.slice(0, 500);
    const classification = classifyProviderError(
      (() => {
        const err = new Error(message);
        (err as Error & { statusCode?: number }).statusCode = 429;
        return err;
      })(),
    );
    expect(classification.class).toBe("rate_limit");
    expect(classification.userMessage.length).toBeGreaterThanOrEqual(500);
  });

  it("a 700-char message truncates at 600 + ellipsis (one card line, still honest)", () => {
    const message = "y".repeat(700);
    const classification = classifyProviderError(new Error(message));
    expect(classification.userMessage.length).toBe(601);
    expect(classification.userMessage.endsWith("…")).toBe(true);
  });
});

/* ── The NVIDIA built-in provider ───────────────────────────────────────── */

describe("R80: the NVIDIA built-in provider (the nvapi- support)", () => {
  it("the nvidia row is seeded on every fresh database with the NIM base URL + chat-completions format", () => {
    const records = listProviderRecords(db);
    const nvidia = records.find((r) => r.id === "nvidia");
    expect(nvidia).toBeDefined();
    expect(nvidia?.name).toBe("NVIDIA");
    expect(nvidia?.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(nvidia?.apiFormat ?? "chat-completions").toBe("chat-completions");
    expect(nvidia?.enabled).toBe(true);
  });

  it("the nvidia id is RESERVED (custom rows may never claim it)", async () => {
    expect(RESERVED_PROVIDER_IDS).toContain("nvidia");
    // The route side of the same rule: creating a custom "nvidia" row 409s.
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "nvidia", name: "Fake NVIDIA", baseUrl: "https://evil.example/v1" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("the keyring reads ACUTE_PROVIDER_NVIDIA (the env-injection contract — keys.rs + dev.mjs)", async () => {
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_NVIDIA: "nvapi-test-key-1234567890" });
    expect(keyring.has("nvidia")).toBe(true);
    expect(keyring.get("nvidia")).toBe("nvapi-test-key-1234567890");
    expect(ProviderKeyring.envVarName("nvidia")).toBe("ACUTE_PROVIDER_NVIDIA");
    // GET /providers shows the row with hasKey reflecting the keyring.
    const response = await authInject({ method: "GET", url: "/api/v1/providers" });
    const providers = response.json().providers as Array<{ id: string; hasKey: boolean }>;
    const row = providers.find((p) => p.id === "nvidia");
    expect(row).toBeDefined();
    expect(row?.hasKey).toBe(false); // this app instance was built with no keys
  });
});
