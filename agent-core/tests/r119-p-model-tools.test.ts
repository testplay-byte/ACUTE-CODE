/**
 * ROUND-119 (R119-P) — the TOOLS leg of POST /api/v1/models/:id/test (the
 * round-119 §1 item F fix; round-119.md §2 Track P):
 *
 * The owner's TokenHarbor report: plain chat worked on his device
 * (https://tokenharbor.ai/v1, model qwen3.8-flash:free) while every agent
 * ACTION failed — and the R82 probe never sent tools, so "Test model ✓"
 * proved nothing about the agent's real call shape. The probe now runs a
 * SECOND bounded call after the pong phase succeeds, carrying ONE minimal
 * tool (echo — one required string arg) and an inviting prompt. This suite
 * pins:
 *
 *   · (a) chat-completions accepting the tools request + the model CALLING
 *     echo → toolsAccepted:true + toolCalled:true, no note — and the exact
 *     request body the wire sees (system+user messages, the tools array,
 *     tool_choice:"auto", the same 64-token cap);
 *   · (b) THE TokenHarbor action-failure shape: the pong phase passes, the
 *     tools request is hard-rejected (HTTP 400) → ok:false with the RAW
 *     provider body in the reason + the "chat works, but every agent action
 *     will fail" verdict suffix;
 *   · (c) accepted-but-text: the model answers in words instead of calling
 *     → ok STAYS true (a working chat model) + the honest note quoting what
 *     it answered;
 *   · (d) the anthropic-messages and responses dialects: the exact tools
 *     bodies ({name,description,input_schema} + tool_choice:{type:"auto"} +
 *     top-level system; {type:"function",name,description,parameters} +
 *     tool_choice:"auto" + instructions) and their tool-call readers
 *     (content[] tool_use block; output[] function_call item);
 *   · the tools-leg transport failure (pong ok, the tools call throws) →
 *     ok:false with the softer "could not be verified" reason;
 *   · the SCRUB pin: a tools-rejection body quoting the key is masked.
 *
 * Route-level app.inject patterns follow r82-model-test.test.ts (the suite
 * this one extends).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  createProviderRecord,
  getProviderRecord,
  updateProviderRecord,
} from "../src/storage/providers";
import { upsertModel } from "../src/storage/models";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r119p";
// Key shapes ≥16 chars past the prefix so the secret-SHAPE regexes can fire.
const KEY = "sk-or-vtest-r119p-0123456789";
const GW_ID = "prv_gw";
const GW_BASE = "https://gw.example.test/v1";
const GW_MODEL = "test/gw-model";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r119p-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  createProviderRecord(db, { id: GW_ID, name: "Test Gateway", baseUrl: GW_BASE });
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({
      ACUTE_PROVIDER_OPENROUTER: KEY,
      ACUTE_PROVIDER_PRV_GW: KEY,
      ACUTE_PROVIDER_ANTHROPIC: KEY,
    }),
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
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
  method: "GET" | "POST" | "PATCH";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** A configured model row (the mdl_… id the route addresses). */
function makeModelRow(providerId = GW_ID, modelId = GW_MODEL): string {
  return upsertModel(db, providerId, { modelId }).id;
}

/** The pong phase's healthy chat-completions 200 body. */
function chatOkBody(text = "pong"): Record<string, unknown> {
  return {
    choices: [{ message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 9, completion_tokens: 1 },
  };
}

/** The tools leg's happy chat-completions body — the model CALLED echo. */
function chatToolCallBody(): Record<string, unknown> {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_echo_1",
              type: "function",
              function: { name: "echo", arguments: '{"text":"hello"}' },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 21, completion_tokens: 12 },
  };
}

/** The two-phase fetch mock: call 1 = the pong body, call 2+ = the tools
 * body (or a Response factory for the rejection cases). */
function twoPhaseFetch(first: Record<string, unknown>, second: Response): {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: Array<[string, RequestInit | undefined]>;
} {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit | undefined) => {
    calls.push([url, init]);
    if (calls.length === 1) {
      return new Response(JSON.stringify(first), { status: 200 });
    }
    return second;
  });
  return { fetchMock, calls };
}

