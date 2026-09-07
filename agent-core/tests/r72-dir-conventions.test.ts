// @vitest-environment node
//
// ROUND-72 (R72-d): PER-DIRECTORY CONVENTIONS — the kilocode AGENTS.md
// pattern, pinned:
//   D1. findDeepestConvention walks the read file's directory chain UP
//       toward (but EXCLUDING) the project root, nearest level first;
//       AGENTS.md before CLAUDE.md at each level; exact case only;
//       unreadable/wrong-shaped candidates are skipped, never crash; the
//       excerpt is capped at 2,000 chars with an honest truncation marker.
//       ROOT files are skipped BY DESIGN — readCustomRules already injects
//       them into every turn's system prompt (no double-billing).
//   D2. read_file (the TOOL) appends the reminder after a SUCCESSFUL read,
//       once per (session, dir) via the module map; sessionless builds
//       inject deterministically every time; failures and ROOT files get
//       nothing; the RAW readFile (REST file-viewer route) is untouched.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createAgent } from "../src/storage/agents";
import { createSession } from "../src/storage/sessions";
import { readFile } from "../src/tools/fs-ops";
import { buildProjectTools, type ToolDeps } from "../src/tools/index";
import {
  conventionReminder,
  findDeepestConvention,
  resetDirConventionInjections,
  shouldInject,
  type DirConvention,
} from "../src/tools/dir-conventions";
import type { ToolSet } from "ai";

// Every test gets its OWN fixture root — the walk reads whatever is on disk
// at call time, so a shared root would leak conventions between tests.
const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "acute-r72-"));
  roots.push(root);
  return root;
}

beforeEach(() => {
  resetDirConventionInjections();
});

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// The AI SDK tool contract — narrow to what the tests call (the shape the
// other toolset tests use).
type ExecutableTool = {
  description: string;
  execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};
function tool(set: ToolSet, name: string): ExecutableTool {
  return (set as unknown as Record<string, ExecutableTool>)[name];
}

/* ── D1: findDeepestConvention — the walk ─────────────────────────────────── */

