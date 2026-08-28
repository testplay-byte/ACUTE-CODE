/**
 * Memory tools (ROUND-44, R44-a — owner directive "complete the agentic
 * coding environment"). Agents forgot everything between turns/sessions;
 * these tools give the model a persistent, per-project knowledge base:
 *
 *   - memory_save:   persist a durable fact/decision/preference/note.
 *   - memory_recall: search the memories (or list the newest 12).
 *   - memory_list:   newest-first listing (browsable, capped).
 *
 * Memories are PROJECT-scoped. The project id resolution mirrors
 * index_project: prefer ToolDeps.projectId (the runtime always passes it
 * for project sessions), and fall back to the sessions-table lookup by
 * sessionId so older/alternative call sites keep working. When neither
 * resolves (a non-project chat), every tool fails gracefully with ok:false
 * — memory simply does not apply there.
 *
 * The newest memories are ALSO auto-injected into the system prompt via
 * memoryDigest (agents/prompts.ts) — the tools are for saving and for
 * digging deeper than the digest's cap.
 */
import type Database from "better-sqlite3";
import { getSession } from "../storage/sessions.js";
import {
  MAX_MEMORY_CONTENT_CHARS,
  listMemories,
  saveMemoryWithDedup,
  searchMemories,
  type MemoryItem,
} from "../storage/memory.js";

export interface MemoryToolResult {
  ok: boolean;
  output: string;
}

/** The deps the memory tools need (a structural subset of tools' ToolDeps —
 * kept local, like todo.ts's TodoDeps, to avoid a circular import). */
export interface MemoryToolDeps {
  db: Database.Database;
  sessionId: string;
  projectId?: string;
}

/** Resolve the project id for a tool call: explicit deps first, then the
 * session row. Returns null when the session carries no project (memory is
 * per-project; without one there is nothing to save to or recall from). */
function resolveProjectId(deps: MemoryToolDeps): string | null {
  if (deps.projectId !== undefined && deps.projectId !== null && deps.projectId !== "") {
    return deps.projectId;
  }
  return getSession(deps.db, deps.sessionId)?.projectId ?? null;
}

/** One compact line per memory ("[kind] content (source, YYYY-MM-DD)"). */
function formatMemory(m: MemoryItem): string {
  const day = m.updatedAt.slice(0, 10);
  return `• [${m.kind}] ${m.content} (${day})`;
}

/**
 * memory_save — persist a durable memory. Content is trimmed and capped at
 * MAX_MEMORY_CONTENT_CHARS; kind must be fact | decision | preference |
 * note (default note). Storage validation errors surface as ok:false with
 * the actionable message (never a raw SQLite exception).
 */
export function memorySaveTool(
  deps: MemoryToolDeps | undefined,
  content: unknown,
  kind: unknown,
): MemoryToolResult {
  if (!deps) return { ok: false, output: "memory unavailable in this context" };
  const projectId = resolveProjectId(deps);
  if (projectId === null) {
    return {
      ok: false,
      output: "memory is project-scoped and this session has no bound project",
    };
  }
  const text = typeof content === "string" ? content : "";
  if (text.trim() === "") {
    return { ok: false, output: "memory_save needs non-empty 'content'" };
  }
  if (text.trim().length > MAX_MEMORY_CONTENT_CHARS) {
    return {
      ok: false,
      output: `memory_save content too long (${text.trim().length} chars, max ${MAX_MEMORY_CONTENT_CHARS}) — split it into multiple memories`,
    };
  }
  try {
    // ROUND-46 v2: duplicate content refreshes the existing row instead of
    // inserting a twin — the tool says so honestly.
    const { item: saved, deduplicated } = saveMemoryWithDedup(deps.db, {
      projectId,
      kind: typeof kind === "string" ? kind : undefined,
      content: text,
      source: "agent",
    });
    return {
      ok: true,
      output: deduplicated
        ? `memory already existed — refreshed it (${saved.kind}, id ${saved.id}); it persists across sessions and is auto-loaded into future turns`
        : `saved ${saved.kind} memory (id ${saved.id}); it persists across sessions and is auto-loaded into future turns`,
    };
  } catch (error) {
    return {
      ok: false,
      output: `memory_save failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

/**
 * memory_recall — ROUND-46 v2: relevance-ranked search (token overlap +
 * kind boost + recency; the storage layer scores). Without a query, returns
 * the newest 12 (the same window the system-prompt digest covers, in full
 * detail).
 */
export function memoryRecallTool(
  deps: MemoryToolDeps | undefined,
  query: unknown,
): MemoryToolResult {
  if (!deps) return { ok: false, output: "memory unavailable in this context" };
  const projectId = resolveProjectId(deps);
  if (projectId === null) {
    return {
      ok: false,
      output: "memory is project-scoped and this session has no bound project",
    };
  }
  const q = typeof query === "string" ? query.trim() : "";
  const items = q === "" ? listMemories(deps.db, projectId, 12) : searchMemories(deps.db, projectId, q, 12);
  if (items.length === 0) {
    return q === ""
      ? { ok: true, output: "no memories saved for this project yet" }
      : { ok: true, output: `no memories match '${q}'` };
  }
  const header =
    q === "" ? `newest ${items.length} memor${items.length === 1 ? "y" : "ies"}:` : `${items.length} memor${items.length === 1 ? "y" : "ies"} matching '${q}':`;
  return { ok: true, output: `${header}\n${items.map(formatMemory).join("\n")}` };
}

/** memory_list — newest-first listing, limit capped at 50. */
export function memoryListTool(
  deps: MemoryToolDeps | undefined,
  limit: unknown,
): MemoryToolResult {
  if (!deps) return { ok: false, output: "memory unavailable in this context" };
  const projectId = resolveProjectId(deps);
  if (projectId === null) {
    return {
      ok: false,
      output: "memory is project-scoped and this session has no bound project",
    };
  }
  const requested =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.min(50, Math.floor(limit))
      : 20;
  const items = listMemories(deps.db, projectId, requested);
  if (items.length === 0) {
    return { ok: true, output: "no memories saved for this project yet" };
  }
  return {
    ok: true,
    output: `${items.length} memor${items.length === 1 ? "y" : "ies"} (newest first):\n${items.map(formatMemory).join("\n")}`,
  };
}
