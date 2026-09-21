/**
 * ROUND-65 (R65): the honesty patch — three pins:
 *
 *  1. SURFACE BOUNDARY (the owner's live 0.63.0 hallucination: the agent
 *     narrated an embedded-browser navigation as "I opened Edge on your
 *     computer"): BOTH the COMPUTER USE and the EMBEDDED BROWSER PANEL
 *     prompt sections carry an explicit R65 boundary line naming the OTHER
 *     surface — a model cannot conflate browser_control (the in-app panel)
 *     with real-desktop computer use without ignoring both lines.
 *  2. DEBUG MODE (the owner's "debug mode" directive — R65 shipped the
 *     agent self-report; R66 (R66-2-c, the owner's C1 directive) REMOVED
 *     it: the model's prompt never self-reports. The report now comes from
 *     the ROUTE-SIDE context-free analyst (agents/debug-analyst.ts + the
 *     stream-route phase + debug.report events — covered by
 *     debug-analyst.test.ts and the r58-stop-and-replay stream-route
 *     tests). These pins hold the removal: debugMode composes NOTHING.
 *  3. RUNTIME WIRING — prepareTurn keeps reading the setting per turn
 *     (getDebugSettings) and passing ctx.debugMode; with the section gone
 *     the flag is a prompt-level no-op — the live gate is the route-side
 *     analyst phase, pinned in the stream-route tests.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProjectSystemPrompt } from "../src/agents/prompts";
import { runSingleAgentTurn } from "../src/agents/runtime";
import type { ChatFn } from "../src/agents/chat";
import { TOOL_NAMES, createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { createSession } from "../src/storage/sessions";
import { getDebugSettings, setDebugSettings } from "../src/storage/settings";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-or-vtest-r65";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r65-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterEach(() => {
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** The maximal ctx — every gate open (both boundary surfaces visible). */
const FULL_CTX = {
  projectName: "R65Project",
  rootPath: "/tmp/acute-r65-root-does-not-exist",
  toolNames: [...TOOL_NAMES],
  maxTurns: 30,
  permissionMode: "ask" as const,
  computerUse: { enabled: true, posture: "act" as const },
  debugMode: true,
};

describe("SURFACE BOUNDARY (R65 — the hallucination guard)", () => {
  it("the COMPUTER USE section names the embedded browser as a DIFFERENT surface", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    expect(cu).toBeGreaterThan(-1);
    // The boundary line sits INSIDE the computer-use section (before the
    // next section header) and names the other surface + both directions.
    const rest = composed.slice(cu);
    expect(rest.indexOf("**Surface boundary:**")).toBeGreaterThan(-1);
    expect(rest.slice(0, rest.indexOf("## DEBUG MODE") === -1 ? rest.length : rest.indexOf("## DEBUG MODE"))).toContain(
      "browser_control cannot open or touch the user's real browsers/apps",
    );
  });

  it("the EMBEDDED BROWSER PANEL section says it NEVER opens the user's real browsers and demands honest narration", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const bp = composed.indexOf("## EMBEDDED BROWSER PANEL (browser_control)");
    expect(bp).toBeGreaterThan(-1);
    // ROUND-66: the browser section grew (the high-level page actions +
    // form-submission + bot-wall discipline) — the window is 4_500 now so
    // the surface-boundary line at the section's end stays covered.
    const rest = composed.slice(bp, bp + 4_500);
    expect(rest).toContain("**Surface boundary:**");
    expect(rest).toContain("NEVER opens the user's real browsers");
    expect(rest).toContain('say "in the embedded browser panel" when that is where it happened');
  });

  it("the boundary text is tool-gated like the sections themselves (no browser_control → no browser boundary line)", () => {
    const noBrowser = buildProjectSystemPrompt({
      ...FULL_CTX,
      toolNames: FULL_CTX.toolNames.filter((n) => n !== "browser_control"),
    });
    expect(noBrowser).not.toContain("## EMBEDDED BROWSER PANEL");
    // The computer-use boundary line still mentions browser_control as the
    // OTHER surface (the confusion risk exists whenever computer use is on).
    expect(noBrowser).toContain("## COMPUTER USE (desktop control)");
  });
});

describe("DEBUG MODE (R65 → R66: the self-report is REMOVED)", () => {
  it("ON: the prompt composes NO self-report section — the route-side analyst owns the report now", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    expect(composed).not.toContain("## DEBUG MODE");
    expect(composed).not.toContain("## Execution report");
    expect(composed).not.toContain("no hiding failed calls");
  });

  it("OFF/absent: identical — the debugMode ctx field is a composition no-op in every state", () => {
    const on = buildProjectSystemPrompt(FULL_CTX);
    for (const debugMode of [false, undefined]) {
      const composed = buildProjectSystemPrompt({ ...FULL_CTX, debugMode });
      expect(composed).toBe(on);
    }
  });
});

describe("storage + runtime wiring (R65)", () => {
  it("debug settings default OFF and round-trip in the settings table", () => {
    expect(getDebugSettings(db)).toEqual({ enabled: false });
    expect(setDebugSettings(db, { enabled: true })).toEqual({ enabled: true });
    expect(getDebugSettings(db)).toEqual({ enabled: true });
    // Non-boolean patch refuses (the storage-layer guard; the route also
    // validates before this).
    expect(() => setDebugSettings(db, { enabled: "yes" as unknown as boolean })).toThrow();
    setDebugSettings(db, { enabled: false });
    expect(getDebugSettings(db)).toEqual({ enabled: false });
  });

  it("prepareTurn keeps reading the setting per turn — the flag rides ctx.debugMode as a prompt-level NO-OP", async () => {
    const project = createProject(db, { name: "R65 Wiring", rootPath: tempDir });
    const agent = createAgent(db, {
      name: "R65 Agent",
      providerId: "openrouter",
      model: "test/model-1",
      allowedTools: [],
    });
    const session = createSession(db, {
      agentId: agent.id,
      mode: "single",
      projectId: project.id,
    });

    /** A chat stub that records each call's SYSTEM prompt. */
    const systems: string[] = [];
    const chat: ChatFn = async (input) => {
      systems.push(String(input.system ?? ""));
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };
    const deps = { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat };

    // R66: in EVERY state (off → on → off) the turn's own prompt stays
    // clean — no self-report, no composition change. The debug setting's
    // live effect is the ROUTE-SIDE analyst phase (r58-stop-and-replay's
    // debug-analyst describe pins that per-turn read end-to-end).
    await runSingleAgentTurn(deps, session.id, "turn one");
    setDebugSettings(db, { enabled: true });
    await runSingleAgentTurn(deps, session.id, "turn two");
    setDebugSettings(db, { enabled: false });
    await runSingleAgentTurn(deps, session.id, "turn three");
    for (const system of systems) {
      expect(system).not.toContain("## DEBUG MODE");
      expect(system).not.toContain("## Execution report");
    }
  });
});
