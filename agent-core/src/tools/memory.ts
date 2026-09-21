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
 *
 * ROUND-117 (R117-b): session_recall — the EPISODIC leg. Past sessions are
 * searchable in the UI only (ROUND-44-c searchSessions); this tool exposes
 * the same search to the MODEL, so "what did we do about X last week" is a
 * tool call instead of a blank stare. Same project gate as the memory_*
 * family: episodic recall searches THIS project's past sessions; a
 * projectless session gets the honest refusal (the CLI's projectless
 * world included — the R117-b CLI binding closes most of that gap).
 */
import type Database from "better-sqlite3";
import { getSession, searchSessions } from "../storage/sessions.js";
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

/* ── ROUND-117 (R117-b): session_recall — the episodic search ────────────── */

/** Cap on one session snippet (chars) — a taste of the match, not the
 * transcript; the session id + title carry the pointer. */
const SESSION_SNIPPET_CHARS = 200;

/** Cap on returned sessions (the tool's `limit`, default 5). */
const MAX_SESSION_RECALL_RESULTS = 10;

/**
 * A ~200-char snippet for one matched session: the first event payload that
 * contains the needle (case-insensitive), windowed around the match with
 * run whitespace collapsed; when only the TITLE matched, the title is the
 * snippet. ONE bounded indexed probe per result session (payload LIKE with
 * escaped wildcards — the searchSessions grammar).
 */
function sessionSnippet(
  db: MemoryToolDeps["db"],
  sessionId: string,
  title: string,
  needle: string,
): string {
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;
  const row = db
    .prepare(
      `SELECT payload FROM session_events
        WHERE session_id = ? AND payload LIKE ? ESCAPE '\\'
        ORDER BY seq LIMIT 1`,
    )
    .get(sessionId, pattern) as { payload: string } | undefined;
  const source = row?.payload ?? title;
  const at = source.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return source.slice(0, SESSION_SNIPPET_CHARS);
  const start = Math.max(0, at - Math.floor(SESSION_SNIPPET_CHARS / 3));
  const raw = source.slice(start, start + SESSION_SNIPPET_CHARS);
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${collapsed}${start + SESSION_SNIPPET_CHARS < source.length ? "…" : ""}`;
}

/**
 * session_recall — model-facing search over PAST SESSIONS of this project
 * (titles + event payloads, the ROUND-44-c searchSessions grammar; the
 * CURRENT session is excluded — it is not "past"). Each hit renders
 * `id · "title" · last activity YYYY-MM-DD · "…200-char snippet…"`.
 * Bounded: limit defaults to 5, caps at 10 (a research pointer, not a
 * transcript dump). Projectless sessions get the honest no-project refusal
 * — the same gate as the memory_* family.
 */
export function sessionRecallTool(
  deps: MemoryToolDeps | undefined,
  query: unknown,
  limit: unknown,
): MemoryToolResult {
  if (!deps) return { ok: false, output: "memory unavailable in this context" };
  const projectId = resolveProjectId(deps);
  if (projectId === null) {
    return {
      ok: false,
      output: "episodic recall is project-scoped and this session has no bound project",
    };
  }
  const q = typeof query === "string" ? query.trim() : "";
  if (q === "") {
    return { ok: false, output: "session_recall needs a non-empty 'query' (a topic, file name, or error text to find in past sessions)" };
  }
  const requested =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.min(MAX_SESSION_RECALL_RESULTS, Math.floor(limit))
      : 5;
  // Project-scoped + current-session-excluded in SQL (searchSessions' R117-b
  // opts) — the window the model sees is exactly this project's past work.
  const hits = searchSessions(deps.db, q, requested, {
    excludeSessionId: deps.sessionId,
    projectId,
  });
  if (hits.length === 0) {
    return { ok: true, output: `no past sessions in this project match '${q}'` };
  }
  const lines = hits.map((s) => {
    const day = s.updatedAt.slice(0, 10);
    const title = s.title ?? "(untitled)";
    return `- ${s.id} · "${title}" · last activity ${day} · "${sessionSnippet(deps.db, s.id, title, q)}"`;
  });
  return {
    ok: true,
    output: `${hits.length} past session${hits.length === 1 ? "" : "s"} in this project matching '${q}' (newest activity first):\n${lines.join("\n")}`,
  };
}
