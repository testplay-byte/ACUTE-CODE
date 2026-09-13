/**
 * ROUND-52 (R52-f): the FILESYSTEM plugin — list_dir / read_file / write_file
 * / edit_file / create_dir / delete_file, moved VERBATIM from
 * tools/index.ts buildProjectTools (same descriptions, schemas, execute
 * bodies, snapshot recording — the refactor is architectural only).
 */
import { readFileSync } from "node:fs";
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
import { recordSnapshot } from "../../storage/snapshots.js";
// ROUND-96 (R96-C): the atomic batch shape + the uniform result type.
import type { EditOp } from "../fs-ops.js";
import type { PluginDefinition, ToolDefinition, ToolResult } from "../registry.js";

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
        // ROUND-96 (R96-C): the description now teaches WHOLE-FILE-FIRST —
        // the owner's bug class was a modest HTML file read in needless
        // parts ("it could have read the whole HTML file in a single go but
        // it split the HTML file into multiple parts"). The old copy taught
        // paging ("page through with offset… instead of re-reading the whole
        // file") — exactly backwards. Files under ~48KB return WHOLE in one
        // call; only genuinely large files page, and the truncation marker
        // then carries the exact continuation.
        description:
          "Reads a text file with line numbers (cat -n style: right-aligned line number + two spaces + content). Path is relative to the project root. Files under ~48KB return the WHOLE file in one call — prefer that; do NOT page small files or read them in parts. Only genuinely large files page: the result then ends with a truncation marker carrying the file's total line count and the EXACT next call ('use offset=N to continue') — page from there, don't guess. Read BEFORE editing so you know the exact current text, and cite locations as path:line. For targeted re-reads of a known region use offset (1-based start line) and limit (number of lines). The line-number prefix is NOT part of the file — when building edit_file anchors, copy ONLY the content after the prefix. read_file may append a [conventions from <dir>/AGENTS.md] reminder when a deeper directory carries its own AGENTS.md/CLAUDE.md — it is a reminder, not file content.",
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
              return { ok: true, output: `${result.output}${conventionReminder(convention)}` };
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
          "Edit an existing file by exact string replacement. Read the file first and copy oldString EXACTLY from the current content — one whitespace character of difference misses. Include enough surrounding lines to make oldString match EXACTLY ONCE, or set replaceAll: true to replace every occurrence (the result reports the count). Exactly ONE fallback rung exists: when the exact anchor is absent, whitespace-normalized matching is tried once (runs of whitespace compared as a single space) and the result says so — anything else fails honestly; on failure re-read the file and re-anchor on CURRENT content. For several changes to one file pass edits: [{oldString, newString}, …] (max 32, optionally with replaceAll per item): every anchor is validated IN ORDER against the evolving content and applied in ONE atomic write — any failure names the failing index and leaves the file UNTOUCHED. Prefer edit_file over write_file for changing existing files.",
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
          return result;
        },
      },
    ];
  },
};