describe("R72-d D1: findDeepestConvention — deepest wins, root excluded", () => {
  it("the deepest AGENTS.md governs the file (root + a/ + a/b/ all present → a/b's); backslash input resolves the same", () => {
    const root = newRoot();
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "ROOT POLICY", "utf8");
    writeFileSync(join(root, "a/AGENTS.md"), "A RULES", "utf8");
    writeFileSync(join(root, "a/b/AGENTS.md"), "B RULES", "utf8");
    const conv = findDeepestConvention(root, "a/b/c.ts");
    expect(conv).not.toBeNull();
    expect(conv!.dir).toBe("a/b");
    expect(conv!.file).toBe("a/b/AGENTS.md");
    expect(conv!.excerpt).toBe("B RULES");
    // Windows-style separators are normalized (POSIX-ish walk on every OS).
    const viaBackslash = findDeepestConvention(root, "a\\b\\c.ts");
    expect(viaBackslash?.file).toBe("a/b/AGENTS.md");
  });

  it("CLAUDE.md is accepted when AGENTS.md is absent at every level nearer than root (a/CLAUDE.md governs a/b/c.ts)", () => {
    const root = newRoot();
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(join(root, "a/CLAUDE.md"), "CLAUDE RULES", "utf8");
    const conv = findDeepestConvention(root, "a/b/c.ts");
    expect(conv).not.toBeNull();
    expect(conv!.dir).toBe("a");
    expect(conv!.file).toBe("a/CLAUDE.md");
    expect(conv!.excerpt).toBe("CLAUDE RULES");
  });

  it("at the SAME level AGENTS.md beats CLAUDE.md; a DEEPER CLAUDE.md beats a shallower AGENTS.md", () => {
    const root = newRoot();
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(join(root, "a/AGENTS.md"), "A AGENTS", "utf8");
    writeFileSync(join(root, "a/CLAUDE.md"), "A CLAUDE", "utf8");
    writeFileSync(join(root, "a/b/CLAUDE.md"), "B CLAUDE", "utf8");
    expect(findDeepestConvention(root, "a/x.ts")?.file).toBe("a/AGENTS.md");
    expect(findDeepestConvention(root, "a/b/y.ts")?.file).toBe("a/b/CLAUDE.md");
  });

  it("a root-only convention file → null (root is readCustomRules territory — skipped by design)", () => {
    const root = newRoot();
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "ROOT POLICY", "utf8");
    writeFileSync(join(root, "CLAUDE.md"), "ROOT CLAUDE", "utf8");
    writeFileSync(join(root, "a/c.ts"), "x", "utf8");
    expect(findDeepestConvention(root, "a/c.ts")).toBeNull();
  });

  it("no convention files anywhere → null; a file directly in the root → null; bad paths never win", () => {
    const root = newRoot();
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a/c.ts"), "x", "utf8");
    expect(findDeepestConvention(root, "a/c.ts")).toBeNull();
    writeFileSync(join(root, "AGENTS.md"), "ROOT", "utf8");
    // A file IN the root has no ancestor strictly below the root.
    writeFileSync(join(root, "top.ts"), "y", "utf8");
    expect(findDeepestConvention(root, "top.ts")).toBeNull();
    // Defensive posture (readFileWindow already rejected these before we
    // are ever called — direct callers get the same answer).
    expect(findDeepestConvention(root, "../a/c.ts")).toBeNull();
    expect(findDeepestConvention(root, "/abs/c.ts")).toBeNull();
    expect(findDeepestConvention(root, "")).toBeNull();
  });

  it("a wrong-shaped candidate (a DIRECTORY named AGENTS.md) is skipped and the walk falls through — never a crash", () => {
    const root = newRoot();
    mkdirSync(join(root, "a/AGENTS.md"), { recursive: true });
    writeFileSync(join(root, "a/CLAUDE.md"), "CLAUDE RULES", "utf8");
    expect(findDeepestConvention(root, "a/c.ts")?.file).toBe("a/CLAUDE.md");
    // With nothing left to fall back to → null (silent skip: a reminder,
    // not a gate — a broken convention file must not break the read).
    const root2 = newRoot();
    mkdirSync(join(root2, "a/AGENTS.md"), { recursive: true });
    writeFileSync(join(root2, "a/c.ts"), "x", "utf8");
    expect(findDeepestConvention(root2, "a/c.ts")).toBeNull();
  });

  it("the excerpt is capped at 2,000 chars with the honest truncation marker", () => {
    const root = newRoot();
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a/AGENTS.md"), "R".repeat(3_500), "utf8");
    const conv = findDeepestConvention(root, "a/c.ts");
    expect(conv).not.toBeNull();
    expect(conv!.excerpt.startsWith("R".repeat(2_000))).toBe(true);
    expect(conv!.excerpt.endsWith("…[truncated, 2000 of 3500 chars]…")).toBe(true);
    // Nothing past the cap rides along.
    expect(conv!.excerpt).not.toContain("R".repeat(2_001));
  });

  it("a convention within the cap is quoted VERBATIM (trailing newline included, no marker)", () => {
    const root = newRoot();
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a/AGENTS.md"), "# Rules\n\n- tests here use vitest\n", "utf8");
    expect(findDeepestConvention(root, "a/c.ts")?.excerpt).toBe("# Rules\n\n- tests here use vitest\n");
  });
});

/* ── D1: conventionReminder — the format pins ─────────────────────────────── */

