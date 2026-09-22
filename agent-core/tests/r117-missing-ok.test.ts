// @vitest-environment node
//
// ROUND-117 (R117-e) — deliverable 3: the MISSING-OK HONESTY FOLD
// (agents/chat.ts foldToolOk, applied at BOTH folds — extractToolCalls on
// the sync adapter's steps + the streamed adapter's tool-result parts).
//
// Pre-R117 a tool result whose output lacked an `ok` field silently folded
// to SUCCESS. The least-lie policy pinned here:
//   - object WITH ok    → the honest boolean, no tag (unchanged behavior);
//   - object WITHOUT ok → ok stays TRUE but the outputSummary is TAGGED
//                         " (result shape unverified)" — the model + the
//                         transcript both see it; logged ONCE per tool name
//                         (console.warn) + recorded into the diagnostics
//                         ring (kind "tool-shape"), re-reported at the 10th
//                         occurrence with the running count;
//   - plain STRING      → ok:true, UNTAGGED — the historical convention the
//                         tool suites treat as success BY DESIGN (the fold
//                         was deliberately narrowed to objects).
//
// The "ai" module is mocked at the boundary (the chat-format.test.ts
// pattern) — both adapters are driven with hand-shaped steps/streams.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createOpenAICompatibleMock = vi.hoisted(() =>
  vi.fn(() => ({
    chatModel: (model: string) => ({ kind: "openai-compatible", model }),
  })),
);
const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

import { aiSdkChat, resetUnverifiedShapeTrackingForTest, streamAiSdkChat } from "../src/agents/chat";
import { registerDiagnosticSink } from "../src/lib/diagnostics-sink";

const baseInput = {
  apiKey: "sk-test",
  model: "test/model-1",
  system: "You are terse.",
  messages: [{ role: "user" as const, content: "hi" }],
  temperature: 0.2,
  maxTurns: 4,
};

/** The ring entries captured by the (module-level) sink during a test. */
let captured: Array<{ kind: string; message: string }>;

beforeEach(() => {
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: "ok",
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    steps: [],
  });
  streamTextMock.mockReset();
  streamTextMock.mockImplementation(() => ({
    fullStream: (async function* () {})(),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
  }));
  resetUnverifiedShapeTrackingForTest();
  captured = [];
  registerDiagnosticSink((entry) => {
    captured.push({ kind: entry.kind, message: entry.message });
  });
});

afterEach(() => {
  registerDiagnosticSink(null);
  vi.restoreAllMocks();
});

describe("R117-e: the missing-ok fold — the SYNC adapter (extractToolCalls)", () => {
  it("object WITH ok → the honest boolean, NO tag (byte-identical pre-R117 behavior)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      steps: [
        {
          toolResults: [
            { toolName: "read_file", input: { path: "a.md" }, output: { ok: true, output: "10 chars" } },
            { toolName: "run_command", input: { command: "x" }, output: { ok: false, output: "exit 1" } },
          ],
        },
      ],
    });
    const result = await aiSdkChat({ ...baseInput, provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } });
    expect(result.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ["read_file", true],
      ["run_command", false],
    ]);
    expect(result.toolCalls[0].outputSummary).toBe("10 chars");
    expect(result.toolCalls[1].outputSummary).toBe("exit 1");
    // Nothing reached the ring.
    expect(captured).toHaveLength(0);
  });

  it("object WITHOUT ok → ok stays true BUT the summary is tagged (result shape unverified)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      steps: [
        {
          toolResults: [
            { toolName: "fx_weird", input: {}, output: { rows: ["a"], truncated: false } },
          ],
        },
      ],
    });
    const result = await aiSdkChat({ ...baseInput, provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } });
    const first = result.toolCalls[0];
    if (first === undefined) throw new Error("expected a tool call");
    expect(first.ok).toBe(true);
    expect(first.outputSummary ?? "").toContain("rows");
    expect((first.outputSummary ?? "").endsWith("(result shape unverified)")).toBe(true);
  });

  it("plain STRING output → ok:true, UNTAGGED (the historical by-design convention)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      steps: [
        { toolResults: [{ toolName: "legacy_tool", input: {}, output: "just a string" }] },
      ],
    });
    const result = await aiSdkChat({ ...baseInput, provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } });
    expect(result.toolCalls[0].ok).toBe(true);
    expect(result.toolCalls[0].outputSummary).toBe("just a string");
    expect(captured).toHaveLength(0);
  });

  it("logged ONCE per tool name + recorded into the diagnostics ring (kind tool-shape)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i += 1) {
      generateTextMock.mockResolvedValueOnce({
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        steps: [
          { toolResults: [{ toolName: "fx_repeat", input: {}, output: { nope: i } }] },
        ],
      });
      const result = await aiSdkChat({
        ...baseInput,
        provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
      });
      // EVERY occurrence is tagged — the per-result honesty never quiets down.
      expect(result.toolCalls[0]!.outputSummary).toContain("(result shape unverified)");
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("fx_repeat");
    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("tool-shape");
    expect(captured[0].message).toContain("fx_repeat");
    expect(captured[0].message).toContain("first occurrence");
  });

  it("the 10th occurrence RE-REPORTS with the running count (a persistent offender stays visible)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 10; i += 1) {
      generateTextMock.mockResolvedValueOnce({
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        steps: [{ toolResults: [{ toolName: "fx_runaway", input: {}, output: { i } }] }],
      });
      await aiSdkChat({ ...baseInput, provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } });
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain("10 occurrences");
    expect(captured).toHaveLength(2);
    expect(captured[1].message).toContain("10 occurrences");
  });
});

describe("R117-e: the missing-ok fold — the STREAMED adapter (the tool-result part)", () => {
  /** Drive streamAiSdkChat with a hand-shaped fullStream of tool-result parts. */
  async function streamWithOutputs(
    outputs: unknown[],
    toolName = "fx_stream",
  ): Promise<Array<{ ok: boolean; outputSummary: string }>> {
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        for (const output of outputs) {
          yield { type: "tool-result", toolName, input: {}, output };
        }
        yield { type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 } };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    }));
    const frames: Array<{ ok: boolean; outputSummary: string }> = [];
    for await (const event of streamAiSdkChat({
      ...baseInput,
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    })) {
      if (event.type === "tool-result") {
        frames.push({ ok: event.ok, outputSummary: event.outputSummary ?? "" });
      }
    }
    return frames;
  }

  it("object WITH ok → honest boolean, no tag; object WITHOUT ok → tagged, ok stays true; string → untagged success", async () => {
    const frames = await streamWithOutputs([
      { ok: true, output: "fine" },
      { ok: false, output: "broken" },
      { rows: 7 },
      "a plain string",
    ]);
    expect(frames).toHaveLength(4);
    expect(frames[0]).toEqual({ ok: true, outputSummary: "fine" });
    expect(frames[1]).toEqual({ ok: false, outputSummary: "broken" });
    expect(frames[2].ok).toBe(true);
    expect(frames[2].outputSummary.endsWith("(result shape unverified)")).toBe(true);
    expect(frames[3]).toEqual({ ok: true, outputSummary: "a plain string" });
  });

  it("the streamed fold feeds the SAME ring path (kind tool-shape)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await streamWithOutputs([{ anything: "object" }]);
    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe("tool-shape");
    expect(captured[0].message).toContain("fx_stream");
  });
});
