/**
 * qr-from-image.test.ts — the PURE leg of the photo pipeline: magic-byte
 * sniffing and the honest unsupported/no-code outcomes. The import itself
 * doubles as the proof that features/qr-from-image.ts loads cleanly under
 * jest — its expo legs (document-picker / image-manipulator / file-system)
 * are require'd lazily inside pickQrFromPhoto, never at module load.
 */

import { describe, expect, it } from "@jest/globals";

import { decodeQrFromImageBytes, sniffImageFormat } from "../qr-from-image";

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const GIF_MAGIC = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

describe("sniffImageFormat", () => {
  it("classifies by magic bytes, never by extension", () => {
    expect(sniffImageFormat(PNG_MAGIC)).toBe("png");
    expect(sniffImageFormat(JPEG_MAGIC)).toBe("jpeg");
    expect(sniffImageFormat(GIF_MAGIC)).toBe("unknown");
  });

  it("too-short or empty byte arrays are unknown, not a crash", () => {
    expect(sniffImageFormat(new Uint8Array())).toBe("unknown");
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e]))).toBe("unknown");
  });
});

describe("decodeQrFromImageBytes", () => {
  it("an unsupported format resolves to the typed unsupported outcome", () => {
    expect(decodeQrFromImageBytes(GIF_MAGIC)).toEqual({ kind: "unsupported" });
    expect(decodeQrFromImageBytes(new Uint8Array())).toEqual({ kind: "unsupported" });
  });

  it("a PNG/JPEG header over garbage bytes resolves to no-code (never a throw)", () => {
    const garbagePng = new Uint8Array([...PNG_MAGIC, 0, 1, 2, 3, 4, 5]);
    expect(decodeQrFromImageBytes(garbagePng)).toEqual({ kind: "no-code" });
    const garbageJpeg = new Uint8Array([...JPEG_MAGIC, 0, 1, 2, 3, 4, 5]);
    expect(decodeQrFromImageBytes(garbageJpeg)).toEqual({ kind: "no-code" });
  });
});
