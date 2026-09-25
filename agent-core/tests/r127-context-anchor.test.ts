/**
 * ROUND-127 (R127-W4): the context meter's HONESTY wave — the provider-usage
 * anchor wins GET /api/v1/sessions/:id/context's headline `usedTokens`.
 *
 * The owner's complaint (the R127-OPEN inventory, item B2): "in my provider,
 * it was showing me 50,000 or 60,000 tokens, or even 70,000 tokens
 * occasionally, but our context window management was only showing a fixed
 * value there, which was fixed at 26K of 1 million" — the donut rendered the
 * PURE local estimate while the provider's own reported input was 2-3×
 * higher. The estimate LIES LOW (the provider counts the real serialization
 * of tool schemas, per-message wire overhead, provider-side framing —
 * everything the local sum under-counts).
 *
 * The law under test (the R125-C providerUsageAnchor, threaded into the
 * meter for the first time):
 *   - NO usage-bearing assistant event yet → the estimate stands VERBATIM:
 *     usedTokens = the breakdown sum, usedTokensBasis "estimated" (the
 *     fallback law — never a fabricated number, never a fake 0).
 *   - A usage-bearing assistant event EXISTS → usedTokens = the provider's
 *     OWN inputTokens + the estimated tail of messages the provider has not
 *     yet seen, usedTokensBasis "provider-anchored".
 *   - The `actual` block stays byte-identical (the popover's ground truth).
 *   - The BREAKDOWN slices stay per-slice estimates (unchanged fields —
 *     under the anchor they no longer sum to the headline; that divergence
 *     is the honest, visible gap between the estimate and the provider's
 *     count).
 *
 * Route-level pins only — providerUsageAnchor's OWN arithmetic (garbage-row
 * skipping, tail selection, newest-row-wins) is pinned at the pure seam in
 * context-compaction.test.ts (R125-C); here we pin that the ROUTE threads it
 * and labels it.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { assembleHistory } from "../src/agents/runtime";
import { estimateMessageTokens } from "../src/context";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { appendSessionEvent, createSession } from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r127";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r127-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({ ...options, headers: { authorization: `Bearer ${TOKEN}` } })) as LightMyRequestResponse;
}

/** A ready-made project session: agent + ONE user message + ONE assistant
 * reply WITHOUT usage (the pre-provider-report shape — anchor null). */
async function fixtureSession(
  model: string,
): Promise<{ sessionId: string; agentId: string }> {
  // Unique root per call — projects.root_path has a UNIQUE constraint.
  const projectRoot = join(tempDir, `proj-${randomUUID().slice(0, 8)}`);
  mkdirSync(projectRoot, { recursive: true });
  const project = createProject(db, { name: `R127-${model}`, rootPath: projectRoot });
  const agent = createAgent(db, { name: "R127 Agent", providerId: "openrouter", model });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  appendSessionEvent(db, session.id, {
    type: "message.user",
    agentId: agent.id,
    payload: { role: "user", content: "please review the changes" },
  });
  appendSessionEvent(db, session.id, {
    type: "message.assistant",
    agentId: agent.id,
    payload: { role: "assistant", content: "Reviewed." },
  });
  return { sessionId: session.id, agentId: agent.id };
}

// ── The route ────────────────────────────────────────────────────────────────

