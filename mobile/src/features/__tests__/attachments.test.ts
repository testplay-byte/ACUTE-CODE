/**
 * attachments.test.ts — the composer's FILE WORLD (R113-c): the staged-chip
 * helpers (server-read staging, the wire-format MessageAttachment, the
 * 20-chip cap + id dedupe), the @-token detector (word-start, mid-word
 * emails, whitespace-closed tokens), the project-tree walk + live filter
 * (the desktop's exact DFS + limit-8), and the typed clients' bodies
 * (POST /attachments/read, POST /attachments/upload, GET
 * /projects/:id/tree) — all against an injected fake sender, zero React
 * Native. (GET /projects/:id/modes lost its last consumer with R115-i's
 * task-mode deletion; the client went with it — R115-p.)
 *
 * R120-P (round-120 §1 items 31+32): the @-menu's CARET ADVANCE (Android
 * fires onChangeText before onSelectionChange — a stale caret never saw
 * the fresh "@", so the menu never opened; advancedCaret moves with the
 * edit while the selection event re-detects behind it), the image-name
 * test, and the preview-kind classifier that picks WHICH viewer a chip
 * opens (image → the ImageViewer; text → the mono card; info → the honest
 * name/size card).
 */

import { describe, expect, it } from "@jest/globals";

import type { ApiSender } from "../api";
import {
  MAX_ATTACHMENTS,
  advancedCaret,
  attachmentFromRead,
  attachmentPreviewKind,
  detectAtToken,
  attachmentCacheFileName,
  fetchAttachmentImageBase64,
  fetchProjectTree,
  filterProjectFiles,
  flattenTreeFiles,
  formatAttachmentSize,
  isImageFileName,
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

  it("R120-P: advancedCaret — the onChangeText leg's caret moves with the edit (Android fires change BEFORE selection)", () => {
    // the exact bug: typing "@" into an EMPTY field read caret 0 (the last
    // selection event's value) and the menu NEVER opened — detectAtToken
    // needs the caret PAST the "@".
    expect(advancedCaret(0, "", "@")).toBe(1);
    // continuing the query advances one char at a time
    expect(advancedCaret(1, "@", "@s")).toBe(2);
    expect(advancedCaret(2, "@s", "@sr")).toBe(3);
    // a mid-line insert advances the same way
    expect(advancedCaret(8, "look at ", "look at @")).toBe(9);
    // deletions clamp to the shorter value (the caret can never trail the text)
    expect(advancedCaret(3, "@sr", "@s")).toBe(2);
    expect(advancedCaret(2, "@s", "@")).toBe(1);
    expect(advancedCaret(1, "@", "")).toBe(0);
    // a bulk paste lands the caret at prev + delta, clamped to the length
    expect(advancedCaret(0, "", "@src/main.ts")).toBe(12);
    // a bulk delete clamps to the new length, never below 0
    expect(advancedCaret(12, "@src/main.ts", "")).toBe(0);
  });
});

// ── the R120-P preview kinds (which viewer a chip opens) ────────────────────

