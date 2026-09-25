/**
 * ROUND-52 (R52-f): the FILESYSTEM plugin — list_dir / read_file / write_file
 * / edit_file / create_dir / delete_file, moved VERBATIM from
 * tools/index.ts buildProjectTools (same descriptions, schemas, execute
 * bodies, snapshot recording — the refactor is architectural only).
 * ROUND-98 (R98-F2/F3): the plugin now also carries the SESSION FILE-FRESHNESS
 * LEDGER wiring (tools/file-ledger.ts — read/edit/write record what the model
 * last saw; edit_file warns when the disk moved under it) and the INCREMENTAL
 * symbol-index refresh (storage/index.ts reindexFile after every successful
 * write/edit/delete — the index catches up as the agent works).
 */
import { readFileSync, statSync } from "node:fs";
import { jsonSchema } from "ai";
import {
  createDir,
  deleteFile,
  editFile,
  editFileMulti,
  listDir,
  readFileWindow,
  resolveInsideRoot,
  writeFile,
} from "../fs-ops.js";
// ROUND-71 (R71-e2, D2): the per-session consecutive-failure counter + the
// cline-style escalation tiers for edit_file anchor failures.
import { editFailureSuffix, isEditAnchorFailure, recordEditFailure, resetEditStreak } from "../edit-streak.js";
// ROUND-72 (R72-d): the per-directory AGENTS.md/CLAUDE.md convention
// reminder appended to successful read_file results (kilocode pattern;
// root-level files stay readCustomRules' job — no double-billing).
import { conventionReminder, findDeepestConvention, shouldInject } from "../dir-conventions.js";
// ROUND-98 (R98-F2): the session file-freshness ledger — the owner's
// "it should not be the one to read the whole file again" ask. The same
// import family as edit-streak/dir-conventions: in-process module state,
// never persisted, never a gate.
import {
  ledgerCheckFresh,
  ledgerHasEntry,
  ledgerLastSeenAgeMs,
  ledgerRecordRead,
  ledgerRecordWrite,
  shouldRemindRedundantRead,
} from "../file-ledger.js";
// ROUND-98 (R98-F2): the redundant-read reminder rides the R73-d renderer
// (ONE mechanism for fenced system notes — the "note" kind).
import { renderReminder } from "../../agents/system-reminders.js";
// ROUND-98 (R98-F3): the incremental symbol-index refresh after writes.
import { reindexFile } from "../../storage/index.js";
import { recordSnapshot } from "../../storage/snapshots.js";
// ROUND-96 (R96-C): the atomic batch shape + the uniform result type.
import type { EditOp } from "../fs-ops.js";
import type { PluginDefinition, ToolBuildContext, ToolDefinition, ToolResult } from "../registry.js";

/** ROUND-98 (R98-F2) → ROUND-127 (R127-W6): the redundant-read reminder —
 * ONE bounded note when the model re-reads a file it already read/wrote
 * THIS session. R98 fired it ONLY for files over the 48KB whole-file
 * budget; the owner's live complaint ("the context of our agent is most
 * definitely not handled well… It should not be needing to reread the
 * files again and again") retired the size threshold — the reminder now
 * fires on ANY re-read (a small file re-read is just as much a wasted
 * round-trip as a large one). Still once per file per session
 * (file-ledger's shouldRemindRedundantRead check-and-mark, the R72-d
 * session-once pattern), and the text is still ONE sentence — the
 * task-hints discipline: a reminder is a hint, not a second prompt. */
function redundantReadReminder(relPath: string): string {
  return renderReminder({
    kind: "note",
    label: `[you already read ${relPath} this session]`,
    text: `you already read ${relPath} this session — it is already in your context from that earlier read/write: anchor edits against what you already have, and re-read only after an edit_file failure tells you the content moved or you have concrete evidence the file changed on disk.`,
  });
}

/** ROUND-98 (R98-F2/F3): post-write bookkeeping shared by write_file and
 * edit_file — (a) the LEDGER entry: the model just AUTHORED the content, so
 * the post-write stat is the truth the next freshness check compares against
 * (this is the owner's exact case — "edit the file you just wrote directly,
 * do not read the whole file again"); (b) the INCREMENTAL symbol-index refresh
 * (reindexFile for the one path — cheap, catches search_symbols up as the
 * agent works). Both wrapped in try/catch: bookkeeping must never break the
 * write it rides on, and its failures are never the tool's failures. */