describe("GET /api/v1/sessions/:id/context (ROUND-127 R127-W4 provider anchor)", () => {
  it("the fallback law: NO provider reply yet → usedTokens = the estimate sum, usedTokensBasis \"estimated\", actual null", async () => {
    const { sessionId } = await fixtureSession("test/r127-a");
    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    // The anchor is null before the first provider reply — the local
    // estimate stands VERBATIM (byte-identical to pre-R127 behavior).
    expect(body.usedTokensBasis).toBe("estimated");
    expect(body.usedTokens).toBe(
      body.breakdown.systemPrompt +
        body.breakdown.systemTools +
        body.breakdown.memory +
        body.breakdown.messages +
        body.breakdown.meta +
        body.breakdown.mcpTools,
    );
    // And no provider ground truth exists yet either.
    expect(body.actual).toBeNull();
  });

  it("the anchor law: a usage-bearing assistant reply (inputTokens 50 000, zero post-anchor tail) → usedTokens is EXACTLY 50 000, basis \"provider-anchored\"", async () => {
    const { sessionId, agentId } = await fixtureSession("test/r127-b");
    // The provider's own report for the request that produced this reply —
    // the runtime persists one of these per assistant reply (sync path +
    // streamed stats carrier). This event is the LAST message event, so the
    // post-anchor tail is EMPTY: the anchor is exactly the provider number.
    const reply = appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId,
      payload: {
        role: "assistant",
        content: "Reviewed thoroughly.",
        usage: { inputTokens: 50_000, outputTokens: 1_200 },
        model: "test/r127-b",
      },
    });

    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    // The owner's 26K-of-1M lie is DEAD: the headline is the provider's OWN
    // count (the estimate would have said a few hundred for this tiny
    // fixture — 2-3× low in the owner's real sessions).
    expect(body.usedTokensBasis).toBe("provider-anchored");
    expect(body.usedTokens).toBe(50_000);
    // The `actual` block stays byte-identical — the popover keeps the
    // provider's last-request ground truth (input/output/model/ts).
    expect(body.actual).toEqual({
      inputTokens: 50_000,
      outputTokens: 1_200,
      cachedInputTokens: null,
      at: reply.ts,
      model: "test/r127-b",
    });
  });

  it("anchor + tail: a LATER user message rides ON TOP of the provider's number (usedTokens > 50 000, exactly 50 000 + the estimated tail)", async () => {
    const { sessionId, agentId } = await fixtureSession("test/r127-c");
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId,
      payload: {
        role: "assistant",
        content: "Reviewed thoroughly.",
        usage: { inputTokens: 50_000, outputTokens: 1_200 },
        model: "test/r127-c",
      },
    });
    // The post-anchor tail: a message the provider has NOT yet seen. The
    // next request's input = the provider's 50 000 + this message's
    // estimate (the anchor's own arithmetic).
    const tailContent = "one more thing — please also check the migration numbering and the index summary";
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId,
      payload: { role: "user", content: tailContent },
    });

    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.usedTokensBasis).toBe("provider-anchored");
    // EXACTLY the provider's number + the estimated tail (no attachments →
    // assembleHistory passes the content through verbatim).
    const expectedTail = estimateMessageTokens([{ role: "user", content: tailContent }]);
    expect(expectedTail).toBeGreaterThan(0);
    expect(body.usedTokens).toBe(50_000 + expectedTail);
    expect(body.usedTokens).toBeGreaterThan(50_000);
  });

  it("the breakdown slices stay per-slice ESTIMATES (unchanged fields) — under the anchor they no longer sum to the headline (the honest divergence)", async () => {
    const { sessionId, agentId } = await fixtureSession("test/r127-d");
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId,
      payload: {
        role: "assistant",
        content: "Reviewed thoroughly.",
        usage: { inputTokens: 50_000, outputTokens: 1_200 },
        model: "test/r127-d",
      },
    });

    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.usedTokensBasis).toBe("provider-anchored");

    // messages: still the WHOLE-LIST estimate (assembleHistory + the newest
    // compaction applied — here none), byte-identical to the R83 meter.
    expect(body.breakdown.messages).toBe(estimateMessageTokens(assembleHistory(db, sessionId)));
    // The other slices still carry their per-slice estimates.
    expect(body.breakdown.systemPrompt).toBeGreaterThan(0);
    expect(body.breakdown.systemTools).toBeGreaterThan(0);
    expect(body.breakdown.mcpTools).toBe(0);
    // The HONEST DIVERGENCE: the estimate sum ≠ the anchored headline —
    // the visible gap between what we estimate and what the provider
    // actually counted (the owner's 26K vs 50-70K, now on the wire).
    const estimateSum =
      body.breakdown.systemPrompt +
      body.breakdown.systemTools +
      body.breakdown.memory +
      body.breakdown.messages +
      body.breakdown.meta +
      body.breakdown.mcpTools;
    expect(estimateSum).toBeLessThan(body.usedTokens);
    expect(body.usedTokens).toBe(50_000);
  });

  it("route-level garbage law: a zero-usage assistant row BEFORE the honest one is skipped — the LAST HONEST row anchors", async () => {
    const { sessionId, agentId } = await fixtureSession("test/r127-e");
    // A garbage stats carrier first (inputTokens 0 — skipped by the anchor
    // walk, exactly as at the pure seam).
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId,
      payload: {
        role: "assistant",
        content: "garbage row",
        usage: { inputTokens: 0, outputTokens: 5 },
        model: "test/r127-e",
      },
    });
    // Then the honest one — the LAST usage-bearing event, so it wins and
    // the post-anchor tail is empty.
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId,
      payload: {
        role: "assistant",
        content: "honest row",
        usage: { inputTokens: 60_000, outputTokens: 600 },
        model: "test/r127-e",
      },
    });

    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The garbage row was skipped — the honest 60 000 anchors (not 0, not
    // the estimate sum).
    expect(body.usedTokensBasis).toBe("provider-anchored");
    expect(body.usedTokens).toBe(60_000);
    expect(body.actual.inputTokens).toBe(60_000);
  });
});
