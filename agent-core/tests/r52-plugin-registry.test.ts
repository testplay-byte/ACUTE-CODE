// @vitest-environment node
//
// ROUND-52 (R52-f): the PLUGIN TOOL REGISTRY tests.
//
// The owner's directive: a plug-in-based tool system "just like how DeepSeek
// harness is" — every built-in tool group is a plugin (tools/plugins/*.ts)
// and external .mjs plugins load from disk. These tests pin:
//   1. the built-in catalog covers every historical tool (24 incl. the
//      R52-a job tools) — the catalog is COMPUTED from the real plugin
//      declarations, so it can never drift again
//   2. buildProjectTools assembles identical toolsets through the registry
//      (allowlist semantics preserved: []/undefined = ALL)
//   3. external plugin loading: valid module → tools; invalid shapes rejected
//      fail-soft; name collisions favor the built-in; scope rules (off/user/all)
//   4. an external tool actually EXECUTES through the assembled toolset
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import {
  BUILT_IN_PLUGINS,
  builtInToolCatalog,
  clearExternalPluginCacheForTest,
  loadExternalPlugins,
} from "../src/tools/registry";
import { buildProjectTools } from "../src/tools/index";
import { TOOL_NAMES } from "../src/storage/agents";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r52-plugins-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  clearExternalPluginCacheForTest();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** A well-formed external plugin fixture. */
function writeFixturePlugin(dir: string, file: string, toolName: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    `export default {
  id: "fixture-${toolName}",
  name: "Fixture ${toolName}",
  version: "1.0.0",
  description: "test fixture plugin",
  category: "external",
  tools: [
    {
      name: "${toolName}",
      description: "A fixture tool that echoes its input.",
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async (input) => ({ ok: true, output: "echo: " + String(input.text ?? "") }),
    },
  ],
};
`,
  );
}

describe("ROUND-52 (R52-f): the plugin registry", () => {
  it("every built-in plugin declares a valid id/category and its tools follow the name grammar", async () => {
    // ROUND-61 (R61): + computer-use + skills + mcp = 12; ROUND-66 (R66-2-b):
    // + core-vision (analyze_image) = 13.
    expect(BUILT_IN_PLUGINS.length).toBe(13);
    // Declaration-stub deps (same shape builtInToolCatalog uses) so the
    // delegation plugin — gated on keyring/chat PRESENCE — also declares.
    const { ProviderKeyring } = await import("../src/providers/registry");
    const stubDeps = {
      db: db,
      sessionId: "decl",
      agentId: "decl",
      keyring: new ProviderKeyring({}),
      chat: (async () => ({
        text: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        toolCalls: [],
      })) as unknown as import("../src/agents/chat").ChatFn,
    };
    // ROUND-61: computer-use (settings default OFF) and mcp (no servers
    // configured) LEGITIMATELY declare zero tools on a fresh database —
    // the settings/db gates, not broken plugins. Everything else declares.
    // ROUND-66 (R66-2-b): core-vision declares analyze_image even with
    // vision OFF (the honest refusal IS the switch — no absence gate).
    const zeroByDesign = new Set(["core-computer-use", "core-mcp"]);
    for (const plugin of BUILT_IN_PLUGINS) {
      expect(plugin.id).toMatch(/^core-[a-z-]+$/);
      expect(plugin.category).toMatch(/^[a-z]+$/);
      const tools = await plugin.createTools({ root: tempDir, toolDeps: stubDeps });
      if (zeroByDesign.has(plugin.id)) {
        expect(tools).toHaveLength(0);
        continue;
      }
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.name).toMatch(/^[a-z][a-z0-9_]{1,31}$/);
        expect(tool.description.length).toBeGreaterThan(10);
        expect(typeof tool.execute).toBe("function");
      }
    }
    // The skills plugin declares read_skill on a live db.
    const skills = await BUILT_IN_PLUGINS.find((p) => p.id === "core-skills")?.createTools({ root: tempDir, toolDeps: stubDeps });
    expect(skills?.map((t) => t.name)).toEqual(["read_skill"]);
    // Without deps the delegation plugin declares NOTHING (the keyring/chat
    // gate — the historical R36 semantics preserved through the registry).
    const bare = await BUILT_IN_PLUGINS[BUILT_IN_PLUGINS.length - 1].createTools({ root: tempDir });
    expect(bare).toHaveLength(0);
  });

  it("the computed catalog covers every historical tool — including the full TOOL_NAMES seed set", async () => {
    const catalog = await builtInToolCatalog();
    const names = catalog.map((entry) => entry.name);
    // The 24-tool truth: 22 base (filesystem 6, search 3, git 3, terminal 3,
    // web 2, browser 1, memory 3, todo 1) + delegate_task + ... = via the
    // catalog itself. The INVARIANT that matters: every seedable tool name
    // (TOOL_NAMES) is declarable by a plugin.
    for (const name of TOOL_NAMES) {
      expect(names).toContain(name);
    }
    expect(names).toContain("delegate_task");
    expect(names).toContain("job_status");
    expect(names).toContain("job_stop");
    // Every entry carries its plugin metadata.
    for (const entry of catalog) {
      expect(entry.pluginId).toMatch(/^(core|ext)-/);
      expect(entry.description).not.toBe("");
    }
  });

  it("buildProjectTools assembles through the registry with the exact allowlist semantics", async () => {
    const all = await buildProjectTools(tempDir);
    const names = Object.keys(all);
    // The 22 base tools + delegate_task needs deps (absent here) = 22.
    expect(names.length).toBe(22);
    expect(names).toContain("run_command");
    expect(names).toContain("job_status");

    const two = await buildProjectTools(tempDir, ["read_file", "job_stop"]);
    expect(Object.keys(two).sort()).toEqual(["job_stop", "read_file"]);

    const empty = await buildProjectTools(tempDir, []);
    expect(Object.keys(empty).length).toBe(22);

    const none = await buildProjectTools(tempDir, ["__none__"]);
    expect(Object.keys(none)).toHaveLength(0);
  });
});

