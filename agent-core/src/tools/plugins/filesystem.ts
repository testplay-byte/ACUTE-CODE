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
  listDir,
  readFileWindow,
  resolveInsideRoot,
  writeFile,
} from "../fs-ops.js";
// ROUND-71 (R71-e2, D2): the per-session consecutive-failure counter + the
// cline-style escalation tiers for edit_file anchor failures.
import { editFailureSuffix, isEditAnchorFailure, recordEditFailure, resetEditStreak } from "../edit-streak.js";
import { recordSnapshot } from "../../storage/snapshots.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

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
        description:
          "Read a text file's content, with line numbers (cat -n style: right-aligned line number + two spaces + content). Path is relative to the project root. Read BEFORE editing so you know the exact current text, and cite locations as path:line. The line-number prefix is NOT part of the file — when building edit_file oldString/newString, copy ONLY the content after the prefix. Large files: page through with offset (1-based start line, default 1) and limit (number of lines) instead of re-reading the whole file. When output is truncated, the marker carries the file's total line count and the EXACT next call — 'use offset=N to continue' — so page from there instead of guessing.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the project root" },
            offset: { type: "integer", description: "1-based line number to start reading from (default 1)" },
            limit: { type: "integer", description: "Number of lines to return (default: whole file within the size cap)" },
          },
          required: ["path"],
        }),
        execute: async (input) =>
          readFileWindow(root, typeof input.path === "string" ? input.path : "", {
            offset: typeof input.offset === "number" ? input.offset : undefined,
            limit: typeof input.limit === "number" ? input.limit : undefined,
          }),
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
        description:
          "Replace ONE exact occurrence of oldString with newString in an existing file. The oldString must match exactly once — include enough surrounding lines to make it unique. If the edit fails, the error tells you why; consecutive failures escalate with concrete recovery steps — follow them (re-read the file, then anchor on CURRENT content).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the project root" },
            oldString: { type: "string", description: "Exact existing text to replace" },
            newString: { type: "string", description: "Replacement text" },
          },
          required: ["path", "oldString", "newString"],
        }),
        execute: async (input) => {
          const relPath = typeof input.path === "string" ? input.path : "";
          // Record the "before" state
          let beforeContent: string | null = null;
          try {
            const resolved = resolveInsideRoot(root, relPath);
            if (!("error" in resolved)) beforeContent = readFileSync(resolved.abs, "utf8");
          } catch { /* file doesn't exist — edit will fail anyway */ }
          const result = editFile(
            root,
            relPath,
            typeof input.oldString === "string" ? input.oldString : "",
            typeof input.newString === "string" ? input.newString : "",
          );
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