describe("R72-d D1: conventionReminder — visibly separate, source named", () => {
  it("the exact format: blank line + opening fence naming the source, excerpt, closing fence that disclaims the file content", () => {
    const reminder = conventionReminder({ dir: "a/b", file: "a/b/AGENTS.md", excerpt: "RULES" });
    expect(reminder).toBe(
      "\n\n--- [conventions from a/b/AGENTS.md apply to this file]\nRULES\n--- (end conventions — the file content above is unaffected)",
    );
  });

  it("a CLAUDE.md source is named honestly; multi-line excerpts sit BETWEEN the fences", () => {
    const reminder = conventionReminder({ dir: "docs", file: "docs/CLAUDE.md", excerpt: "X\nY" });
    expect(reminder).toContain("[conventions from docs/CLAUDE.md apply to this file]");
    expect(reminder.startsWith("\n\n--- [conventions from")).toBe(true);
    expect(reminder.endsWith("--- (end conventions — the file content above is unaffected)")).toBe(true);
    const lines = reminder.split("\n");
    expect(lines[2]).toBe("--- [conventions from docs/CLAUDE.md apply to this file]");
    expect(lines[3]).toBe("X");
    expect(lines[4]).toBe("Y");
    expect(lines[5]).toBe("--- (end conventions — the file content above is unaffected)");
  });
});

/* ── D1: shouldInject — the session-once dedup ────────────────────────────── */

describe("R72-d D1: shouldInject — once per (session, dir)", () => {
  afterEach(() => {
    resetDirConventionInjections();
  });

  it("same session+dir → true the first time, false after (the reminder must not repeat on every read)", () => {
    expect(shouldInject("r72-s1", "pkg")).toBe(true);
    expect(shouldInject("r72-s1", "pkg")).toBe(false);
    expect(shouldInject("r72-s1", "pkg")).toBe(false);
  });

  it("a different dir (same session) and a different session (same dir) both inject", () => {
    expect(shouldInject("r72-s2", "pkg")).toBe(true);
    expect(shouldInject("r72-s2", "docs")).toBe(true);
    expect(shouldInject("r72-s3", "pkg")).toBe(true);
  });

  it("no session (bare builds/tests) → ALWAYS true (deterministic, and nothing is recorded)", () => {
    expect(shouldInject(undefined, "pkg")).toBe(true);
    expect(shouldInject(undefined, "pkg")).toBe(true);
    // The sessionless path records nothing — a later SESSION still injects.
    expect(shouldInject("r72-s4", "pkg")).toBe(true);
  });

  it("resetDirConventionInjections() wipes the map (the test seam)", () => {
    expect(shouldInject("r72-s5", "pkg")).toBe(true);
    expect(shouldInject("r72-s5", "pkg")).toBe(false);
    resetDirConventionInjections();
    expect(shouldInject("r72-s5", "pkg")).toBe(true);
  });
});

/* ── D2: read_file through the REAL toolset ───────────────────────────────── */

