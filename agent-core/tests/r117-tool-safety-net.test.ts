// @vitest-environment node
//
// ROUND-117 (R117-e) — deliverable 2: the TOOL-EXECUTE SAFETY NET
// (tools/index.ts's wrapToolExecute). Pre-R117 an execute that THREW — an
// external plugin's stray TypeError — surfaced as an SDK error part that
// killed the WHOLE turn as a provider error. Now it becomes an honest
// {ok:false, output:"<toolName> failed: <scrubbed message>"} result, while
// abort-shaped errors still PROPAGATE (cancellation is not a tool failure).
//
// Driven through the REAL buildProjectTools with a fixture external plugin
// (the r52-plugin-registry pattern): the plugin dir env override + the
// tools.externalPlugins=user setting + deps — exactly the production path.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import { buildProjectTools } from "../src/tools/index";
import { clearExternalPluginCacheForTest } from "../src/tools/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

let tempDir = "";
let db: SqliteDatabase;
let pluginDir = "";

/** One fixture plugin with ONE deliberately-broken + odd-shaped tools. */
function writeFixtureTools(dir: string, file: string, toolsSource: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    `export default {
  id: "fixture-r117e",
  name: "R117-e fixture",
  version: "1.0.0",
  description: "error-hardening fixture plugin",
  category: "external",
  tools: [
${toolsSource}
  ],
};
`,
  );
}

/** The THROWING tool's source (secrets embedded so the scrub is pinnable). */
const BOOM_TOOL = `    {
      name: "fx_boom",
      description: "A fixture tool that always throws.",
      schema: { type: "object", properties: { text: { type: "string" } } },
      execute: async () => {
        throw new Error("plugin exploded — key sk-abc123abc123abc1 leaked into the message");
      },
    },`;

const ABORT_TOOL = `    {
      name: "fx_abort",
      description: "A fixture tool that rejects with an AbortError.",
      schema: { type: "object" },
      execute: async () => {
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      },
    },`;

const STOPNOISE_TOOL = `    {
      name: "fx_stopnoise",
      description: "A fixture tool that throws a plain error while the turn signal is aborted.",
      schema: { type: "object" },
      execute: async () => {
        throw new Error("anything thrown while the turn is being stopped");
      },
    },`;

const STRING_TOOL = `    {
      name: "fx_string",
      description: "A fixture tool returning a plain string (the legacy shape).",
      schema: { type: "object" },
      execute: async () => "just a string",
    },`;

const SHAPE_TOOL = `    {
      name: "fx_shape",
      description: "A fixture tool returning an object WITHOUT an ok field.",
      schema: { type: "object" },
      execute: async () => ({ rows: ["a", "b"], truncated: false }),
    },`;

const NULL_TOOL = `    {
      name: "fx_null",
      description: "A fixture tool returning null.",
      schema: { type: "object" },
      execute: async () => null,
    },`;

let prevPluginDir: string | undefined;
let fixtureCounter = 0;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r117e-tools-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  pluginDir = join(tempDir, "plugins");
  clearExternalPluginCacheForTest();
  db.prepare("INSERT INTO settings (key, value) VALUES ('tools.externalPlugins', 'user')").run();
  prevPluginDir = process.env.ACUTE_EXTERNAL_PLUGIN_DIR;
  process.env.ACUTE_EXTERNAL_PLUGIN_DIR = pluginDir;
});