describe("ROUND-52 (R52-f): external plugin loading", () => {
  it("loads a valid external plugin and its tool EXECUTES through the assembled toolset", async () => {
    const pluginDir = join(tempDir, "plugins");
    writeFixturePlugin(pluginDir, "echo.mjs", "fx_echo");

    const plugins = await loadExternalPlugins(tempDir, "all", [pluginDir]);
    expect(plugins.length).toBe(1);
    expect(plugins[0].id).toBe("ext-fixture-fx_echo");

    // Through the real assembler: deps carry a db; the scope setting is the
    // DEFAULT ("user" — but the loadExternalPlugins call above proves dir
    // loading; here we prove assembly+execution via the tools themselves).
    const definitions = await plugins[0].createTools({ root: tempDir });
    expect(definitions[0].name).toBe("fx_echo");
    const result = await definitions[0].execute({ text: "hello" }, { root: tempDir });
    expect(result).toEqual({ ok: true, output: "echo: hello" });
  });

  it("invalid plugins are rejected fail-soft (never throw)", async () => {
    const pluginDir = join(tempDir, "bad-plugins");
    mkdirSync(pluginDir, { recursive: true });
    // No default export.
    writeFileSync(join(pluginDir, "nodefault.mjs"), "export const x = 1;\n");
    // Bad tool name.
    writeFileSync(
      join(pluginDir, "badname.mjs"),
      `export default { id: "bad-name", name: "Bad", version: "1", description: "d", category: "external",
        tools: [{ name: "Not_Valid", description: "d", schema: { type: "object" }, execute: async () => ({ ok: true, output: "" }) }] };\n`,
    );
    // Syntax error.
    writeFileSync(join(pluginDir, "broken.mjs"), "this is not valid javascript !!!\n");

    const plugins = await loadExternalPlugins(tempDir, "all", [pluginDir]);
    expect(plugins).toHaveLength(0);
  });

  it("a built-in tool name can never be shadowed by an external plugin (real assembler)", async () => {
    const pluginDir = join(tempDir, "shadow-plugins");
    writeFixturePlugin(pluginDir, "shadow.mjs", "run_command");
    writeFixturePlugin(pluginDir, "friend.mjs", "fx_friend");

    // Point the REAL loader at the fixture dir (env override) + enable the
    // scope, then assemble through buildProjectTools exactly like a turn.
    const prevDir = process.env.ACUTE_EXTERNAL_PLUGIN_DIR;
    process.env.ACUTE_EXTERNAL_PLUGIN_DIR = pluginDir;
    clearExternalPluginCacheForTest();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES ('tools.externalPlugins', 'user')").run();
      const tools = await buildProjectTools(tempDir, undefined, {
        db,
        sessionId: "sess-fx",
        agentId: "agent-fx",
      });
      // The colliding fixture is DROPPED — run_command stays the REAL one
      // (its description mentions the approvals engine; the fixture's says
      // "echoes its input").
      const runCommand = tools.run_command as unknown as { description: string; execute: (i: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> };
      expect(runCommand.description).toContain("project root");
      // The NON-colliding external tool IS registered and executes.
      const friend = tools.fx_friend as unknown as { execute: (i: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> };
      expect(friend).toBeDefined();
      const result = await friend.execute({ text: "hi" });
      expect(result).toEqual({ ok: true, output: "echo: hi" });
    } finally {
      if (prevDir === undefined) delete process.env.ACUTE_EXTERNAL_PLUGIN_DIR;
      else process.env.ACUTE_EXTERNAL_PLUGIN_DIR = prevDir;
      clearExternalPluginCacheForTest();
      db.prepare("DELETE FROM settings WHERE key = 'tools.externalPlugins'").run();
    }
  });

  it("scope rules: off loads nothing; user reads only the user dir; all adds the project dir", async () => {
    // Pin the REAL dir-resolution matrix through the public API: a fake HOME
    // (POSIX homedir()) + USERPROFILE (Windows homedir()) redirects the user
    // scope, the project root carries .acute/plugins, and the scope decides
    // which of the two are consulted. (The dirsOverride param is a TEST seam
    // that BYPASSES scope resolution — using it here would pin nothing.)
    const fakeHome = join(tempDir, "fake-home");
    const userDir = join(fakeHome, ".acute", "plugins");
    const projectRoot = join(tempDir, "proj");
    const projectDir = join(projectRoot, ".acute", "plugins");
    writeFixturePlugin(userDir, "u.mjs", "fx_user");
    writeFixturePlugin(projectDir, "p.mjs", "fx_project");

    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevOverride = process.env.ACUTE_EXTERNAL_PLUGIN_DIR;
    delete process.env.ACUTE_EXTERNAL_PLUGIN_DIR;
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;

      const off = await loadExternalPlugins(projectRoot, "off");
      expect(off).toHaveLength(0);

      const user = await loadExternalPlugins(projectRoot, "user");
      expect(user.map((p) => p.id)).toEqual(["ext-fixture-fx_user"]);

      const all = await loadExternalPlugins(projectRoot, "all");
      expect(all.map((p) => p.id).sort()).toEqual([
        "ext-fixture-fx_project",
        "ext-fixture-fx_user",
      ]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevOverride !== undefined) process.env.ACUTE_EXTERNAL_PLUGIN_DIR = prevOverride;
      clearExternalPluginCacheForTest();
    }
  });

  it("readExternalPluginScope reads the settings row with the documented default", () => {
    // Default when the row is absent: "user".
    expect(readScope(db)).toBe("user");
    db.prepare("INSERT INTO settings (key, value) VALUES ('tools.externalPlugins', 'all')").run();
    expect(readScope(db)).toBe("all");
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'tools.externalPlugins'").run();
    expect(readScope(db)).toBe("off");
    db.prepare("UPDATE settings SET value = 'garbage' WHERE key = 'tools.externalPlugins'").run();
    expect(readScope(db)).toBe("user");
  });
});

// Local import wrapper (keeps the import list at the top tidy).
import { readExternalPluginScope } from "../src/tools/registry";
function readScope(database: SqliteDatabase): string {
  return readExternalPluginScope(database);
}
