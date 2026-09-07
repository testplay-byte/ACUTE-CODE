/**
 * ROUND-72 (R72-a) — the TASK HINTS round ("the agent accesses skills on
 * the basis of the task"):
 *
 *   D1 — agents/task-hints.ts computeTaskHints: the DETERMINISTIC matcher
 *        (no LLM, no async, no cost): quoted phrases from each skill's
 *        description score word-count × 5 when they appear (case-insensitive
 *        substring) in the turn's user message; description tokens (≥3
 *        chars, stopwords dropped) present as whole words score 1 each;
 *        score ≥ 2 OR a phrase hit qualifies; sort score desc then name
 *        asc; top 2. Empty/whitespace message → []; no skills → [].
 *   D2 — prompts.ts: ctx.taskHints renders ONE advisory "Task signal: …"
 *        line inside the SKILLS section, AFTER the skill list (1 name → no
 *        parenthetical; 2 names → "(and possibly …)"). Hints render ONLY
 *        inside the SKILLS section (no skills → no line). ctx.taskHints
 *        absent/empty → byte-identical composition — the golden fixture
 *        (prompt-registry.test.ts) does NOT set the field, so the golden
 *        stays byte-identical WITHOUT regeneration; the byte-identity pins
 *        below are the local proof, the golden run is the gate.
 *   D3 — runtime.ts prepareTurn: the turn's incoming user message (the
 *        `content` the turn runners receive — prepareTurn runs BEFORE the
 *        message.user event is appended) is scored against the SAME
 *        effectiveSkills list that feeds the SKILLS section, on BOTH turn
 *        paths (streamed main + sync/sub-agent — one shared prepareTurn
 *        call each). Hints are per-turn ephemeral: rendered, never
 *        persisted. Gating is inherited for free (computer-use master
 *        switch, per-agent allowlist) because only effective skills are
 *        ever scored.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";
import { createAgent } from "../src/storage/agents";
import { createSession } from "../src/storage/sessions";
import { setComputerUseSettings } from "../src/storage/computer-use";
import { runSingleAgentTurn, runStreamedAgentTurn } from "../src/agents/runtime";
import { computeTaskHints } from "../src/agents/task-hints";
import { buildProjectSystemPrompt } from "../src/agents/prompts";
import { ProviderKeyring } from "../src/providers/registry";
import type { StreamChatEvent } from "../src/agents/chat";

/* ── fixtures ───────────────────────────────────────────────────────────────── */

const KEY = "sk-or-vtest-r72a";

let db: SqliteDatabase;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r72a-"));
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