describe("R119-P: the tools leg — chat-completions", () => {
  it("(a) the provider accepts the tools request AND the model calls echo → toolsAccepted + toolCalled, no note; the request body is pinned", async () => {
    const rowId = makeModelRow();
    const { fetchMock, calls } = twoPhaseFetch(chatOkBody(), new Response(JSON.stringify(chatToolCallBody()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({
      http: true,
      auth: true,
      modelAccepted: true,
      nonEmptyContent: true,
      toolsAccepted: true,
      toolCalled: true,
    });
    // The pong preview rides the result as always; the happy tools leg adds
    // NO note (the checks carry the verdict).
    expect(body.contentPreview).toBe("pong");
    expect(body.note).toBeUndefined();
    // The tools request the wire really saw: the SAME endpoint + key, the
    // system+user invitation, the echo tool definition, tool_choice auto,
    // and the pong phase's own 64-token cap.
    expect(calls).toHaveLength(2);
    const [url, init] = calls[1]!;
    expect(url).toBe(`${GW_BASE}/chat/completions`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: GW_MODEL,
      messages: [
        { role: "system", content: "You must call the echo tool with the text 'hello'." },
        { role: "user", content: "Call the echo tool now with text hello." },
      ],
      max_tokens: 64,
      temperature: 0,
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "echo",
            description: "Echo the text back.",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        },
      ],
      tool_choice: "auto",
    });
  });

  it("(b) THE TokenHarbor shape: pong passes, the tools request is 400'd → ok:false + the raw body + the agent-verdict suffix", async () => {
    const rowId = makeModelRow();
    const { fetchMock } = twoPhaseFetch(
      chatOkBody(),
      new Response(
        JSON.stringify({
          error: { message: "tools are not supported for model qwen3.8-flash:free on this route" },
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The hard verdict: chat is PROVEN (pong) but the agent's call shape is
    // refused — the whole test fails, exactly the "actions fail" report.
    expect(body.ok).toBe(false);
    expect(body.checks).toEqual({
      http: true,
      auth: true,
      modelAccepted: true,
      nonEmptyContent: true,
      toolsAccepted: false,
    });
    // toolCalled is ABSENT (not-run-beyond-the-rejection — never a guess).
    expect(body.checks.toolCalled).toBeUndefined();
    // The R80 raw-messages discipline: the provider's own words ride the
    // reason, suffixed with the honest agent verdict.
    expect(body.reason).toContain("the agent tools request was rejected (HTTP 400)");
    expect(body.reason).toContain("tools are not supported for model qwen3.8-flash:free");
    expect(body.reason).toContain("chat works, but every agent action will fail");
    // The pong phase's evidence is NOT lost — the preview still shows it.
    expect(body.contentPreview).toBe("pong");
  });

  it("(c) accepted-but-text: the model answers in words instead of calling → ok STAYS true + the honest note", async () => {
    const rowId = makeModelRow();
    const answer = "I would rather just reply with hello.";
    const { fetchMock } = twoPhaseFetch(chatOkBody(), new Response(JSON.stringify(chatOkBody(answer)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // A working CHAT model that ignored the tool invitation: the test does
    // NOT fail on toolCalled alone — the note says what it is.
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({
      http: true,
      auth: true,
      modelAccepted: true,
      nonEmptyContent: true,
      toolsAccepted: true,
      toolCalled: false,
    });
    expect(body.note).toBe(
      'tools accepted — the model answered in text instead of calling the echo tool ("I would rather just reply with hello.") — usable for chat, NOT for agent actions',
    );
  });

  it("the tools-leg transport failure (pong ok, the tools call throws) → ok:false with the softer could-not-verify reason", async () => {
    const rowId = makeModelRow();
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify(chatOkBody()), { status: 200 });
      }
      throw new Error("connect ETIMEDOUT");
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.toolsAccepted).toBe(false);
    expect(body.reason).toContain("failed before reaching the provider");
    expect(body.reason).toContain("ETIMEDOUT");
    // The softer suffix — NOT the hard "every agent action will fail" line
    // (a transport hiccup seconds after a working pong is unverified, not
    // a provider refusal).
    expect(body.reason).toContain("could not be verified");
    expect(body.reason).not.toContain("every agent action will fail");
  });

  it("SCRUB PIN: a tools-rejection body echoing the KEY is masked — no unmasked key anywhere in the response", async () => {
    const rowId = makeModelRow();
    const { fetchMock } = twoPhaseFetch(
      chatOkBody(),
      new Response(
        JSON.stringify({ error: { message: `key ${KEY} may not use tools` } }),
        { status: 422 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(false);
    expect(response.json().reason).toContain("HTTP 422");
    // THE invariant: the unmasked key NEVER reaches the response.
    expect(response.body).not.toContain(KEY);
    expect(response.json().reason).toContain("***");
  });
});

describe("R119-P: the tools leg — the anthropic-messages dialect", () => {
  it("(d) posts the anthropic tools body (input_schema + tool_choice:{type:'auto'} + top-level system) and reads a tool_use block", async () => {
    // The seeded built-in anthropic row carries apiFormat
    // "anthropic-messages" + baseUrl https://api.anthropic.com/v1.
    const rowId = makeModelRow("anthropic", "claude-r119-test");
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit | undefined) => {
      calls.push([url, init]);
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "pong" }],
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
          { status: 200 },
        );
      }
      // The tools leg's answer: a tool_use block (no text — irrelevant here).
      return new Response(
        JSON.stringify({
          content: [
            { type: "tool_use", id: "toolu_echo_1", name: "echo", input: { text: "hello" } },
          ],
          usage: { input_tokens: 18, output_tokens: 9 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({
      http: true,
      auth: true,
      modelAccepted: true,
      nonEmptyContent: true,
      toolsAccepted: true,
      toolCalled: true,
    });
    // The anthropic tools dialect, pinned: x-api-key + version headers (the
    // pong phase's own pair), {name,description,input_schema}, the inviting
    // prompt as ONE user turn with the system line TOP-LEVEL (that
    // dialect's convention), tool_choice the OBJECT form.
    expect(calls).toHaveLength(2);
    const [url, init] = calls[1]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "claude-r119-test",
      max_tokens: 64,
      system: "You must call the echo tool with the text 'hello'.",
      messages: [{ role: "user", content: "Call the echo tool now with text hello." }],
      tools: [
        {
          name: "echo",
          description: "Echo the text back.",
          input_schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
      tool_choice: { type: "auto" },
    });
  });
});

describe("R119-P: the tools leg — the responses dialect", () => {
  it("(d) posts the Responses tools body (function envelope + tool_choice:'auto' + instructions) and reads a function_call item", async () => {
    // No builtin row carries the responses format — set it on the custom
    // gateway row (the ProviderRecord.apiFormat escape hatch).
    const gateway = getProviderRecord(db, GW_ID)!;
    updateProviderRecord(db, { ...gateway, apiFormat: "responses" });
    const rowId = makeModelRow();
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit | undefined) => {
      calls.push([url, init]);
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            output_text: "pong",
            usage: { input_tokens: 6, output_tokens: 3 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          output: [
            { type: "function_call", call_id: "call_echo_1", name: "echo", arguments: '{"text":"hello"}' },
          ],
          usage: { input_tokens: 17, output_tokens: 8 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({
      http: true,
      auth: true,
      modelAccepted: true,
      nonEmptyContent: true,
      toolsAccepted: true,
      toolCalled: true,
    });
    // The Responses tools dialect, pinned: the FLAT function envelope
    // ({type:"function", name, description, parameters} — no nested
    // `function` object), tool_choice the STRING form, the system line as
    // `instructions`, the same max_output_tokens cap.
    expect(calls).toHaveLength(2);
    const [url, init] = calls[1]!;
    expect(url).toBe(`${GW_BASE}/responses`);
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: GW_MODEL,
      instructions: "You must call the echo tool with the text 'hello'.",
      input: "Call the echo tool now with text hello.",
      max_output_tokens: 64,
      tools: [
        {
          type: "function",
          name: "echo",
          description: "Echo the text back.",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
      tool_choice: "auto",
    });
  });
});

describe("R119-P: the tools leg — the not-run contract", () => {
  it("a FAILED pong phase skips the leg entirely — the checks carry NO tools fields (never a guess)", async () => {
    const rowId = makeModelRow();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "No endpoints found for the requested model" } }),
            { status: 404 },
          ),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    // Exact equality: toolsAccepted/toolCalled are ABSENT (undefined), not
    // false — "not run" is a different truth than "ran and was refused".
    expect(body.checks).toEqual({
      http: true,
      auth: true,
      modelAccepted: false,
      nonEmptyContent: false,
    });
    expect(body.note).toBeUndefined();
  });
});