describe("attachments — the R120-P preview kinds (item 32)", () => {
  const chip = (overrides: Partial<ComposerAttachment>): ComposerAttachment => ({
    id: "x",
    name: "x.bin",
    size: 10,
    text: null,
    truncated: false,
    source: "picker",
    ...overrides,
  });

  it("isImageFileName — the image-extension test over the display name", () => {
    expect(isImageFileName("photo.png")).toBe(true);
    expect(isImageFileName("photo.JPG")).toBe(true);
    expect(isImageFileName("photo.jpeg")).toBe(true);
    expect(isImageFileName("photo.webp")).toBe(true);
    expect(isImageFileName("photo.gif")).toBe(true);
    expect(isImageFileName("photo.avif")).toBe(true);
    expect(isImageFileName("photo.bmp")).toBe(true);
    expect(isImageFileName("main.ts")).toBe(false);
    expect(isImageFileName("notes.txt")).toBe(false);
    expect(isImageFileName("archive.png.gz")).toBe(false);
    expect(isImageFileName("")).toBe(false);
  });

  it("attachmentPreviewKind — image ONLY when the phone holds the bytes (a picked localUri)", () => {
    expect(attachmentPreviewKind(chip({ name: "photo.png", localUri: "file:///cache/photo.png" }))).toBe("image");
    // an image whose bytes live on the host (no localUri) is NOT a preview
    expect(attachmentPreviewKind(chip({ name: "photo.png" }))).toBe("info");
  });

  it("attachmentPreviewKind — text when the chip carries a head, whatever the name", () => {
    expect(attachmentPreviewKind(chip({ name: "notes.txt", text: "hello" }))).toBe("text");
    expect(attachmentPreviewKind(chip({ name: "main.ts", text: "export {}" }))).toBe("text");
    // an image-name file WITH text (a server-side text head) reads as text
    expect(attachmentPreviewKind(chip({ name: "weird.png", text: "# not pixels" }))).toBe("text");
  });

  it("attachmentPreviewKind — info for everything else (the honest name/size card)", () => {
    expect(attachmentPreviewKind(chip({ name: "data.bin", text: null }))).toBe("info");
    expect(attachmentPreviewKind(chip({ name: "data.bin", text: null, localUri: undefined }))).toBe("info");
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

  it("GET /projects/:id/tree (the picker's data)", async () => {
    const { sender, calls } = makeSender(() => ({
      status: 200,
      bodyText: JSON.stringify({ tree: [], rootPath: "/tmp/proj" }),
    }));
    const tree = await fetchProjectTree(sender, "proj 1"); // id is encoded
    expect(tree.ok && tree.data.rootPath).toBe("/tmp/proj");
    expect(calls[0]?.path).toBe("/api/v1/projects/proj%201/tree");
    expect(calls[0]?.init.method).toBeUndefined(); // a plain GET
  });
});


// ── ROUND-121 (R121-c — the pixels round): the display-bytes client ─────────

describe("attachments — fetchAttachmentImageBase64 (ROUND-121 R121-c)", () => {
  function makeBinarySender(
    respond: (path: string, init: { responseBase64?: boolean }) => {
      status: number;
      bodyBase64?: string;
    },
  ) {
    const calls: Array<{ path: string; init: { responseBase64?: boolean } }> = [];
    const sender: ApiSender = {
      async api(path, init = {}) {
        calls.push({ path, init });
        const r = respond(path, init as { responseBase64?: boolean });
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: {},
          bodyText: "",
          ...(r.bodyBase64 !== undefined ? { bodyBase64: r.bodyBase64 } : {}),
        };
      },
    };
    return { sender, calls };
  }

  it("a display-image path fetches with responseBase64 — the base64 comes back raw", async () => {
    const { sender, calls } = makeBinarySender(() => ({
      status: 200,
      bodyBase64: "aVBORw==",
    }));
    const bytes = await fetchAttachmentImageBase64(sender, "proj_1", "attachments/shot.png");
    expect(bytes).toEqual({ base64: "aVBORw==", miss: false });
    expect(calls[0]?.path).toBe(
      "/api/v1/projects/proj_1/attachments/bytes?path=attachments%2Fshot.png",
    );
    expect(calls[0]?.init.responseBase64).toBe(true);
  });

  it("a 404 answers the honest MISS (permanent — the frame stands)", async () => {
    const { sender } = makeBinarySender(() => ({ status: 404 }));
    const bytes = await fetchAttachmentImageBase64(sender, "proj_1", "attachments/gone.png");
    expect(bytes).toEqual({ base64: null, miss: true });
  });

  it("a transport throw answers base64-null / NOT-miss (the caller may retry)", async () => {
    const sender: ApiSender = {
      async api() {
        throw new Error("link down");
      },
    };
    const bytes = await fetchAttachmentImageBase64(sender, "proj_1", "attachments/shot.png");
    expect(bytes).toEqual({ base64: null, miss: false });
  });

  it("a NON-IMAGE path never fetches (the client-side allowlist mirror)", async () => {
    const { sender, calls } = makeBinarySender(() => ({ status: 200, bodyBase64: "eHg=" }));
    const log = await fetchAttachmentImageBase64(sender, "proj_1", "attachments/debug.log");
    expect(log).toEqual({ base64: null, miss: true });
    const svg = await fetchAttachmentImageBase64(sender, "proj_1", "attachments/vector.svg");
    expect(svg).toEqual({ base64: null, miss: true });
    const bare = await fetchAttachmentImageBase64(sender, "proj_1", "attachments/README");
    expect(bare).toEqual({ base64: null, miss: true });
    expect(calls).toHaveLength(0);
  });

  it("an empty bodyBase64 answers the honest miss (never fabricated pixels)", async () => {
    const { sender } = makeBinarySender(() => ({ status: 200, bodyBase64: "" }));
    const bytes = await fetchAttachmentImageBase64(sender, "proj_1", "attachments/shot.png");
    expect(bytes).toEqual({ base64: null, miss: true });
  });
});

describe("attachments — attachmentCacheFileName (ROUND-121 R121-c)", () => {
  it("content-keys the cache name: path slug + size + the extension lowercased", () => {
    expect(attachmentCacheFileName("attachments/shot.png", 2048)).toBe(
      "att-attachments-shot.png-2048.png",
    );
    expect(attachmentCacheFileName("attachments/Photo.JPG")).toBe("att-attachments-Photo.JPG.jpg");
  });

  it("collapses separators + dots (a safe cache filename) and survives extension-less", () => {
    expect(attachmentCacheFileName("attachments/../notes/shot.png")).toBe(
      "att-attachments--notes-shot.png.png",
    );
    expect(attachmentCacheFileName("README")).toBe("att-README.img");
  });
});
