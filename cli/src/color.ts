/**
 * ROUND-106 (R106-S3, CLI-DESIGN §4): the terminal color kit — hand-rolled
 * ANSI, zero deps (the zero-dep discipline; a library would trigger
 * license-audit + bundling decisions every time).
 *
 * `NO_COLOR` and a non-TTY stdout auto-disable EVERYTHING (the acute.mjs
 * rule, kept byte-for-byte in spirit). The accent is the app's #ff6b2c as
 * truecolor `38;2;255;107;44`; ok/fail/meta are the plain SGR colors.
 */
export interface ColorKit {
  readonly enabled: boolean;
  bold: (s: string) => string;
  dim: (s: string) => string;
  accent: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
}

const NO_COLOR_KIT: ColorKit = {
  enabled: false,
  bold: (s) => s,
  dim: (s) => s,
  accent: (s) => s,
  red: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
};

/** Truecolor accent #ff6b2c (CLI-DESIGN §4) — bold-capable variants below. */
const ACCENT_SGR = "38;2;255;107;44";

/** Build a kit bound to one output's TTY state + the NO_COLOR rule. */
export function colorKitFor(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): ColorKit {
  if (!isTTY || env.NO_COLOR !== undefined) return NO_COLOR_KIT;
  const ansi = (open: number | string, close: number | string) => (s: string) =>
    `\x1b[${open}m${s}\x1b[${close}m`;
  const dim = ansi(2, 22);
  const bold = ansi(1, 22);
  return {
    enabled: true,
    bold,
    dim,
    accent: (s) => `\x1b[${ACCENT_SGR}m${s}\x1b[39m`,
    red: ansi(31, 39),
    green: ansi(32, 39),
    yellow: ansi(33, 39),
  };
}

/** The bold-accent heading style (## → bold orange, CLI-DESIGN §4). */
export function boldAccent(kit: ColorKit, s: string): string {
  return kit.enabled ? `\x1b[1;${ACCENT_SGR}m${s}\x1b[22;39m` : s;
}

/** The accent-tinted inline-code style (`code`, CLI-DESIGN §4). */
export function accentCode(kit: ColorKit, s: string): string {
  return kit.enabled ? `\x1b[${ACCENT_SGR}m${s}\x1b[39m` : s;
}
