/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the `--mode json` renderer — NDJSON
 * passthrough. Sidecar frames pass through VERBATIM, one per line, wrapped
 * with the CLI's own lifecycle events:
 *
 *   {"type":"cli.attach","baseUrl":…,"source":"env|portal|spawn",…}
 *   {"type":"cli.session","sessionId":…,"agentId":…}
 *   {"type":"cli.exit","code":N}   (always the LAST line)
 *
 * Exit code from the terminal frame (done/stopped → 0, error → 1); a stream
 * that dies without one gets the synthesized STREAM_DISCONNECTED error
 * frame from stream.ts, so the NDJSON log stays honest end-to-end. NOTHING
 * else ever touches stdout in this mode (all notices ride stderr).
 */
import type { TurnFrame } from "../frames.js";

export interface JsonRendererOptions {
  stdout: (s: string) => void;
}

export interface JsonRenderer {
  /** One lifecycle event (emitted verbatim, one per line). */
  lifecycle(event: Record<string, unknown>): void;
  /** Feed one sidecar frame → the verbatim NDJSON line; returns the exit
   * code on terminal frames. */
  handle(frame: TurnFrame): number | undefined;
  /** The final cli.exit line. */
  exit(code: number): void;
}

export function createJsonRenderer(options: JsonRendererOptions): JsonRenderer {
  const { stdout } = options;
  let sawTerminal = false;
  return {
    lifecycle(event: Record<string, unknown>): void {
      stdout(`${JSON.stringify(event)}\n`);
    },
    handle(frame: TurnFrame): number | undefined {
      stdout(`${JSON.stringify(frame)}\n`);
      if (frame.type === "done" || frame.type === "stopped") {
        sawTerminal = true;
        return 0;
      }
      if (frame.type === "error") {
        sawTerminal = true;
        return 1;
      }
      return undefined;
    },
    exit(code: number): void {
      const event: Record<string, unknown> = { type: "cli.exit", code };
      if (!sawTerminal) {
        // The stream died without a terminal frame (an abort path) — the
        // honest marker on the exit line itself.
        event.terminal = false;
      }
      stdout(`${JSON.stringify(event)}\n`);
    },
  };
}