describe("R72-d D2: read_file appends the convention reminder (through the real toolset)", () => {
  let fixtureRoot = "";
  let db: SqliteDatabase | undefined;
  // A REAL session row (the r71 house pattern: deps carry the session the
  // same way the runtime's prepareTurn does).
  const sessionDeps = {
    db: null as unknown as ToolDeps["db"],
    sessionId: "r72-d2-session",
    agentId: "r72-d2-agent",
  } as ToolDeps;

  const reminderFor = (file: string, dir: string, excerpt: string): string =>
    conventionReminder({ dir, file, excerpt } as DirConvention);

  beforeEach(async () => {
    fixtureRoot = newRoot();
    mkdirSync(join(fixtureRoot, "pkg/src"), { recursive: true });
    mkdirSync(join(fixtureRoot, "docs"), { recursive: true });
    writeFileSync(join(fixtureRoot, "AGENTS.md"), "ROOT POLICY (never a reminder)", "utf8");
    writeFileSync(join(fixtureRoot, "top.ts"), "top = 1;\n", "utf8");
    writeFileSync(join(fixtureRoot, "pkg/AGENTS.md"), "PKG RULES: run pnpm --filter before editing here.\n", "utf8");
    writeFileSync(join(fixtureRoot, "pkg/src/main.ts"), "main = 2;\n", "utf8");
    writeFileSync(join(fixtureRoot, "docs/CLAUDE.md"), "DOCS RULES\n", "utf8");
    writeFileSync(join(fixtureRoot, "docs/readme.md"), "readme\n", "utf8");

    db?.close();
    db = openDatabase(join(tmpdir(), `${randomUUID()}.db`));
    const agent = createAgent(db, { name: "R72 D2 Agent", providerId: "openrouter", model: "test/r72-1" });
    sessionDeps.db = db;
    sessionDeps.sessionId = createSession(db, { agentId: agent.id, mode: "single" }).id;
  });

  afterAll(() => {
    db?.close();
  });

  it("a bare build (no session): the reminder rides AFTER the byte-exact numbered content", async () => {
    const tools = await buildProjectTools(fixtureRoot);
    const result = await tool(tools, "read_file").execute({ path: "pkg/src/main.ts" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe(
      "     1  main = 2;" +
        reminderFor("pkg/AGENTS.md", "pkg", "PKG RULES: run pnpm --filter before editing here.\n"),
    );
  });

  it("session dedup: first read in a (session, dir) carries it; a second file in the SAME dir does not; other dirs/sessions do", async () => {
    writeFileSync(join(fixtureRoot, "pkg/src/other.ts"), "other = 3;\n", "utf8");
    const tools = await buildProjectTools(fixtureRoot, undefined, sessionDeps);
    const read = tool(tools, "read_file");

    const first = await read.execute({ path: "pkg/src/main.ts" });
    expect(first.ok).toBe(true);
    expect(first.output).toContain("[conventions from pkg/AGENTS.md apply to this file]");
    expect(first.output).toContain("PKG RULES: run pnpm --filter before editing here.");
    expect(first.output.startsWith("     1  main = 2;")).toBe(true);

    // Second read, same (session, dir) — clean: the reminder is already in
    // the context; repeating it would be pure token burn.
    const second = await read.execute({ path: "pkg/src/other.ts" });
    expect(second.ok).toBe(true);
    expect(second.output).toBe("     1  other = 3;");

    // Different dir, same session → its own one-time reminder.
    const docs = await read.execute({ path: "docs/readme.md" });
    expect(docs.output).toContain("[conventions from docs/CLAUDE.md apply to this file]");

    // Different session, same dir → injects again (the map is per-session).
    const secondSession = createSession(db!, { agentId: sessionDeps.agentId, mode: "single" }).id;
    const tools2 = await buildProjectTools(fixtureRoot, undefined, {
      ...sessionDeps,
      sessionId: secondSession,
    });
    const again = await tool(tools2, "read_file").execute({ path: "pkg/src/main.ts" });
    expect(again.output).toContain("[conventions from pkg/AGENTS.md apply to this file]");
  });

  it("a ROOT file gets no reminder even with a root AGENTS.md present (readCustomRules owns the root)", async () => {
    const tools = await buildProjectTools(fixtureRoot);
    const result = await tool(tools, "read_file").execute({ path: "top.ts" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("     1  top = 1;");
  });

  it("the RAW readFile (the REST file-viewer route) NEVER carries a reminder — back-compat pin", () => {
    const raw = readFile(fixtureRoot, "pkg/src/main.ts");
    expect(raw.ok).toBe(true);
    expect(raw.output).toBe("main = 2;\n");
  });

  it("a read_file FAILURE gets no reminder (failures stay byte-exact errors)", async () => {
    const tools = await buildProjectTools(fixtureRoot);
    const result = await tool(tools, "read_file").execute({ path: "pkg/src/missing.ts" });
    expect(result.ok).toBe(false);
    expect(result.output).toBe("cannot read 'pkg/src/missing.ts': no such file");
    expect(result.output).not.toContain("conventions from");
  });

  it("the read_file description teaches the reminder honestly (a reminder, not file content)", async () => {
    const tools = await buildProjectTools(fixtureRoot);
    const desc = tool(tools, "read_file").description;
    expect(desc).toContain("[conventions from <dir>/AGENTS.md] reminder");
    expect(desc).toContain("it is a reminder, not file content");
  });
});
