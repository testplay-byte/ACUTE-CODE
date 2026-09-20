/**
 * attachments.test.ts — the composer's FILE WORLD (R113-c): the staged-chip
 * helpers (server-read staging, the wire-format MessageAttachment, the
 * 20-chip cap + id dedupe), the @-token detector (word-start, mid-word
 * emails, whitespace-closed tokens), the project-tree walk + live filter
 * (the desktop's exact DFS + limit-8), and the typed clients' bodies
 * (POST /attachments/read, POST /attachments/upload, GET
 * /projects/:id/tree, GET /projects/:id/modes) — all against an injected
 * fake sender, zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import type { ApiSender } from "../api";
import {
  MAX_ATTACHMENTS,
  attachmentFromRead,
  detectAtToken,
  fetchProjectModes,
  fetchProjectTree,
  filterProjectFiles,
  flattenTreeFiles,
  formatAttachmentSize,
  readAttachmentFiles,
  stageAttachments,
  stripAtToken,
  toMessageAttachment,
  uploadAttachmentBytes,
  type AttachmentReadResult,
  type ComposerAttachment,
  type TreeNode,
} from "../attachments";

// ── fixtures ────────────────────────────────────────────────────────────────

function makeSender(
  respond: (path: string, init: { method?: string; bodyText?: string }) => {
    status: number;
    bodyText: string;
  },
) {
  const calls: Array<{ path: string; init: { method?: string; bodyText?: string } }> = [];
  const sender: ApiSender = {
    async api(path, init = {}) {
      calls.push({ path, init });
      const response = respond(path, init);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        headers: {},
        bodyText: response.bodyText,
      };
    },
  };
  return { sender, calls };
}

function readResult(overrides: Partial<AttachmentReadResult> = {}): AttachmentReadResult {
  return {
    path: "src/main.ts",
    name: "main.ts",
    size: 512,
    text: "export {}",
    truncated: false,
    ...overrides,
  };
}

// ── the staged chips ────────────────────────────────────────────────────────

describe("attachments — the staged chips", () => {
  it("stages a server-read file; error entries are NOT chips (the caller surfaces them)", () => {
    const chip = attachmentFromRead(readResult(), "project");
    expect(chip).toEqual({
      id: "src/main.ts",
      name: "main.ts",
      path: "src/main.ts",
      size: 512,
      text: "export {}",
      truncated: false,
      source: "project",
    });
    const failed = attachmentFromRead(readResult({ error: "cannot read 'x': no such file" }), "project");
    expect(failed).toBeNull();
  });

  it("toMessageAttachment omits absent fields and drops a null text (the wire's MessageAttachment)", () => {
    expect(
      toMessageAttachment({
        id: "a",
        name: "photo.png",
        size: 2048,
        text: null,
        truncated: false,
        source: "picker",
        dataBase64: "AAAA",
      }),
    ).toEqual({ name: "photo.png", size: 2048 });
    expect(
      toMessageAttachment({
        id: "b",
        name: "notes.txt",
        path: "notes.txt",
        size: 10,
        text: "hello",
        truncated: true,
        source: "project",
      }),
    ).toEqual({ name: "notes.txt", path: "notes.txt", size: 10, text: "hello" });
    // dataBase64 NEVER rides the message (bytes go to the upload route only)
    const wire = toMessageAttachment({
      id: "c",
      name: "shot.png",
      size: 9,
      text: null,
      truncated: false,
      source: "picker",
      dataBase64: "QUJD",
    });
    expect(JSON.parse(JSON.stringify(wire))).not.toHaveProperty("dataBase64");
    expect(JSON.parse(JSON.stringify(wire))).not.toHaveProperty("path");
  });

  it("stageAttachments dedupes by id and caps at the backend's 20", () => {
    const chip = (id: string): ComposerAttachment => ({
      id,
      name: id,
      size: 1,
      text: null,
      truncated: false,
      source: "project",
    });
    expect(stageAttachments([], [chip("a"), chip("a")])).toHaveLength(1);
    expect(stageAttachments([chip("a")], [chip("a"), chip("b")])).toHaveLength(2);
    const full = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => chip(`f${i}`));
    expect(stageAttachments(full, [chip("one-more")])).toHaveLength(MAX_ATTACHMENTS);
  });

  it("formats sizes the chip's way", () => {
    expect(formatAttachmentSize(0)).toBe("0 B");
    expect(formatAttachmentSize(7)).toBe("7 B");
    expect(formatAttachmentSize(812)).toBe("812 B");
    expect(formatAttachmentSize(1_100)).toBe("1 KB"); // round(1.07) = 1
    expect(formatAttachmentSize(1_536)).toBe("2 KB"); // round(1.5) = 2
    expect(formatAttachmentSize(812_544)).toBe("794 KB");
    expect(formatAttachmentSize(2_411_520)).toBe("2.3 MB");
  });
});

// ── the @ token ─────────────────────────────────────────────────────────────

describe("attachments — the @ token (the desktop's detectAtToken)", () => {
  it("detects a word-start token with its live query", () => {
    expect(detectAtToken("look at @src/ma", 15)).toEqual({ at: 8, end: 15, query: "src/ma" });
    expect(detectAtToken("@", 1)).toEqual({ at: 0, end: 1, query: "" });
  });

  it("rejects mid-word @ (emails) and whitespace-closed tokens", () => {
    expect(detectAtToken("mail me a@b.com", 15)).toBeNull();
    expect(detectAtToken("see @todo now", 13)).toBeNull(); // token closed by the space
  });

  it("rejects out-of-range carets", () => {
    expect(detectAtToken("@hi", 99)).toBeNull();
    expect(detectAtToken("@hi", -1)).toBeNull();
  });

  it("strips the picked token from the input", () => {
    expect(stripAtToken("look at @src/ma", { at: 8, end: 15, query: "src/ma" })).toBe("look at ");
  });
});

// ── the project tree ────────────────────────────────────────────────────────

describe("attachments — the project tree walk + the live filter", () => {
  const tree: TreeNode[] = [
    {
      type: "dir",
      path: "src",
      name: "src",
      children: [
        { type: "file", path: "src/a.ts", name: "a.ts" },
        { type: "file", path: "src/b.ts", name: "b.ts" },
      ],
    },
    { type: "file", path: "README.md", name: "README.md" },
  ];

  it("flattenTreeFiles walks DFS, folders skipped (the desktop's exact walk)", () => {
    expect(flattenTreeFiles(tree)).toEqual(["src/a.ts", "src/b.ts", "README.md"]);
  });

  it("filterProjectFiles: substring, case-insensitive, capped at 8", () => {
    const files = ["src/a.ts", "src/b.ts", "lib/a.js", "README.md"];
    expect(filterProjectFiles(files, "A.")).toEqual(["src/a.ts", "lib/a.js"]);
    expect(filterProjectFiles(files, "readme")).toEqual(["README.md"]);
    expect(filterProjectFiles(files, "")).toEqual(files); // the empty query shows the head
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    expect(filterProjectFiles(many, "f")).toHaveLength(8);
    expect(filterProjectFiles(many, "f", 3)).toHaveLength(3);
  });
});

// ── the typed clients (the wire shapes, 1:1) ────────────────────────────────

describe("attachments — the typed clients", () => {
  it("POST /attachments/read with {paths, projectId}", async () => {
    const { sender, calls } = makeSender(() => ({
      status: 200,
      bodyText: JSON.stringify({ files: [readResult()] }),
    }));
    const outcome = await readAttachmentFiles(sender, ["src/main.ts"], "proj_1");
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.path).toBe("/api/v1/attachments/read");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init.bodyText ?? "")).toEqual({
      paths: ["src/main.ts"],
      projectId: "proj_1",
    });
  });

  it("POST /attachments/upload with {projectId, name, dataBase64} (the R67-A ingestion)", async () => {
    const { sender, calls } = makeSender(() => ({
      status: 200,
      bodyText: JSON.stringify({ path: "attachments/photo.png", name: "photo.png", size: 2048 }),
    }));
    const outcome = await uploadAttachmentBytes(sender, "proj_1", "photo.png", "iVBOR...");
    expect(outcome.ok && outcome.data.path).toBe("attachments/photo.png");
    expect(calls[0]?.path).toBe("/api/v1/attachments/upload");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init.bodyText ?? "")).toEqual({
      projectId: "proj_1",
      name: "photo.png",
      dataBase64: "iVBOR...",
    });
  });

  it("GET /projects/:id/tree and GET /projects/:id/modes (the picker's data)", async () => {
    const { sender, calls } = makeSender((path) => ({
      status: 200,
      bodyText: JSON.stringify(
        path.endsWith("/tree")
          ? { tree: [], rootPath: "/tmp/proj" }
          : { modes: [{ id: "deep-research", name: "Deep Research", description: "d", source: "builtin", readOnly: false }] },
      ),
    }));
    const tree = await fetchProjectTree(sender, "proj 1"); // id is encoded
    expect(tree.ok && tree.data.rootPath).toBe("/tmp/proj");
    expect(calls[0]?.path).toBe("/api/v1/projects/proj%201/tree");
    const modes = await fetchProjectModes(sender, "proj 1");
    expect(modes.ok && modes.data.modes[0]?.id).toBe("deep-research");
    expect(calls[1]?.path).toBe("/api/v1/projects/proj%201/modes");
    expect(calls[1]?.init.method).toBeUndefined(); // a plain GET
  });
});
