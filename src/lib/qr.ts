import QRCode from "qrcode";

/**
 * ROUND-106 (R106-S2, the Devices tab): the ONE QR rendering wrapper —
 * the pairing dialog's QR is produced here, not in the component, for the
 * same reason SEMANTIC_COLORS lives in src/lib (design-audit.mjs scans
 * only src/components + src/pages: this is the SANCTIONED home for values
 * the application applies — TOKENS.md §1's pipeline route).
 *
 * The scannability contract (LINKING-PROTOCOL.md §2): a QR must stay
 * dark-modules-on-light-ground REGARDLESS of the app's dark mode — a
 * themed (inverted) QR is unscannable under a phone camera. The pair is
 * fixed near-black on near-white and rides the SVG renderer (crisp at any
 * size, flat aesthetic, no canvas): `qrcode`'s server-agnostic
 * `toString(text, { type: "svg" })` API.
 */

/** The QR's fixed module pair — dark on light, theme-independent. */
export const QR_MODULE_DARK = "#111827";
export const QR_MODULE_LIGHT = "#ffffff";

/** The ink for the tile's transient "rendering…" line — must read on the
 * FIXED light ground in dark mode too (the theme's tertiary would not). */
export const QR_TILE_INK = "#6b7280";

/** The quiet-zone margin in modules (the spec's 4 is generous; 2 keeps the
 * pairing tile compact while staying comfortably scannable). */
const QR_MARGIN_MODULES = 2;

/**
 * Render `payload` as an SVG string (the pairing dialog injects it into a
 * fixed light tile). Throws only on pathological payloads (the encoder's
 * own "code length overflow" — impossible for the ~300-char pairing JSON);
 * the caller renders the honest error state.
 */
export async function renderQrSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: "svg",
    margin: QR_MARGIN_MODULES,
    errorCorrectionLevel: "medium",
    color: { dark: QR_MODULE_DARK, light: QR_MODULE_LIGHT },
  });
}
