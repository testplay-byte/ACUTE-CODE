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
  readFile,
  resolveInsideRoot,
  writeFile,
} from "../fs-ops.js";
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
        description:
          "Read a text file's content. Path is relative to the project root. Read BEFORE editing so you know the exact current text.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the project root" },
          },
          required: ["path"],
        }),
        execute: async (input) =>
          readFile(root, typeof input.path === "string" ? input.path : ""),
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
          "Replace ONE exact occurrence of oldString with newString in an existing file. The oldString must match exactly once — include enough surrounding lines to make it unique.",
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