// ─────────────────────────────────────────────────────────────────────────────
// D1 — the deterministic matcher
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-a D1: computeTaskHints (pure, deterministic, zero cost)", () => {
  it("a quoted phrase hit is the strong signal: word-count × 5 (plus its own token hits)", () => {
    // Description carries the R71 convention's verbatim phrasing.
    const skills = [
      { name: "debugging", description: "Use when the user reports a defect — 'my test fails', 'this bug' — and the cause is unknown." },
    ];
    const hints = computeTaskHints("my test fails again", skills);
    // Phrase 'my test fails' = 3 words × 5 = 15; its tokens 'test' and 'fails'
    // also land as whole-word token hits (+1 each; 'my' is <3 chars). 15 + 2.
    expect(hints).toEqual([{ skillName: "debugging", score: 17 }]);
  });

  it("matching is case-insensitive on both sides and identical whatever the casing", () => {
    const skills = [{ name: "debugging", description: "Use when the user says 'my test fails'." }];
    expect(computeTaskHints("MY TEST FAILS AGAIN", skills)).toEqual(computeTaskHints("my test fails again", skills));
  });

  it("token hits accumulate without any quoted phrases", () => {
    const skills = [{ name: "deploy-flow", description: "How this project ships: tags, changelog, release checklist." }];
    // 'how' is a stopword; changelog + release + checklist land (+1 each).
    expect(computeTaskHints("update the release checklist and changelog", skills)).toEqual([
      { skillName: "deploy-flow", score: 3 },
    ]);
  });

  it("stopwords are ignored — a message made of glue words scores nothing", () => {
    const glue = "use when the and for this that with your you not are was into from they them its";
    const skills = [{ name: "glue-skill", description: `Use when ${glue}.` }];
    expect(computeTaskHints(glue, skills)).toEqual([]);
  });

  it("threshold: a lone token hit (score 1) is noise, not a hint", () => {
    const skills = [{ name: "solo", description: "alpha beta gamma" }];
    expect(computeTaskHints("alpha", skills)).toEqual([]);
  });

  it("a phrase hit alone qualifies even when its tokens are all stopwords", () => {
    // 'go for it' — go/it are <3 chars and 'for' is a stopword: ZERO token
    // score, but the phrase itself (3 words × 5) qualifies the skill.
    const skills = [{ name: "launch", description: "Use when the user says 'go for it'." }];
    expect(computeTaskHints("go for it", skills)).toEqual([{ skillName: "launch", score: 15 }]);
  });

  it("top-2 cap: three qualifying skills → only the two strongest", () => {
    const skills = [
      { name: "skill-a", description: "Use when 'fix the login page'." },
      { name: "skill-b", description: "Use when 'ship it'." },
      { name: "skill-c", description: "Use when 'deploy'." },
    ];
    const hints = computeTaskHints("fix the login page, ship it, deploy", skills);
    // a: 4 words ×5 + tokens fix/login/page = 23; b: 2×5 + ship = 11; c: 5 + deploy = 6.
    expect(hints.map((h) => h.skillName)).toEqual(["skill-a", "skill-b"]);
    expect(hints.map((h) => h.score)).toEqual([23, 11]);
  });

  it("equal scores tie-break by name ascending (deterministic order)", () => {
    const skills = [
      { name: "zeta", description: "alpha phrase" },
      { name: "beta", description: "alpha phrase" },
    ];
    expect(computeTaskHints("alpha phrase present", skills).map((h) => h.skillName)).toEqual(["beta", "zeta"]);
  });

  it("empty or whitespace-only message → no hints; no skills → no hints", () => {
    const skills = [{ name: "x", description: "alpha beta" }];
    expect(computeTaskHints("", skills)).toEqual([]);
    expect(computeTaskHints("   \n\t  ", skills)).toEqual([]);
    expect(computeTaskHints("alpha beta", [])).toEqual([]);
  });

  it("quoted-phrase extraction handles BOTH quote types (single '…' and double \"…\")", () => {
    const skills = [{ name: "moments", description: `Use for 'alpha moment' or "beta moment" tasks.` }];
    // Both phrases hit (10 + 10); tokens alpha/beta/moment add 3 (moment
    // deduped — presence scores once).
    expect(computeTaskHints("alpha moment beta moment", skills)).toEqual([{ skillName: "moments", score: 23 }]);
  });

  it("contractions are flattened on BOTH sides — quoted 'don't …' extracts whole, and no bare 'don' fragment leaks", () => {
    const skills = [{ name: "zero-hallucination", description: "Use when the user says 'don't hallucinate' about APIs." }];
    // The message's "don't" meets the description's 'don't' phrase (2 words
    // ×5 = 10) + the tokens 'dont' and 'hallucinate' (+1 each).
    expect(computeTaskHints("don't hallucinate the fetch call", skills)).toEqual([{ skillName: "zero-hallucination", score: 12 }]);
    // …and a message containing the WORD "don" (not "don't") scores nothing —
    // the apostrophe-bleed fragment can never become a phrase.
    expect(computeTaskHints("the don says hi", skills)).toEqual([]);
  });

  it("the message is capped at 8K chars — a match beyond the cap is not seen", () => {
    const skills = [{ name: "parade", description: "Use when the user says 'elephant'." }];
    // "pad ".repeat(2000) is exactly 8,000 chars: 'elephant' starts past the cap.
    expect(computeTaskHints(`${"pad ".repeat(2000)}elephant`, skills)).toEqual([]);
    // Same phrase within the cap → phrase 5 + token 1.
    expect(computeTaskHints(`${"pad ".repeat(1990)}elephant`, skills)).toEqual([{ skillName: "parade", score: 6 }]);
  });

  it("score sanity: hints are positive, sorted score-desc, at most 2, names unique", () => {
    const skills = [
      { name: "aaa", description: "gamma delta epsilon" },
      { name: "bbb", description: "gamma delta zeta" },
      { name: "ccc", description: "gamma delta eta" },
    ];
    const hints = computeTaskHints("gamma delta epsilon zeta eta", skills);
    // All three score 3 (gamma + delta + their third token) — the cap keeps
    // two, the tie-break picks the names ascending.
    expect(hints.map((h) => h.skillName)).toEqual(["aaa", "bbb"]);
    expect(hints.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < hints.length; i++) {
      expect(hints[i]!.score).toBeLessThanOrEqual(hints[i - 1]!.score);
    }
    for (const hint of hints) {
      expect(hint.score).toBeGreaterThan(0);
      expect(Number.isInteger(hint.score)).toBe(true);
    }
    expect(new Set(hints.map((h) => h.skillName)).size).toBe(hints.length);
  });

  it("the real builtin 'debugging' description dominates the canonical defect message (phrase-driven)", () => {
    const debugging = {
      name: "debugging",
      description:
        "Use when the user reports a defect — 'this bug', 'my test fails', 'it crashes when I click X', 'fix this error', 'why is this broken' — and the cause is unknown. Delivers the reproduce → read-the-error-fully → isolate → name the root cause in one sentence → minimal fix → verify with the failing case → regression-test loop. NOT for whole-feature multi-file repair (focused-fix) or writing new test suites (testing).",
    };
    const hints = computeTaskHints("my test keeps failing, fix this bug", [debugging]);
    // 'this bug' (2 words × 5) + the tokens bug/test/fix/failing — the phrase
    // is the backbone; the exact total follows the description text, so pin
    // the floor, not the arithmetic.
    expect(hints[0]?.skillName).toBe("debugging");
    expect(hints[0]!.score).toBeGreaterThanOrEqual(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 — the SKILLS advisory line (rendering)
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-a D2: the SKILLS section's advisory line", () => {
  const skills = [
    { name: "alpha", description: "does alpha things" },
    { name: "beta", description: "does beta things" },
  ];
  const base = {
    projectName: "R72aProject",
    // A root that never exists → no .acute/prompts overrides (hermetic).
    rootPath: "/tmp/acute-r72a-never-exists",
    toolNames: ["read_file"],
    skills,
  };

  it("one hint → the exact advisory line without the parenthetical", () => {
    const prompt = buildProjectSystemPrompt({ ...base, taskHints: [{ skillName: "debugging", score: 12 }] });
    expect(prompt).toContain(
      "Task signal: this request looks like it matches **debugging** — consider calling read_skill with that name FIRST and following it for the rest of the task.",
    );
  });

  it("two hints → the exact advisory line with the '(and possibly …)' parenthetical", () => {
    const prompt = buildProjectSystemPrompt({
      ...base,
      taskHints: [
        { skillName: "alpha", score: 9 },
        { skillName: "beta", score: 8 },
      ],
    });
    expect(prompt).toContain(
      "Task signal: this request looks like it matches **alpha** (and possibly **beta**) — consider calling read_skill with that name FIRST and following it for the rest of the task.",
    );
  });

  it("the line renders AFTER the skill list and BEFORE the reload affordance", () => {
    const prompt = buildProjectSystemPrompt({ ...base, taskHints: [{ skillName: "alpha", score: 9 }] });
    const idxList = prompt.indexOf("- **alpha** — does alpha things");
    const idxSignal = prompt.indexOf("Task signal:");
    const idxReload = prompt.indexOf("can be RELOADED");
    expect(idxList).toBeGreaterThan(-1);
    expect(idxSignal).toBeGreaterThan(idxList);
    expect(idxReload).toBeGreaterThan(idxSignal);
  });

  it("a caller passing 3+ hints still gets a two-name line (the renderer caps)", () => {
    const prompt = buildProjectSystemPrompt({
      ...base,
      taskHints: [
        { skillName: "alpha", score: 9 },
        { skillName: "beta", score: 8 },
        { skillName: "gamma", score: 7 },
      ],
    });
    const line = prompt.split("\n").find((l) => l.startsWith("Task signal:"));
    expect(line).toBeDefined();
    expect(line).toBe(
      "Task signal: this request looks like it matches **alpha** (and possibly **beta**) — consider calling read_skill with that name FIRST and following it for the rest of the task.",
    );
  });

  it("taskHints absent vs [] vs undefined → BYTE-IDENTICAL composition (golden stability, locally)", () => {
    const without = buildProjectSystemPrompt(base);
    const empty = buildProjectSystemPrompt({ ...base, taskHints: [] });
    const explicitUndefined = buildProjectSystemPrompt({ ...base, taskHints: undefined });
    expect(empty).toBe(without);
    expect(explicitUndefined).toBe(without);
  });

  it("DECISION (pinned): hints without a skills list render NOTHING — the advisory line lives inside the SKILLS section", () => {
    // taskHints set but ctx.skills empty → no SKILLS section → no line, and
    // the composition equals a ctx with NEITHER field (documented contract:
    // a hint can only ever point at a listed skill).
    const withHintsNoSkills = buildProjectSystemPrompt({
      ...base,
      skills: [],
      taskHints: [{ skillName: "alpha", score: 9 }],
    });
    const neither = buildProjectSystemPrompt({ ...base, skills: [] });
    expect(withHintsNoSkills).toBe(neither);
    expect(withHintsNoSkills).not.toContain("Task signal:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 — the wiring: prepareTurn computes hints on BOTH turn paths (e2e,
// the r70-skills-system system-capturing chatStream/chat pattern)
// ─────────────────────────────────────────────────────────────────────────────

describe("R72-a D3: both turn paths carry the advisory line (prepareTurn wiring)", () => {
  /** A fake chatStream that finishes cleanly (the system prompt is captured
   * by the wrapper below, before the generator starts). */
  function cleanStream(): AsyncGenerator<StreamChatEvent> {
    return (async function* () {
      yield { type: "text-delta", delta: "Task completed. It is done." };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    })();
  }

  interface StreamInputShape {
    system: string;
  }

  async function runStreamedTurnAndCaptureSystem(sessionId: string, content: string): Promise<string> {
    const captured: { system: string } = { system: "" };
    const deps = {
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat: (async () => ({ text: "unused", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, toolCalls: [] })) as never,
      chatStream: (input: StreamInputShape) => {
        captured.system = input.system;
        return cleanStream();
      },
    };
    const outcome = await runStreamedAgentTurn(deps, sessionId, content, () => undefined);
    expect(outcome.ok).toBe(true);
    return captured.system;
  }

  /** The SYNC path (plain sync turns + sub-agent children) — system captured
   * from the chat fn's input the same way. */
  async function runSyncTurnAndCaptureSystem(sessionId: string, content: string): Promise<string> {
    const captured: { system: string } = { system: "" };
    const deps = {
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat: (async (input: { system: string }) => {
        captured.system = input.system;
        return { text: "unused", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
      }) as never,
    };
    const outcome = await runSingleAgentTurn(deps, sessionId, content);
    expect(outcome.ok).toBe(true);
    return captured.system;
  }

  /** A session bound to an agent + an empty temp project root (no file
   * skills — the DB builtins are the effective set). */
  function newSession(agentSkills: string[]): string {
    const root = mkdtempSync(join(tempDir, "proj-"));
    const project = createProject(db, { name: "R72aWiring", rootPath: root });
    const agent = createAgent(db, {
      name: "R72a Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
      skills: agentSkills,
    });
    return createSession(db, { agentId: agent.id, mode: "single", projectId: project.id }).id;
  }

  it("STREAMED path: 'my test keeps failing, fix this bug' → the exact single-skill advisory line naming debugging", async () => {
    // agent.skills=["debugging"] → exactly one effective skill → one hint.
    const sessionId = newSession(["debugging"]);
    const system = await runStreamedTurnAndCaptureSystem(sessionId, "my test keeps failing, fix this bug");
    expect(system).toContain("## SKILLS (load with read_skill)");
    expect(system).toContain("**debugging**");
    expect(system).toContain(
      "Task signal: this request looks like it matches **debugging** — consider calling read_skill with that name FIRST and following it for the rest of the task.",
    );
  });

  it("STREAMED path: an unrelated message → no advisory line at all (the matcher stays silent)", async () => {
    const sessionId = newSession(["debugging"]);
    const system = await runStreamedTurnAndCaptureSystem(sessionId, "what is the capital of France");
    expect(system).toContain("## SKILLS (load with read_skill)"); // the index is still there
    expect(system).not.toContain("Task signal:");
  });

  it("STREAMED path, default agent (all skills): the line's FORMAT is exact and debugging wins first place", async () => {
    const sessionId = newSession([]);
    const system = await runStreamedTurnAndCaptureSystem(sessionId, "my test keeps failing, fix this bug");
    // Format pinned by regex (the second name follows the live builtin set);
    // the first name is pinned: 'this bug' + defect tokens make debugging
    // the phrase-driven top match for the canonical defect message.
    expect(system).toMatch(
      /^Task signal: this request looks like it matches \*\*debugging\*\*(?: \(and possibly \*\*[a-z0-9-]+\*\*\))? — consider calling read_skill with that name FIRST and following it for the rest of the task\.$/m,
    );
  });

  it("SYNC path (sub-agent route): the same message gets the same advisory line", async () => {
    const sessionId = newSession(["debugging"]);
    const system = await runSyncTurnAndCaptureSystem(sessionId, "my test keeps failing, fix this bug");
    expect(system).toContain("**debugging**");
    expect(system).toContain(
      "Task signal: this request looks like it matches **debugging** — consider calling read_skill with that name FIRST and following it for the rest of the task.",
    );
  });

  it("SYNC path: unrelated message → no line (parity with the streamed path)", async () => {
    const sessionId = newSession(["debugging"]);
    const system = await runSyncTurnAndCaptureSystem(sessionId, "tell me a joke about databases");
    expect(system).not.toContain("Task signal:");
  });

  it("hints never recommend a DARK skill: computer-use gated off → no section, no line; switch on → the line names it", async () => {
    // Master switch OFF (the default): the allowlist intersects the gated
    // set → NO effective skills → no SKILLS section → nothing to hint.
    const offSession = newSession(["computer-use"]);
    const offSystem = await runStreamedTurnAndCaptureSystem(offSession, "open Notepad and type into that window");
    expect(offSystem).not.toContain("## SKILLS (load with read_skill)");
    expect(offSystem).not.toContain("Task signal:");

    // Master switch ON: computer-use becomes effective and the verbatim
    // phrasing in the message wins the hint.
    setComputerUseSettings(db, { enabled: true });
    const onSession = newSession(["computer-use"]);
    const onSystem = await runStreamedTurnAndCaptureSystem(onSession, "open Notepad and type into that window");
    expect(onSystem).toContain("## SKILLS (load with read_skill)");
    expect(onSystem).toContain(
      "Task signal: this request looks like it matches **computer-use** — consider calling read_skill with that name FIRST and following it for the rest of the task.",
    );
  });

  it("hints are per-turn EPHEMERAL: the turn's own message decides — a second turn on the same session gets its own line (or none)", async () => {
    const sessionId = newSession(["debugging"]);
    const first = await runStreamedTurnAndCaptureSystem(sessionId, "my test keeps failing, fix this bug");
    expect(first).toContain("Task signal:");
    // A later, unrelated turn on the SAME session renders NO line — hints
    // are recomputed from each turn's incoming message, never persisted.
    const second = await runStreamedTurnAndCaptureSystem(sessionId, "thanks, that is all for now");
    expect(second).not.toContain("Task signal:");
  });
});