function afterWriteBookkeeping(
  toolDeps: ToolBuildContext["toolDeps"] | undefined,
  root: string,
  relPath: string,
): void {
  const sessionId = toolDeps?.sessionId;
  if (sessionId === undefined && !(toolDeps?.db && toolDeps.projectId)) return;
  try {
    const resolved = resolveInsideRoot(root, relPath);
    if ("error" in resolved) return;
    if (sessionId !== undefined) {
      const stats = statSync(resolved.abs);
      ledgerRecordWrite(sessionId, resolved.abs, { mtimeMs: stats.mtimeMs, size: stats.size });
    }
    if (toolDeps?.db && toolDeps.projectId) {
      reindexFile(toolDeps.db, toolDeps.projectId, root, relPath);
    }
  } catch {
    /* bookkeeping, never a gate */
  }
}

export const filesystemPlugin: PluginDefinition = {
  id: "core-filesystem",
  name: "Filesystem",
  version: "1.0.0",
  description: "Project-root-contained file operations (list/read/write/edit/create/delete).",
  category: "filesystem",
  createTools: (ctx): ToolDefinition[] => {
    const root = ctx.root;
    const toolDeps = ctx.toolDeps;
    return [
      {
        name: "list_dir",
        description:
          "List the entries of a folder inside the project. Use '' for the project root. Always list before writing to discover structure.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "Folder path relative to the project root ('' = root)" },
          },
          required: [],
        }),
        execute: async (input) => listDir(root, typeof input.path === "string" ? input.path : ""),
      },
      {
        name: "read_file",
        // ROUND-70 (R70-a): line-numbered output (SWE-agent ACI / Claude Code
        // Read parity) + offset/limit pagination for large files. The content
        // after each line-number prefix is byte-exact — the model strips the
        // prefix when building edit_file anchors.
        // ROUND-96 (R96-C): the description teaches WHOLE-FILE-FIRST — the
        // owner's bug class was a modest HTML file read in needless parts
        // ("it could have read the whole HTML file in a single go but it
        // split the HTML file into multiple parts"). The old copy taught
        // paging ("page through with offset… instead of re-reading the whole
        // file") — exactly backwards.
        // ROUND-127 (R127-W6): the budget is 48KB → ~128KB (the owner's live
        // complaint: a 554-line / ~10K-token file was read in THREE parts),
        // and the language is STRONGER: the default single call returns the
        // whole file for anything under ~128KB — do NOT page with offset/limit
        // unless a previous call's truncation marker told you to continue; a
        // few-hundred-line file ALWAYS reads whole in one call.
        description:
          "Reads a text file with line numbers (cat -n style: right-aligned line number + two spaces + content). Path is relative to the project root. The default single call (no offset/limit) returns the WHOLE file in one call for anything under ~128KB (~32K tokens) — a few-hundred-line source file ALWAYS reads whole in one call, so do NOT page with offset/limit and do NOT pre-split the read unless a previous call's truncation marker told you to continue. Only genuinely large files page: the result then ends with a truncation marker carrying the file's total line count and the EXACT next call ('use offset=N to continue') — page from there, don't guess. Read BEFORE editing so you know the exact current text, and cite locations as path:line. For targeted re-reads of a known region use offset (1-based start line) and limit (number of lines). The line-number prefix is NOT part of the file — when building edit_file anchors, copy ONLY the content after the prefix. read_file may append a [conventions from <dir>/AGENTS.md] reminder when a deeper directory carries its own AGENTS.md/CLAUDE.md — it is a reminder, not file content.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the project root" },
            offset: { type: "integer", description: "1-based line number to start reading from (default 1 — omit for the whole-file read)" },
            limit: { type: "integer", description: "Number of lines to return (default: whole file within the size cap)" },
          },
          required: ["path"],
        }),
        execute: async (input) => {
          const relPath = typeof input.path === "string" ? input.path : "";
          const result = readFileWindow(root, relPath, {
            offset: typeof input.offset === "number" ? input.offset : undefined,
            limit: typeof input.limit === "number" ? input.limit : undefined,
          });
          // ROUND-98 (R98-F2): every successful read records the LEDGER entry
          // (the model now knows the file as of this stat — the next edit_file
          // freshness check compares against it). Bare builds (no toolDeps)
          // record nothing. The stat itself is bookkeeping: an unreadable
          // stat never breaks the read it rides on.
          let ledgerSuffix = "";
          const sessionId = toolDeps?.sessionId;
          if (result.ok && sessionId !== undefined) {
            try {
              const resolved = resolveInsideRoot(root, relPath);
              if (!("error" in resolved)) {
                const stats = statSync(resolved.abs);
                const alreadySaw = ledgerHasEntry(sessionId, resolved.abs);
                ledgerRecordRead(sessionId, resolved.abs, {
                  mtimeMs: stats.mtimeMs,
                  size: stats.size,
                });
                // The bounded redundant-read reminder: ANY re-read of a
                // file the session already saw — R127-W6 retired R98's
                // over-the-48KB-budget size gate (the owner: "It should
                // not be needing to reread the files again and again" —
                // the wasted round-trip is the problem, not the byte
                // count). Once per file per session, via the check-and-mark.
                if (alreadySaw && shouldRemindRedundantRead(sessionId, resolved.abs)) {
                  ledgerSuffix = redundantReadReminder(relPath);
                }
              }
            } catch {
              /* the ledger is bookkeeping, never a gate */
            }
          }
          // ROUND-72 (R72-d): per-directory conventions (the kilocode
          // AGENTS.md pattern). ONLY a successful read carries a reminder —
          // failures stay byte-exact errors. The reminder quotes the deepest
          // AGENTS.md/CLAUDE.md STRICTLY below the root (root files are
          // readCustomRules' job — no double-billing), once per
          // (session, dir) via the module map; sessionless builds (no
          // toolDeps) inject deterministically every time. A null convention
          // (none found / unreadable) leaves the output untouched — a
          // reminder must never gate the read it rides on.
          if (result.ok) {
            const convention = findDeepestConvention(root, relPath);
            if (convention !== null && shouldInject(toolDeps?.sessionId, convention.dir)) {
              return { ok: true, output: `${result.output}${conventionReminder(convention)}${ledgerSuffix}` };
            }
            if (ledgerSuffix !== "") {
              return { ok: true, output: `${result.output}${ledgerSuffix}` };
            }
          }
          return result;
        },
      },
      {
        name: "write_file",
        description:
          "Create a new file OR completely overwrite an existing one with the given full content. For small changes to existing files prefer edit_file.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the project root" },
            content: { type: "string", description: "The complete file content to write" },
          },
          required: ["path", "content"],
        }),
        execute: async (input) => {
          const relPath = typeof input.path === "string" ? input.path : "";
          const newContent = typeof input.content === "string" ? input.content : "";
          // Record the "before" state for checkpoint/revert
          let beforeContent: string | null = null;
          try {
            const resolved = resolveInsideRoot(root, relPath);
            if (!("error" in resolved)) {
              beforeContent = readFileSync(resolved.abs, "utf8");
            }
          } catch { /* new file — before = null */ }
          const result = writeFile(root, relPath, newContent);
          if (result.ok && toolDeps) {
            recordSnapshot(toolDeps.db, {
              sessionId: toolDeps.sessionId,
              seq: toolDeps.seq ?? 0,
              path: relPath,
              beforeContent,
              afterContent: newContent,
              toolName: "write_file",
            });
          }
          // ROUND-98 (R98-F2/F3): the ledger entry (the model authored the
          // content — its view is current) + the incremental index refresh.
          if (result.ok) {
            afterWriteBookkeeping(toolDeps, root, relPath);
          }
          return result;
        },
      },
      {
        name: "edit_file",
        // ROUND-96 (R96-C): multi-edit + variant rungs. The owner: "It should
        // be easily able to target the changes it needs to make in the
        // files… It will try its variants." The contract (research §2.2 +
        // §6.2, decision rows 4/5): exact-first doctrine, ONE fallback rung
        // (whitespace-normalized), atomic batches, replaceAll, compact
        // confirmation with no diff body (the UI renders diffs from the
        // recorded snapshots).
        description:
          "Edit an existing file by exact string replacement. Read the file first (needed before the FIRST edit of a file this session; after a successful edit or write of the SAME file your anchors are current — edit again directly without re-reading) and copy oldString EXACTLY from the current content — one whitespace character of difference misses. Include enough surrounding lines to make oldString match EXACTLY ONCE, or set replaceAll: true to replace every occurrence (the result reports the count). Exactly ONE fallback rung exists: when the exact anchor is absent, whitespace-normalized matching is tried once (runs of whitespace compared as a single space) and the result says so — anything else fails honestly; a not-found failure names the recovery (re-read JUST the region — read_file with offset/limit around where you expected it, or the whole file, which returns whole in one call under ~128KB — then re-anchor on CURRENT content) and echoes the first line of the anchor you tried to match. For several changes to one file pass edits: [{oldString, newString}, …] (max 32, optionally with replaceAll per item): every anchor is validated IN ORDER against the evolving content and applied in ONE atomic write — any failure names the failing index and leaves the file UNTOUCHED. Prefer edit_file over write_file for changing existing files.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the project root" },
            oldString: { type: "string", description: "Exact existing text to replace (single-edit form — mutually exclusive with edits)" },
            newString: { type: "string", description: "Replacement text (single-edit form)" },
            replaceAll: { type: "boolean", description: "Replace EVERY occurrence of oldString (default false = must match exactly once); the result reports the count" },
            edits: {
              type: "array",
              description: "Atomic batch: [{oldString, newString, replaceAll?}, …] (max 32), applied in order in ONE write — all anchors must match or nothing is written",
              items: {
                type: "object",
                properties: {
                  oldString: { type: "string", description: "Exact existing text to replace" },
                  newString: { type: "string", description: "Replacement text" },
                  replaceAll: { type: "boolean", description: "Replace every occurrence of this oldString (default false)" },
                },
                required: ["oldString", "newString"],
              },
            },
          },
          required: ["path"],
        }),
        execute: async (input) => {
          const relPath = typeof input.path === "string" ? input.path : "";
          // Record the "before" state BEFORE the edit runs (the snapshot
          // story keys on whole-file states — R96-C batches also land as ONE
          // before/after pair).
          let beforeContent: string | null = null;
          try {
            const resolved = resolveInsideRoot(root, relPath);
            if (!("error" in resolved)) beforeContent = readFileSync(resolved.abs, "utf8");
          } catch { /* file doesn't exist — edit will fail anyway */ }
          // ROUND-98 (R98-F2): the STALENESS CHECK — stat the file BEFORE
          // applying and ask the session ledger whether the disk still
          // matches what the model last read/wrote. "stale" (the user or
          // another process changed it) PREPENDS an honest one-line warning
          // to a SUCCESSFUL edit (the anchor engine is the real guard — the
          // edit still attempts) and STRENGTHENS an anchor FAILURE with the
          // ledger's evidence (the miss was probably not the model's fault).
          // "unknown" (no entry — first edit this session) and "fresh" stay
          // silent: silence is the owner's token-optimization ask.
          let staleAgeMs: number | null = null;
          const ledgerSession = toolDeps?.sessionId;
          if (ledgerSession !== undefined) {
            try {
              const resolved = resolveInsideRoot(root, relPath);
              if (!("error" in resolved)) {
                const stats = statSync(resolved.abs);
                if (
                  ledgerCheckFresh(ledgerSession, resolved.abs, {
                    mtimeMs: stats.mtimeMs,
                    size: stats.size,
                  }) === "stale"
                ) {
                  staleAgeMs = ledgerLastSeenAgeMs(ledgerSession, resolved.abs);
                }
              }
            } catch {
              /* unreadable stat = unknown freshness — the anchor engine is the real guard */
            }
          }
          // ROUND-96 (R96-C): dispatch between the single-edit shorthand and
          // the atomic edits[] batch (mutually exclusive — an ambiguous call
          // is an honest error, never a guess).
          const hasEdits = Array.isArray(input.edits);
          const hasSingle = typeof input.oldString === "string" || typeof input.newString === "string";
          let result: ToolResult;
          if (hasEdits && hasSingle) {
            result = {
              ok: false,
              output: `cannot edit '${relPath}': pass EITHER oldString/newString (single edit) OR edits (batch) — not both`,
            };
          } else if (hasEdits) {
            const edits = (input.edits as unknown[]).map((raw) => {
              const op = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
              return {
                oldString: op.oldString,
                newString: op.newString,
                ...(op.replaceAll === true ? { replaceAll: true } : {}),
              };
            });
            result = editFileMulti(root, relPath, edits as EditOp[]);
          } else if (hasSingle) {
            if (typeof input.oldString !== "string" || typeof input.newString !== "string") {
              result = {
                ok: false,
                output: `cannot edit '${relPath}': the single-edit form needs BOTH oldString and newString as strings`,
              };
            } else {
              result = editFile(root, relPath, input.oldString, input.newString, {
                replaceAll: input.replaceAll === true,
              });
            }
          } else {
            result = {
              ok: false,
              output: `cannot edit '${relPath}': missing oldString/newString (single edit) or edits (batch)`,
            };
          }
          // ROUND-98 (R98-F2): the ledger's honest narration of a stale-file
          // edit. SUCCESS → the warning rides FIRST (one line, prepended —
          // the model should re-read if the result looks wrong); anchor
          // FAILURE → the error names the likeliest cause with the ledger's
          // evidence (the disk moved after the model's last look — "re-read"
          // is then the FIRST remedy, not the R71 streak's escalation).
          // Non-anchor failures (shape errors, missing file) stay untouched —
          // staleness is not their story.
          if (staleAgeMs !== null) {
            const age = Math.max(staleAgeMs, 0);
            if (result.ok) {
              result = {
                ok: true,
                output:
                  `[warning: the file changed on disk since you last read it (${age} ms ago) — ` +
                  `the anchor may not match; re-read if the edit fails]\n${result.output}`,
              };
            } else if (isEditAnchorFailure(result)) {
              result = {
                ok: false,
                output:
                  `${result.output} — the file changed on disk since you last read it (${age} ms ago): ` +
                  `re-read it with read_file and re-anchor on the CURRENT content`,
              };
            }
          }
          // ROUND-98 (R98-F2/F3): the post-write ledger entry (the model
          // authored the new content — its view is current, edit again
          // directly) + the incremental symbol-index refresh.
          if (result.ok) {
            afterWriteBookkeeping(toolDeps, root, relPath);
          }
          // ROUND-71 (R71-e2, D2): per-session consecutive edit-failure
          // escalation (cline's progressive-failure pattern). A SUCCESS
          // resets the streak (the file view is proven current again); an
          // ANCHOR failure increments it and the existing honest error text
          // gains the tier suffix (2nd: re-read + copy exactly; 3rd/4th:
          // change approach; 5th+: refuse the pattern). Keyed by the turn's
          // session — bare builds (no toolDeps, e.g. tests) never escalate.
          const streakSession = toolDeps?.sessionId;
          if (streakSession !== undefined) {
            if (result.ok) {
              resetEditStreak(streakSession);
            } else if (isEditAnchorFailure(result)) {
              const suffix = editFailureSuffix(recordEditFailure(streakSession));
              if (suffix !== "") {
                return { ok: false, output: `${result.output}${suffix}` };
              }
            }
          }
          if (result.ok && toolDeps && beforeContent !== null) {
            let afterContent: string | null = null;
            try {
              const resolved = resolveInsideRoot(root, relPath);
              if (!("error" in resolved)) afterContent = readFileSync(resolved.abs, "utf8");
            } catch { /* */ }
            recordSnapshot(toolDeps.db, {
              sessionId: toolDeps.sessionId,
              seq: toolDeps.seq ?? 0,
              path: relPath,
              beforeContent,
              afterContent,
              toolName: "edit_file",
            });
          }
          return result;
        },
      },
      {
        name: "create_dir",
        description:
          "Create a folder inside the project (parents created as needed). Use before writing files into a new subfolder.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "Folder path relative to the project root" },
          },
          required: ["path"],
        }),
        execute: async (input) => createDir(root, typeof input.path === "string" ? input.path : ""),
      },
      {
        name: "delete_file",
        description:
          "Delete ONE file inside the project. Directories cannot be deleted with this tool (needs owner approval). Always confirm the user really asked for the deletion before calling.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the project root" },
          },
          required: ["path"],
        }),
        execute: async (input) => {
          const relPath = typeof input.path === "string" ? input.path : "";
          let beforeContent: string | null = null;
          try {
            const resolved = resolveInsideRoot(root, relPath);
            if (!("error" in resolved)) beforeContent = readFileSync(resolved.abs, "utf8");
          } catch { /* */ }
          const result = deleteFile(root, relPath);
          if (result.ok && toolDeps) {
            recordSnapshot(toolDeps.db, {
              sessionId: toolDeps.sessionId,
              seq: toolDeps.seq ?? 0,
              path: relPath,
              beforeContent,
              afterContent: null,
              toolName: "delete_file",
            });
          }
          // ROUND-98 (R98-F3): a deleted file's index rows are cleared —
          // reindexFile's delete-then-read on a missing path is exactly the
          // honest empty result (search_symbols must never return a dead
          // path). Bookkeeping, never a gate.
          if (result.ok && toolDeps?.db && toolDeps.projectId) {
            try {
              reindexFile(toolDeps.db, toolDeps.projectId, root, relPath);
            } catch {
              /* bookkeeping, never a gate */
            }
          }
          return result;
        },
      },
    ];
  },
};
