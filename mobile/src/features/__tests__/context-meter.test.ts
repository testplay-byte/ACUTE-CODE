/**
 * context-meter.test.ts — the composer's CONTEXT WINDOW truth (R113-c): the
 * pressure tiers at the desktop ContextDonut's exact thresholds (warn 0.6 /
 * danger 0.85), the percent + token + cost captions' ladders, the window
 * source captions, and the typed client's query assembly (the ?model/
 * ?providerId effective-pair override, omitted when unset) — injected fake
 * sender, zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import type { ApiSender } from "../api";
import {
  CONTEXT_DONUT_DANGER,
  CONTEXT_DONUT_WARN,
  CONTEXT_LIVE_REFETCH_MS,
  contextPercent,
  contextPressure,
  contextWindowSourceCaption,
  fetchSessionContext,
  formatTokens,
  formatUsd,
} from "../context-meter";

// ── the pressure tiers (ContextDonut's exact thresholds) ───────────────────

describe("context-meter — the pressure tiers", () => {
  it("carries the desktop donut's thresholds + live cadence", () => {
    expect(CONTEXT_DONUT_WARN).toBe(0.6);
    expect(CONTEXT_DONUT_DANGER).toBe(0.85);
    expect(CONTEXT_LIVE_REFETCH_MS).toBe(2_500);
  });

  it("comfortable below 60%, filling from 60%, danger above 85%", () => {
    expect(contextPressure(0, 200_000)).toBe("comfortable");
    expect(contextPressure(119_999, 200_000)).toBe("comfortable");
    expect(contextPressure(120_000, 200_000)).toBe("filling"); // exactly 0.6
    expect(contextPressure(169_999, 200_000)).toBe("filling");
    expect(contextPressure(170_001, 200_000)).toBe("danger"); // above 0.85
    expect(contextPressure(170_000, 200_000)).toBe("filling"); // exactly 0.85 is NOT danger
    expect(contextPressure(200_000, 200_000)).toBe("danger"); // capped at 1
  });

  it("unknown when the window is unusable", () => {
    expect(contextPressure(1_000, 0)).toBe("unknown");
    expect(contextPressure(-5, 200_000)).toBe("unknown");
  });

  it("the percent caption rounds and caps at 100", () => {
    expect(contextPercent(120_000, 200_000)).toBe(60);
    expect(contextPercent(999, 200_000)).toBe(0);
    expect(contextPercent(250_000, 200_000)).toBe(100);
    expect(contextPercent(1_000, 0)).toBe(0);
  });
});

// ── the captions ─────────────────────────────────────────────────────────────

describe("context-meter — the captions", () => {
  it("formatTokens walks the desktop's ladder", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(9_999)).toBe("10.0k");
    expect(formatTokens(12_400)).toBe("12k"); // ≥10k drops the decimal (desktop parity)
    expect(formatTokens(12_500)).toBe("13k"); // toFixed(0) rounds half up
    expect(formatTokens(124_000)).toBe("124k");
    expect(formatTokens(1_240_000)).toBe("1.2M");
  });

  it("formatUsd keeps 4 decimals under a cent, 2 above", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("$0.0040");
    expect(formatUsd(0.42)).toBe("$0.42");
    expect(formatUsd(12.5)).toBe("$12.50");
  });

  it("the window's provenance captions (R83's source labels)", () => {
    expect(contextWindowSourceCaption("override")).toBe("your override");
    expect(contextWindowSourceCaption("catalog")).toBe("catalog default");
    expect(contextWindowSourceCaption("default")).toBe("assumed 200k — unknown model");
    expect(contextWindowSourceCaption("anything-else")).toBe("anything-else");
  });
});

// ── the typed client (the effective-pair query) ─────────────────────────────

describe("context-meter — fetchSessionContext", () => {
  function makeSender() {
    const calls: Array<{ path: string; init: { method?: string; bodyText?: string } }> = [];
    const sender: ApiSender = {
      async api(path, init = {}) {
        calls.push({ path, init });
        return {
          ok: true,
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            model: "z-ai/glm-5.2:free",
            providerId: "openrouter",
            contextWindow: 200_000,
            contextWindowSource: "catalog",
            maxOutputTokens: 32_768,
            available: 190_000,
            usedTokens: 10_000,
            usedTokensBasis: "estimated",
            breakdown: {
              systemPrompt: 2_000,
              systemTools: 3_000,
              memory: 0,
              messages: 4_500,
              meta: 500,
              mcpTools: 0,
            },
            actual: null,
            cache: { inputTokens: 0, cachedInputTokens: 0, hitRate: null },
            sessionTotals: {
              inputTokens: 10,
              outputTokens: 5,
              requests: 1,
              costUsd: 0.01,
              providerCalls: 2,
            },
            usage: {
              main: { inputTokens: 10, outputTokens: 5, requests: 1, costUsd: 0.01 },
              subagents: { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 },
              combined: { inputTokens: 10, outputTokens: 5, requests: 1, costUsd: 0.01 },
            },
          }),
        };
      },
    };
    return { sender, calls };
  }

  it("GETs /sessions/:id/context with NO query when the pair is unset (the session agent's own)", async () => {
    const { sender, calls } = makeSender();
    const outcome = await fetchSessionContext(sender, "sess_1");
    expect(outcome.ok && outcome.data.usedTokens).toBe(10_000);
    expect(calls[0]?.path).toBe("/api/v1/sessions/sess_1/context");
  });

  it("rides the composer's effective pair as ?model=&providerId= (R92-B)", async () => {
    const { sender, calls } = makeSender();
    await fetchSessionContext(sender, "sess_1", {
      model: "z-ai/glm-5.2:free",
      providerId: "openrouter",
    });
    expect(calls[0]?.path).toBe(
      "/api/v1/sessions/sess_1/context?model=z-ai%2Fglm-5.2%3Afree&providerId=openrouter",
    );
  });

  it("blank pair values are omitted (never an empty query param)", async () => {
    const { sender, calls } = makeSender();
    await fetchSessionContext(sender, "sess_1", { model: "  ", providerId: "" });
    expect(calls[0]?.path).toBe("/api/v1/sessions/sess_1/context");
  });

  it("carries the R113-a wire shape intact (compaction/actual stay optional)", async () => {
    const { sender } = makeSender();
    const outcome = await fetchSessionContext(sender, "sess_1");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.data.compaction).toBeUndefined(); // absent when never compacted
    expect(outcome.data.actual).toBeNull(); // null before the first reply
    expect(outcome.data.usedTokensBasis).toBe("estimated");
  });
});
