/**
 * ROUND-65 (R65): the honesty patch — three pins:
 *
 *  1. SURFACE BOUNDARY (the owner's live 0.63.0 hallucination: the agent
 *     narrated an embedded-browser navigation as "I opened Edge on your
 *     computer"): BOTH the COMPUTER USE and the EMBEDDED BROWSER PANEL
 *     prompt sections carry an explicit R65 boundary line naming the OTHER
 *     surface — a model cannot conflate browser_control (the in-app panel)
 *     with real-desktop computer use without ignoring both lines.
 *  2. DEBUG MODE SECTION (the owner's "debug mode" directive — the agent
 *     self-reports its execution trace + a settings switch): the section
 *     exists ONLY when ctx.debugMode === true; absent otherwise (prompts
 *     stay byte-identical for the default-off world).
 *  3. RUNTIME WIRING — prepareTurn reads the debug setting PER TURN (the
 *     permission-mode live-getter pattern): a flip between turns applies to
 *     the very next turn's system prompt with no restart.
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
    expect(rest.indexOf("SURFACE BOUNDARY (R65)")).toBeGreaterThan(-1);
    expect(rest.slice(0, rest.indexOf("## DEBUG MODE") === -1 ? rest.length : rest.indexOf("## DEBUG MODE"))).toContain(
      "browser_control cannot open or touch the user's real browsers/apps",
    );
  });

  it("the EMBEDDED BROWSER PANEL section says it NEVER opens the user's real browsers and demands honest narration", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const bp = composed.indexOf("## EMBEDDED BROWSER PANEL (browser_control)");
    expect(bp).toBeGreaterThan(-1);
    const rest = composed.slice(bp, bp + 3_000);
    expect(rest).toContain("SURFACE BOUNDARY (R65)");
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

describe("DEBUG MODE section (R65 — the self-report switch)", () => {
  it("ON: the section instructs the Execution-report format", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    expect(composed).toContain("## DEBUG MODE (ON)");
    expect(composed).toContain("## Execution report");
    expect(composed).toContain("no hiding failed calls");
  });

  it("OFF/absent: no section — the prompt stays byte-identical to the pre-R65 default", () => {
    for (const debugMode of [false, undefined]) {
      const composed = buildProjectSystemPrompt({ ...FULL_CTX, debugMode });
      expect(composed).not.toContain("## DEBUG MODE");
      expect(composed).not.toContain("## Execution report");
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

  it("prepareTurn reads the setting PER TURN — a flip applies to the very next turn", async () => {
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

    // Default OFF → no section.
    await runSingleAgentTurn(deps, session.id, "turn one");
    expect(systems[0]).not.toContain("## DEBUG MODE");

    // Flip ON → the VERY NEXT turn's prompt carries the section.
    setDebugSettings(db, { enabled: true });
    await runSingleAgentTurn(deps, session.id, "turn two");
    expect(systems[1]).toContain("## DEBUG MODE (ON)");

    // Flip OFF mid-session → gone again, no restart.
    setDebugSettings(db, { enabled: false });
    await runSingleAgentTurn(deps, session.id, "turn three");
    expect(systems[2]).not.toContain("## DEBUG MODE");
  });
});
