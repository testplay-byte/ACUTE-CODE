import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_CATALOG } from "./api";

/**
 * ROUND-45 (R45-c): TOOL_CATALOG drift guard.
 *
 * The R44 lesson (docs/runbooks/MAINTENANCE.md golden rule 7 + the round-44
 * VLM pass): `TOOL_CATALOG` in src/lib/api.ts lagged the backend's
 * `TOOL_NAMES` in agent-core/src/storage/agents.ts (15 vs 21 tools after
 * R43/R44 added delegation, browser control and memory) — the agent-form
 * checkboxes silently missed every new tool until a human noticed.
 *
 * This test reads the backend source AS TEXT (no cross-package import of
 * agent-core code — that would trip tsc project boundaries) and asserts the
 * two lists stay in lockstep.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS_TS = join(REPO_ROOT, "agent-core", "src", "storage", "agents.ts");
const TOOLS_INDEX_TS = join(REPO_ROOT, "agent-core", "src", "tools", "index.ts");

/**
 * Extract the string literals of a `export const TOOL_NAMES = [...]` array
 * from TypeScript source text. Comments inside the array are ignored (they
 * are stripped before the string scan — tool ids never contain "//").
 */
function extractToolNames(source: string, file: string): string[] {
  const match = source.match(/export const TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!match) {
    throw new Error(`No "export const TOOL_NAMES = [...] as const" found in ${file}`);
  }
  const withoutComments = match[1].replace(/\/\/[^\n]*/g, "");
  const names: string[] = [];
  for (const literal of withoutComments.matchAll(/"([^"]+)"/g)) {
    names.push(literal[1]);
  }
  if (names.length === 0) {
    throw new Error(`TOOL_NAMES in ${file} parsed as empty — extractor regex is stale`);
  }
  return names;
}

function driftMessage(backend: string[], frontend: string[]): string {
  const missingFromFrontend = backend.filter((t) => !frontend.includes(t));
  const missingFromBackend = frontend.filter((t) => !backend.includes(t));
  return [
    "TOOL_CATALOG (src/lib/api.ts) has drifted from TOOL_NAMES (agent-core/src/storage/agents.ts).",
    `  backend TOOL_NAMES (${backend.length}): ${JSON.stringify(backend)}`,
    `  frontend TOOL_CATALOG (${frontend.length}): ${JSON.stringify(frontend)}`,
    missingFromFrontend.length > 0
      ? `  missing from TOOL_CATALOG: ${JSON.stringify(missingFromFrontend)} (agent-form checkboxes won't show these tools)`
      : "",
    missingFromBackend.length > 0
      ? `  missing from TOOL_NAMES: ${JSON.stringify(missingFromBackend)} (seeded agents can never reach these tools — see MAINTENANCE.md golden rule 7)`
      : "",
    "Fix: make both lists identical — TOOL_CATALOG in src/lib/api.ts and TOOL_NAMES in agent-core/src/storage/agents.ts (a new tool needs BOTH plus a migration; see docs/runbooks/MAINTENANCE.md recipe a).",
  ]
    .filter(Boolean)
    .join("\n");
}

describe("TOOL_CATALOG drift guard (ROUND-45 R45-c)", () => {
  it("src/lib/api.ts TOOL_CATALOG matches agent-core storage/agents.ts TOOL_NAMES", () => {
    const backend = extractToolNames(readFileSync(AGENTS_TS, "utf8"), AGENTS_TS).sort();
    const frontend = [...TOOL_CATALOG].sort();
    expect(frontend, driftMessage(backend, frontend)).toEqual(backend);
  });

  it("agent-core tools/index.ts does not declare a second, conflicting TOOL_NAMES", () => {
    // storage/agents.ts is the canonical seed source (checked above). As of
    // R45, tools/index.ts has NO TOOL_NAMES export of its own — if one ever
    // appears there, guard it too rather than letting a third list drift.
    const source = readFileSync(TOOLS_INDEX_TS, "utf8");
    if (/export const TOOL_NAMES/.test(source)) {
      const toolsIndex = extractToolNames(source, TOOLS_INDEX_TS).sort();
      const backend = extractToolNames(readFileSync(AGENTS_TS, "utf8"), AGENTS_TS).sort();
      expect(toolsIndex, driftMessage(backend, toolsIndex)).toEqual(backend);
    }
  });
});
