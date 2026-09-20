/**
 * upng-js ships no TypeScript declarations (a plain browser/CJS script).
 * This ambient module types ONLY the surface qr-from-image.ts consumes:
 * `decode(buffer)` → the intermediate image, `toRGBA8(image)` → per-frame
 * RGBA ArrayBuffers.
 */

declare module "upng-js" {
  /** The decoded PNG's intermediate form (subset — tabs/frames unused here). */
  export interface UPngDecoded {
    width: number;
    height: number;
    /** Bit depth (1/2/4/8/16) — toRGBA8 normalizes it away. */
    depth: number;
    /** Color type (0 grayscale … 6 RGBA). */
    ctype: number;
    /** The decompressed, still-encoded scanline data. */
    data: Uint8Array;
    tabs: Record<string, unknown>;
    frames: unknown[];
  }

  const UPNG: {
    /** Decode a PNG (buffer) into the intermediate image form. */
    decode(buffer: ArrayBuffer): UPngDecoded;
    /** Convert the intermediate form to per-frame RGBA ArrayBuffers. */
    toRGBA8(decoded: UPngDecoded): ArrayBuffer[];
  };

  export default UPNG;
}
