/**
 * ROUND-106 (R106-S3, CLI-DESIGN §4): the ONE status line — a single
 * overwritten line (`\r\x1b[2K` clearing — 2K erases the WHOLE line, so no
 * pad-clearing is needed). Thinking counters and live tool-input previews
 * render HERE, never in the flow; any real output clears it first. Non-TTY:
 * every method is a no-op (counting happens in the caller).
 */
export class StatusLine {
  #write: (s: string) => void;
  #enabled: boolean;
  #active = false;

  constructor(write: (s: string) => void, enabled: boolean) {
    this.#write = write;
    this.#enabled = enabled;
  }

  get active(): boolean {
    return this.#active;
  }

  /** Overwrite the line with `text` (or show it for the first time). */
  set(text: string): void {
    if (!this.#enabled) return;
    this.#write(`\r\x1b[2K${text}`);
    this.#active = true;
  }

  /** Clear the line (before ANY real output — the §4 rule). */
  clear(): void {
    if (!this.#active) return;
    this.#write("\r\x1b[2K");
    this.#active = false;
  }

  /** A newline-terminated status MESSAGE: clear, write the line + `\n`. */
  message(text: string): void {
    if (!this.#enabled) return;
    this.clear();
    this.#write(`${text}\n`);
  }
}

/** The spinner frame for a working turn (kept honest + slow: 4 frames). */
const SPINNER_FRAMES = ["·  ", "·· ", "···", " ··"] as const;

export function spinnerFrame(elapsedMs: number): string {
  return SPINNER_FRAMES[Math.floor(elapsedMs / 200) % SPINNER_FRAMES.length];
}
