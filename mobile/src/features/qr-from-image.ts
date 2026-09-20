/**
 * qr-from-image.ts — the scanner's "Choose a photo instead" pipeline
 * (R115-D): document-picker → downscale to a ≤1200px JPEG → read the bytes →
 * magic-byte sniff → decode (upng-js / jpeg-js) → jsQR — the SAME decode
 * contract the live camera path enforces.
 *
 * STRUCTURE (jest-honest): the sniff + decode + locate leg is PURE — only
 * jsqr/jpeg-js/upng-js (pure JS) are imported at module load, so this file
 * imports cleanly under jest with zero native-bridge mocks. The expo legs
 * (document-picker / image-manipulator / file-system) are require'd LAZILY
 * inside pickQrFromPhoto — the one function that owns them — so importing
 * the module never touches a native module until the user actually picks a
 * photo (the raster.ts/composer.tsx house pattern, one step lazier).
 */

import jsQR from "jsqr";
import { decode as decodeJpeg } from "jpeg-js";
import UPNG from "upng-js";
import type * as DocumentPickerModule from "expo-document-picker";
import type * as ImageManipulatorModule from "expo-image-manipulator";
import type * as FileSystemModule from "expo-file-system";

/** The decode target width — jsQR over a full-res 4000px photo costs seconds. */
const PHOTO_MAX_WIDTH = 1200;

// ── the pure leg (jest-importable, no expo) ─────────────────────────────────

export type ImageFormat = "png" | "jpeg" | "unknown";

/**
 * Magic-byte sniff — honest, content-based, never the file extension:
 * PNG = 89 50 4E 47, JPEG = FF D8 FF.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  return "unknown";
}

/** The pure decode outcome — the screen's three honest notes. */
export type QrDecodeResult =
  | { kind: "hit"; text: string }
  | { kind: "no-code" }
  | { kind: "unsupported" };

/** One decoded frame in jsQR's expected shape. */
interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function decodePngToRgba(bytes: Uint8Array): RgbaImage | null {
  // UPNG consumes an ArrayBuffer; slice() guarantees an exact, unaliased one.
  const png = UPNG.decode(bytes.slice().buffer);
  const frame = UPNG.toRGBA8(png)[0];
  if (frame === undefined) return null;
  return { data: new Uint8ClampedArray(frame), width: png.width, height: png.height };
}

function decodeJpegToRgba(bytes: Uint8Array): RgbaImage | null {
  const jpeg = decodeJpeg(bytes, { useTArray: true });
  const data = new Uint8ClampedArray(jpeg.data.buffer, jpeg.data.byteOffset, jpeg.data.byteLength);
  return { data, width: jpeg.width, height: jpeg.height };
}

/**
 * Decode image bytes and locate the QR code — `inversionAttempts:
 * "attemptBoth"` because photographed screens invert more often than not.
 * Pure: bytes in, one of three honest outcomes out (never a throw).
 */
export function decodeQrFromImageBytes(bytes: Uint8Array): QrDecodeResult {
  const format = sniffImageFormat(bytes);
  if (format === "unknown") return { kind: "unsupported" };
  try {
    const image = format === "png" ? decodePngToRgba(bytes) : decodeJpegToRgba(bytes);
    if (
      image === null ||
      !Number.isFinite(image.width) ||
      !Number.isFinite(image.height) ||
      image.width <= 0 ||
      image.height <= 0
    ) {
      return { kind: "no-code" };
    }
    if (image.data.length < image.width * image.height * 4) return { kind: "no-code" };
    const code = jsQR(image.data, image.width, image.height, {
      inversionAttempts: "attemptBoth",
    });
    if (code === null || typeof code.data !== "string" || code.data === "") {
      return { kind: "no-code" };
    }
    return { kind: "hit", text: code.data };
  } catch {
    // A corrupt/truncated image decodes to nothing — the honest "no code".
    return { kind: "no-code" };
  }
}

// ── the native leg (lazy requires — the pick path only) ─────────────────────

/** pickQrFromPhoto's outcome — "canceled" plus the pure decode results. */
export type PhotoQrOutcome = { kind: "canceled" } | QrDecodeResult;

/**
 * The whole "Choose a photo instead" pipeline. Throws are the CALLER's to
 * catch honestly (the screen wraps this in try/catch → one failure line);
 * every in-pipeline dead end resolves as a typed outcome instead.
 */
export async function pickQrFromPhoto(): Promise<PhotoQrOutcome> {
  // Lazy native imports (see the file header): zero cost until a photo is
  // actually picked, and jest imports never load them at all.
  const DocumentPicker = require("expo-document-picker") as typeof DocumentPickerModule;
  const { manipulateAsync, SaveFormat } = require("expo-image-manipulator") as typeof ImageManipulatorModule;
  const { File } = require("expo-file-system") as typeof FileSystemModule;

  const pick = await DocumentPicker.getDocumentAsync({
    type: "image/*",
    multiple: false,
  });
  if (pick.canceled || pick.assets.length === 0) return { kind: "canceled" };
  const asset = pick.assets[0];

  // Downscale to ≤1200px wide JPEG — fast decode, QR modules stay huge.
  const resized = await manipulateAsync(
    asset.uri,
    [{ resize: { width: PHOTO_MAX_WIDTH } }],
    { format: SaveFormat.JPEG },
  );

  // Read the bytes, sniff them honestly (never trust the extension), and
  // clean the cache file up behind us (best-effort).
  const file = new File(resized.uri);
  let bytes: Uint8Array;
  try {
    bytes = await file.bytes();
  } finally {
    try {
      file.delete();
    } catch {
      // A leftover cache file is never worth an error.
    }
  }

  return decodeQrFromImageBytes(bytes);
}