afterEach(() => {
  if (prevPluginDir === undefined) delete process.env.ACUTE_EXTERNAL_PLUGIN_DIR;
  else process.env.ACUTE_EXTERNAL_PLUGIN_DIR = prevPluginDir;
  clearExternalPluginCacheForTest();
  db.prepare("DELETE FROM settings WHERE key = 'tools.externalPlugins'").run();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Build the toolset with the fixture plugin loaded (deps = the real path).
 * Each call writes a UNIQUE file name — the ESM module registry caches
 * dynamic imports by URL, so rewriting one file would serve the first
 * version forever (the r52 suite's one-file-per-fixture discipline). */
async function toolsWith(
  ...toolSources: string[]
): Promise<
  Record<string, { execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> }>
> {
  fixtureCounter += 1;
  writeFixtureTools(pluginDir, `r117e-${fixtureCounter}.mjs`, toolSources.join("\n"));
  const tools = await buildProjectTools(tempDir, undefined, {
    db,
    sessionId: "sess-r117e",
    agentId: "agent-r117e",
  });
  return tools as unknown as Record<
    string,
    { execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> }
  >;
}

describe("R117-e: the tool-execute safety net (wrapToolExecute)", () => {
  it("a THROWING tool becomes an honest {ok:false} tool result — never an SDK error that kills the turn", async () => {
    const tools = await toolsWith(BOOM_TOOL);
    const result = await tools.fx_boom.execute({ text: "hi" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("fx_boom failed:");
    expect(result.output).toContain("plugin exploded");
    // The scrub: the key shape embedded in the thrown message is redacted.
    expect(result.output).not.toContain("sk-abc123abc123abc1");
    expect(result.output).toContain("sk-***");
  });

  it("an AbortError PROPAGATES (cancellation is not a tool failure)", async () => {
    const tools = await toolsWith(ABORT_TOOL);
    const error: unknown = await tools.fx_abort.execute({}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  });

  it("a plain error thrown while the turn's signal is ABORTED also propagates (stop-noise, not a tool bug)", async () => {
    const controller = new AbortController();
    controller.abort("owner stop");
    fixtureCounter += 1;
    writeFixtureTools(pluginDir, `r117e-${fixtureCounter}.mjs`, STOPNOISE_TOOL);
    const tools = (await buildProjectTools(tempDir, undefined, {
      db,
      sessionId: "sess-r117e",
      agentId: "agent-r117e",
      signal: controller.signal,
    })) as unknown as Record<
      string,
      { execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> }
    >;
    const error: unknown = await tools.fx_stopnoise.execute({}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("anything thrown while the turn is being stopped");
  });

  it("a proper ToolResult passes through normalized (built-ins' byte-identical path)", async () => {
    const tools = await toolsWith(STRING_TOOL);
    // A REAL built-in rides the same wrapper — read_file with a bad path is
    // the honest ok:false shape (never a throw).
    const read = tools.read_file;
    const failed = await read.execute({ path: "nope-does-not-exist.txt" });
    expect(failed.ok).toBe(false);
    expect(typeof failed.output).toBe("string");
  });

  it("a plain STRING return stays the success-by-design shape: {ok:true, output}", async () => {
    const tools = await toolsWith(STRING_TOOL);
    const result = await tools.fx_string.execute({});
    expect(result).toEqual({ ok: true, output: "just a string" });
  });

  it("an object return WITHOUT ok passes through VERBATIM (chat.ts's fold owns the tagging)", async () => {
    const tools = await toolsWith(SHAPE_TOOL);
    const result = await tools.fx_shape.execute({});
    expect(result).toEqual({ rows: ["a", "b"], truncated: false });
  });

  it("a null return is a broken tool: the honest failure result", async () => {
    const tools = await toolsWith(NULL_TOOL);
    const result = await tools.fx_null.execute({});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("fx_null failed:");
    expect(result.output).toContain("returned no result");
  });

  it("a HUGE thrown message is capped (the model-facing result stays bounded)", async () => {
    const hugeTool = `    {
      name: "fx_huge",
      description: "A fixture tool that throws a giant message.",
      schema: { type: "object" },
      execute: async () => {
        throw new Error("x".repeat(50_000));
      },
    },`;
    const tools = await toolsWith(hugeTool);
    const result = await tools.fx_huge.execute({});
    expect(result.ok).toBe(false);
    expect(result.output.length).toBeLessThan(2_400);
    expect(result.output).toContain("truncated");
  });
});
