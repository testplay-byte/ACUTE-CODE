// @vitest-environment node
//
// ROUND-98 (R98-F3): search_symbols + AUTO-INDEX — the owner's ask, verbatim:
//   "Implement grep functionality. Handle it properly. Look into indexing…
//    essential for larger projects with a lot of files, folders, subfolders."
//
// Pins:
//   A. THE TOOL — search_symbols registers in the search family; the honest
//      no-db/no-project refusals; the result SHAPE (path:line [kind] symbol
//      — signature + the built-at header); the kind filter + limit; the
//      honest STALENESS note (backdated ts → "index is stale — call
//      index_project"); the honest EMPTY note (files exist, nothing indexed);
//      the descriptions cross-reference each other.
//   B. THE INCREMENTAL index (reindexFile after every successful
//      write_file/edit_file through the real toolset) — new symbols are
//      searchable with NO manual index call.
//   C. AUTO-INDEX (storage/auto-index.ts) — the staleness fact, the guarded
//      fire-and-forget walk, the concurrency guard, the attempt cooldown,
//      the fresh-index no-op.
//   D. THE RUNTIME HOOK — prepareTurn fires the background walk for a
//      missing index (a real streamed turn) and leaves a fresh (<10 min)
//      index alone.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createAgent } from "../src/storage/agents";
import { createSession } from "../src/storage/sessions";
import { createProject } from "../src/storage/projects";
import { buildProjectTools, type ToolDeps } from "../src/tools/index";
import { getIndexedAt, parseSqliteTs, reindexFile, reindexProject } from "../src/storage/index";
import {
  AUTO_INDEX_STALE_MS,
  autoIndexInFlightForTest,
  isIndexStale,
  maybeAutoIndexProject,
  resetAutoIndexForTest,
} from "../src/storage/auto-index";
import { runStreamedAgentTurn } from "../src/agents/runtime";
import { buildProjectSystemPrompt } from "../src/agents/prompts";
import type { ChatFn, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";

let tempDir = "";
let db: SqliteDatabase | undefined;

// The AI SDK tool contract — narrow to what the tests call.
type ExecutableTool = {
  description: string;
  execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};
function tool(set: ToolSet, name: string): ExecutableTool {
  return (set as unknown as Record<string, ExecutableTool>)[name];
}

/** One prepared project: root on disk + row + a session's tool deps. */
function setupProject(name: string): { root: string; projectId: string; deps: ToolDeps } {
  const root = mkdtempSync(join(tmpdir(), `acute-r98f3-${name}-`));
  const project = createProject(db!, { name, rootPath: root });
  const agent = createAgent(db!, { name: `${name} Agent`, providerId: "openrouter", model: `test/${name}` });
  const session = createSession(db!, { agentId: agent.id, mode: "single", projectId: project.id });
  return {
    root,
    projectId: project.id,
    deps: { db: db!, sessionId: session.id, agentId: agent.id, projectId: project.id },
  };
}

/** Flush any pending setImmediate (the auto-index's fire-and-forget slot). */
async function flushImmediates(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r98f3-"));
  db?.close();
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  resetAutoIndexForTest();
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/* ── A0: the prompt lines (code navigation + codebase awareness) ─────────── */

describe("R98-F3: the prompt lines (code navigation + codebase awareness)", () => {
  const ctx = {
    projectName: "R98F3",
    rootPath: "/tmp/acute-r98f3-prompt",
    toolNames: ["read_file", "edit_file", "search_code", "search_symbols", "index_project"],
  };

  it("CODE NAVIGATION teaches search_symbols BEFORE search_code when hunting a definition", () => {
    const prompt = buildProjectSystemPrompt(ctx);
    const nav = prompt.slice(prompt.indexOf("## CODE NAVIGATION"), prompt.indexOf("## PRECISION DISCIPLINE"));
    expect(nav).toContain("Use search_symbols to find WHERE a symbol is DEFINED");
    expect(nav).toContain("try it BEFORE search_code when hunting a definition");
  });

  it("CODEBASE AWARENESS carries the auto-index truth + the honest search split (the fabricated 'search_code queries the index' line is GONE)", () => {
    const prompt = buildProjectSystemPrompt(ctx);
    const aware = prompt.slice(prompt.indexOf("## CODEBASE AWARENESS"), prompt.indexOf("### Project index"));
    expect(aware).toContain("The index refreshes AUTOMATICALLY");
    expect(aware).toContain("missing/stale >10 min");
    expect(aware).toContain("use search_symbols to query the symbol index (name-prefix + kind filter");
    expect(aware).toContain("the index first when hunting definitions.");
    // The retired fabrication + the retired FIRST-turn imperative.
    expect(aware).not.toContain("queries both the live tree AND the index");
    expect(aware).not.toContain("Call index_project on the FIRST turn");
  });
});

/* ── A: the search_symbols tool ──────────────────────────────────────────── */

describe("R98-F3 A: the search_symbols tool", () => {
  it("registers in the search family, and the descriptions cross-reference each other (which leg is which)", async () => {
    const { root, deps } = setupProject("desc");
    const tools = await buildProjectTools(root, undefined, deps);
    const symDesc = tool(tools, "search_symbols").description;
    // The tool that exists + teaches its own contract.
    expect(symDesc).toContain("SYMBOL INDEX");
    expect(symDesc).toContain("PREFIX");
    expect(symDesc).toContain("index_project");
    expect(symDesc).toContain("search_code");
    // The manual refresher points back at the queryable surface.
    const idxDesc = tool(tools, "index_project").description;
    expect(idxDesc).toContain("search_symbols");
    expect(idxDesc).toContain("AUTOMATICALLY");
    // The retired fabrication is gone (search_code never queried the index).
    expect(idxDesc).not.toContain("via search_code");
  });

  it("honest refusals: no db / no project bound — and the query/kind validation errors name the fix", async () => {
    const { root } = setupProject("refuse");
    const bare = await buildProjectTools(root);
    const bareResult = await tool(bare, "search_symbols").execute({ query: "alpha" });
    expect(bareResult.ok).toBe(false);
    expect(bareResult.output).toContain("no db in this context");

    const dbOnly = await buildProjectTools(root, undefined, {
      db: db!,
      sessionId: "sess-r98f3-noproj",
      agentId: "agt-r98f3-noproj",
    } as ToolDeps);
    const noProject = await tool(dbOnly, "search_symbols").execute({ query: "alpha" });
    expect(noProject.ok).toBe(false);
    expect(noProject.output).toContain("no project bound to this session");

    const { deps } = setupProject("validate");
    const withDeps = await buildProjectTools(deps.db === db ? "" : "", undefined, deps);
    const empty = await tool(withDeps, "search_symbols").execute({ query: "   " });
    expect(empty.ok).toBe(false);
    expect(empty.output).toContain("non-empty symbol-name prefix");
    const badKind = await tool(withDeps, "search_symbols").execute({ query: "a", kind: "methods" });
    expect(badKind.ok).toBe(false);
    expect(badKind.output).toContain("must be one of: function, class, const, variable, import, type, interface");
    expect(badKind.output).toContain("got 'methods'");
  });

  it("the result SHAPE: built-at header + path:line [kind] symbol — signature rows", async () => {
    const { root, deps } = setupProject("shape");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function alpha(x: number): void {\n  return;\n}\n", "utf8");
    writeFileSync(join(root, "src", "b.ts"), "export class BetaWidget {\n  run() {}\n}\n", "utf8");
    const tools = await buildProjectTools(root, undefined, deps);
    await tool(tools, "index_project").execute({});

    const result = await tool(tools, "search_symbols").execute({ query: "alpha" });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/^symbol index \(built at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\) — 1 match for 'alpha'$/m);
    expect(result.output).toContain("src/a.ts:1 [function] alpha — export function alpha(x: number): void {");
    // Fresh index → NO staleness note.
    expect(result.output).not.toContain("stale");
    expect(result.output).not.toContain("index_project");
  });

  it("the kind filter + limit (capped results say so honestly)", async () => {
    const { root, deps } = setupProject("filter");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "k.ts"), "export function alphaRun() {}\nexport class alphaBox {}\nexport const alphaFlag = 1;\n", "utf8");
    const tools = await buildProjectTools(root, undefined, deps);
    await tool(tools, "index_project").execute({});

    const onlyClasses = await tool(tools, "search_symbols").execute({ query: "alpha", kind: "class" });
    expect(onlyClasses.ok).toBe(true);
    expect(onlyClasses.output).toContain("(kind: class)");
    expect(onlyClasses.output).toContain("[class] alphaBox");
    expect(onlyClasses.output).not.toContain("[function] alphaRun");

    const capped = await tool(tools, "search_symbols").execute({ query: "alpha", limit: 2 });
    expect(capped.ok).toBe(true);
    expect(capped.output).toContain("capped at 2 results");
  });

  it("the honest STALENESS note: a backdated index (>10 min) says stale + points at index_project", async () => {
    const { root, deps } = setupProject("stale");
    writeFileSync(join(root, "s.ts"), "export function alpha() {}\n", "utf8");
    const tools = await buildProjectTools(root, undefined, deps);
    await tool(tools, "index_project").execute({});
    // Backdate EVERY row past the 10-minute horizon (SQLite UTC clock).
    db!.prepare("UPDATE codebase_index SET ts = datetime('now', '-15 minutes') WHERE project_id = ?").run(deps.projectId);

    const result = await tool(tools, "search_symbols").execute({ query: "alpha" });
    expect(result.ok).toBe(true);
    // Rows still return (the index answers; the note carries the caveat).
    expect(result.output).toContain("s.ts:1 [function] alpha");
    expect(result.output).toContain("the index is stale");
    expect(result.output).toContain("more than 10 minutes ago");
    expect(result.output).toContain("call index_project to refresh it");
  });

  it("the honest EMPTY note: files exist but nothing indexed → the note; a file-less root → NO note (empty is CORRECT there)", async () => {
    const { root, deps } = setupProject("empty-note");
    writeFileSync(join(root, "code.ts"), "export function alpha() {}\n", "utf8");
    const tools = await buildProjectTools(root, undefined, deps);
    const result = await tool(tools, "search_symbols").execute({ query: "alpha" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("the symbol index is empty for this project");
    expect(result.output).toContain("call index_project to build it now");
    expect(result.output).toContain("(no matching symbols)");

    // A root with NO files: an empty index is the truth — no stale noise.
    const { root: emptyRoot, deps: emptyDeps } = setupProject("empty-root");
    const emptyTools = await buildProjectTools(emptyRoot, undefined, emptyDeps);
    const emptyResult = await tool(emptyTools, "search_symbols").execute({ query: "alpha" });
    expect(emptyResult.ok).toBe(true);
    expect(emptyResult.output).not.toContain("empty for this project");
    expect(emptyResult.output).not.toContain("stale");
  });
});

/* ── B: the incremental index (reindexFile after writes) ─────────────────── */

describe("R98-F3 B: the incremental index after write/edit", () => {
  it("a symbol born via write_file is searchable IMMEDIATELY (no manual index call)", async () => {
    const { root, deps } = setupProject("incr-write");
    const tools = await buildProjectTools(root, undefined, deps);
    await tool(tools, "write_file").execute({
      path: "born.ts",
      content: "export function bornLater(): number {\n  return 42;\n}\n",
    });
    const result = await tool(tools, "search_symbols").execute({ query: "bornLater" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("born.ts:1 [function] bornLater");
  });

  it("an edit_file that ADDS a symbol updates the row set (and a renamed symbol loses its old name)", async () => {
    const { root, projectId, deps } = setupProject("incr-edit");
    writeFileSync(join(root, "edit-me.ts"), "export function oldName() {}\n", "utf8");
    const tools = await buildProjectTools(root, undefined, deps);
    // Seed the index for the ORIGINAL content, then edit. (R98-F23: the
    // destructure takes setupProject's non-undefined projectId — ToolDeps'
    // optional field fails the shared root-tsc gate.)
    reindexFile(db!, projectId, root, "edit-me.ts");
    await tool(tools, "edit_file").execute({
      path: "edit-me.ts",
      oldString: "export function oldName() {}",
      newString: "export function newName() {\n  return 1;\n}",
    });
    const after = await tool(tools, "search_symbols").execute({ query: "newName" });
    expect(after.ok).toBe(true);
    expect(after.output).toContain("edit-me.ts:1 [function] newName");
    const old = await tool(tools, "search_symbols").execute({ query: "oldName" });
    expect(old.output).toContain("(no matching symbols)");
  });

  it("delete_file clears the path's rows (search_symbols never returns a dead path)", async () => {
    const { root, projectId, deps } = setupProject("incr-del");
    writeFileSync(join(root, "gone.ts"), "export function goneFn() {}\n", "utf8");
    const tools = await buildProjectTools(root, undefined, deps);
    reindexFile(db!, projectId, root, "gone.ts");
    expect((await tool(tools, "search_symbols").execute({ query: "goneFn" })).output).toContain("gone.ts:1");
    await tool(tools, "delete_file").execute({ path: "gone.ts" });
    const after = await tool(tools, "search_symbols").execute({ query: "goneFn" });
    expect(after.output).toContain("(no matching symbols)");
  });
});

/* ── C: the auto-index keeper ────────────────────────────────────────────── */

describe("R98-F3 C: the auto-index keeper (storage/auto-index.ts)", () => {
  it("parseSqliteTs: SQLite's UTC shape parses AS UTC (the local-time trap), bad shapes are null", () => {
    expect(parseSqliteTs("2026-01-01 10:00:00")).toBe(Date.parse("2026-01-01T10:00:00Z"));
    expect(parseSqliteTs("2026-01-01 10:00:00 ")).toBe(Date.parse("2026-01-01T10:00:00Z")); // trimmed
    expect(parseSqliteTs("2026-01-01T10:00:00")).toBeNull();
    expect(parseSqliteTs("not-a-ts")).toBeNull();
    // AUTO_INDEX_STALE_MS is the documented ~10-minute horizon.
    expect(AUTO_INDEX_STALE_MS).toBe(10 * 60 * 1000);
  });

  it("isIndexStale: missing rows → true; fresh → false; >10 min → true; getIndexedAt is the rows' MAX(ts)", () => {
    const { root, projectId } = setupProject("fact");
    writeFileSync(join(root, "f.ts"), "export function fact() {}\n", "utf8");
    expect(getIndexedAt(db!, projectId)).toBeNull();
    expect(isIndexStale(db!, projectId)).toBe(true);
    reindexProject(db!, projectId, root);
    expect(getIndexedAt(db!, projectId)).not.toBeNull();
    expect(isIndexStale(db!, projectId)).toBe(false);
    db!.prepare("UPDATE codebase_index SET ts = datetime('now', '-15 minutes') WHERE project_id = ?").run(projectId);
    expect(isIndexStale(db!, projectId)).toBe(true);
  });

  it("maybeAutoIndexProject: a MISSING index fires the guarded walk (fire-and-forget — rows land after a tick)", async () => {
    const { root, projectId } = setupProject("fire");
    writeFileSync(join(root, "fire.ts"), "export function fired() {}\n", "utf8");
    expect(maybeAutoIndexProject(db!, projectId, root)).toBe(true);
    // In-flight until the setImmediate slot runs…
    expect(autoIndexInFlightForTest()).toContain(projectId);
    // …the CONCURRENCY guard: a second call while in flight does nothing.
    expect(maybeAutoIndexProject(db!, projectId, root)).toBe(false);
    await flushImmediates();
    // The walk landed + the guard cleared.
    expect(autoIndexInFlightForTest()).not.toContain(projectId);
    expect(isIndexStale(db!, projectId)).toBe(false);
    // And a FRESH index never re-fires.
    expect(maybeAutoIndexProject(db!, projectId, root)).toBe(false);
    expect(autoIndexInFlightForTest()).toHaveLength(0);
  });

  it("the attempt COOLDOWN bounds retries: a walk that indexed nothing retries at most once per 10 minutes", async () => {
    // A root whose only file is NOT indexable (.txt) — the walk completes
    // with 0 rows, so MAX(ts) stays NULL and the staleness fact stays true.
    const { root, projectId } = setupProject("cooldown");
    writeFileSync(join(root, "notes.txt"), "no symbols here\n", "utf8");
    expect(maybeAutoIndexProject(db!, projectId, root)).toBe(true);
    await flushImmediates();
    expect(isIndexStale(db!, projectId)).toBe(true); // still stale — nothing indexable
    // …but the cooldown refuses the immediate retry (never once per turn).
    expect(maybeAutoIndexProject(db!, projectId, root)).toBe(false);
  });

  it("a FRESH index is left alone (the walk does not run — MAX(ts) unchanged)", async () => {
    const { root, projectId } = setupProject("nofire");
    writeFileSync(join(root, "n.ts"), "export function nope() {}\n", "utf8");
    reindexProject(db!, projectId, root);
    // Backdate to WITHIN the horizon (5 minutes old = fresh).
    db!.prepare("UPDATE codebase_index SET ts = datetime('now', '-5 minutes') WHERE project_id = ?").run(projectId);
    const before = getIndexedAt(db!, projectId);
    expect(maybeAutoIndexProject(db!, projectId, root)).toBe(false);
    await flushImmediates();
    expect(getIndexedAt(db!, projectId)).toBe(before); // untouched
  });
});

/* ── D: the runtime hook (prepareTurn fires the keeper) ──────────────────── */

describe("R98-F3 D: the prepareTurn auto-index hook (a real streamed turn)", () => {
  const KEY = "sk-r98-f3";
  const summarizerChat: ChatFn = async () => ({
    text: "SUMMARY: prior work.",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    toolCalls: [],
  });

  function turnHarness(_root: string, projectId: string): { sessionId: string; keyring: ProviderKeyring } {
    const agent = createAgent(db!, { name: "R98-F3 Turn Agent", providerId: "openrouter", model: "test/r98-f3" });
    const session = createSession(db!, { agentId: agent.id, mode: "single", projectId });
    return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
  }

  it("a turn against a project with files but NO index leaves the index BUILT (the background walk fired in prepareTurn)", async () => {
    const root = mkdtempSync(join(tmpdir(), "acute-r98f3-turn-"));
    writeFileSync(join(root, "turn.ts"), "export function turned() {}\n", "utf8");
    const project = createProject(db!, { name: "R98-F3-Turn", rootPath: root });
    const { sessionId, keyring } = turnHarness(root, project.id);

    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "text-delta", delta: "done" };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
    };
    const outcome = await runStreamedAgentTurn(
      { db: db!, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "hello",
      () => undefined,
    );
    expect(outcome.ok).toBe(true);
    await flushImmediates();
    // The keeper walked the project during prepareTurn — no manual call anywhere.
    expect(isIndexStale(db!, project.id)).toBe(false);
    const row = db!
      .prepare("SELECT symbol FROM codebase_index WHERE project_id = ? AND symbol = 'turned'")
      .get(project.id) as { symbol: string } | undefined;
    expect(row?.symbol).toBe("turned");
  });

  it("a FRESH index (<10 min) is NOT re-walked by a turn (MAX(ts) unchanged)", async () => {
    const root = mkdtempSync(join(tmpdir(), "acute-r98f3-turn2-"));
    writeFileSync(join(root, "turn2.ts"), "export function steady() {}\n", "utf8");
    const project = createProject(db!, { name: "R98-F3-Turn2", rootPath: root });
    reindexProject(db!, project.id, root);
    db!.prepare("UPDATE codebase_index SET ts = datetime('now', '-5 minutes') WHERE project_id = ?").run(project.id);
    const before = getIndexedAt(db!, project.id);
    const { sessionId, keyring } = turnHarness(root, project.id);

    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "text-delta", delta: "done" };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
    };
    const outcome = await runStreamedAgentTurn(
      { db: db!, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "hello",
      () => undefined,
    );
    expect(outcome.ok).toBe(true);
    await flushImmediates();
    expect(getIndexedAt(db!, project.id)).toBe(before);
  });
});
