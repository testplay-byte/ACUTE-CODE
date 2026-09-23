// @vitest-environment happy-dom
/**
 * ROUND-121 (R121-b — the pixels round): the composer's staged-chip pixel
 * preview. Until now a staged image rendered as a text chip (FileText glyph
 * + name + size) even though the picker's bytes were ALREADY on the chip as
 * `dataBase64` — the pixels were in hand and never drawn.
 *
 * Pinned here:
 *  · a staged IMAGE (dataBase64 + a display extension) renders the 20px
 *    pixel thumbnail (an <img> with the data: URI, the alt = the name) in
 *    the chip's head — the glyph is REPLACED, not appended;
 *  · a staged image WITHOUT bytes (path-only, the project-file @-mention
 *    shape) keeps the plain glyph — never a fabricated photo;
 *  · a staged NON-image binary (a .bin with bytes) keeps the plain glyph;
 *  · the remove ✕ + name + size row is untouched in every shape (the
 *    existing chip grammar rides below the preview);
 *  · the extension set mirrors the bytes route's allowlist (png/jpg/jpeg/
 *    gif/webp/bmp) — svg stays glyphed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AttachmentChips } from "./AttachmentChips";
import type { ComposerAttachment } from "./composer-utils";

afterEach(() => {
  cleanup();
});

/** A 1×1 transparent PNG's base64 — real magic bytes, decodable. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function chip(overrides: Partial<ComposerAttachment>): ComposerAttachment {
  return {
    id: "chip-1",
    name: "photo.png",
    size: 95,
    text: null,
    ...overrides,
  };
}

describe("AttachmentChips staged pixel preview (ROUND-121 R121-b)", () => {
  it("a staged image with bytes renders the PIXEL thumbnail — an <img> riding the chip head", () => {
    render(
      <AttachmentChips
        attachments={[chip({ dataBase64: TINY_PNG_B64 })]}
        onRemove={() => {}}
      />,
    );
    const img = screen.getByTestId("staged-attachment-preview");
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(img.getAttribute("alt")).toBe("photo.png");
    // The name + size still ride the chip (the grammar below the preview).
    expect(screen.getByText("photo.png")).toBeTruthy();
    expect(screen.getByText("95 B")).toBeTruthy();
  });

  it("a path-only image (no staged bytes) keeps the plain glyph — never a fabricated photo", () => {
    render(
      <AttachmentChips
        attachments={[chip({ path: "attachments/photo.png", dataBase64: null })]}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByTestId("staged-attachment-preview")).toBeNull();
    expect(screen.getByText("photo.png")).toBeTruthy();
  });

  it("a staged NON-image binary keeps the plain glyph", () => {
    render(
      <AttachmentChips
        attachments={[chip({ name: "blob.bin", dataBase64: "AAAA" })]}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByTestId("staged-attachment-preview")).toBeNull();
    expect(screen.getByText("blob.bin")).toBeTruthy();
  });

  it("svg is NOT in the staged display set — the glyph stands", () => {
    render(
      <AttachmentChips
        attachments={[chip({ name: "vector.svg", dataBase64: "PHN2Zy8+" })]}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByTestId("staged-attachment-preview")).toBeNull();
  });

  it("the remove ✕ still fires per chip (the untouched grammar)", () => {
    const onRemove = vi.fn();
    render(
      <AttachmentChips
        attachments={[chip({ dataBase64: TINY_PNG_B64 })]}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment photo.png" }));
    expect(onRemove).toHaveBeenCalledWith("chip-1");
  });
});
