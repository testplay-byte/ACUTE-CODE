/**
 * ROUND-106 (R106-S3, CLI-DESIGN §3/§4): the SSE reader — a faithful port of
 * the desktop client's loop (src/lib/api.ts streamSessionMessage):
 *
 *   · fetch POST /sessions/:id/messages/stream (Bearer, JSON body);
 *   · non-2xx → the {error:{code,message}} envelope becomes ONE synthesized
 *     error frame (never a throw — the exit-code semantics stay uniform);
 *   · getReader() + `"\n\n"` buffer split + `data: ` line parse, malformed
 *     frames skipped, chunk boundaries MID-Frame tolerated;
 *   · terminal-frame tracking: a well-formed stream ALWAYS ends with
 *     done|error|stopped (the R43 rule) — a stream that dies without one
 *     gets the synthesized STREAM_DISCONNECTED error frame, EXCEPT when the
 *     LOCAL abort fired (the deliberate stop — the connection teardown is
 *     the cause, not a sidecar crash; the desktop's exact carve-out);
 *   · read-loop exceptions PROPAGATE (the caller classifies).
 */
import { ApiError, parseErrorEnvelope } from "./api.js";
import type { Connection } from "./connection.js";
import { parseFrame, type TurnFrame } from "./frames.js";

export interface StreamTurnOptions {
  model?: string;
  providerId?: string;
  thinkingLevel?: string;
  signal?: AbortSignal;
}

/**
 * Stream one turn. Resolves when the terminal frame has been delivered (or
 * the synthesized disconnect); the CALLER derives the exit code from the
 * terminal frame it saw through `onFrame` — returning `true` from onFrame
 * stops reading early (the acute.mjs break-on-terminal contract; the
 * server also ends the stream itself, this just does not wait for it).
 */
export async function streamTurn(
  conn: Connection,
  sessionId: string,
  content: string,
  onFrame: (frame: TurnFrame) => boolean | void,
  options?: StreamTurnOptions,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${conn.baseUrl}/api/v1/sessions/${sessionId}/messages/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${conn.token}`,
      },
      body: JSON.stringify({
        content,
        ...(options?.model !== undefined ? { model: options.model } : {}),
        ...(options?.providerId !== undefined ? { providerId: options.providerId } : {}),
        ...(options?.thinkingLevel !== undefined && options.thinkingLevel !== "default"
          ? { thinkingLevel: options.thinkingLevel }
          : {}),
      }),
      signal: options?.signal,
    });
  } catch (err) {
    if (options?.signal?.aborted === true) return; // deliberate stop — no synthesis
    throw err;
  }
  if (!res.ok || !res.body) {
    // Non-2xx: the error envelope is JSON, not SSE (the desktop contract).
    const text = await res.text().catch(() => "");
    const apiError = parseErrorEnvelope(res.status, text);
    onFrame({
      type: "error",
      ...(apiError.status !== 0 ? { status: apiError.status } : {}),
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details !== undefined ? { details: apiError.details } : {}),
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalFrame = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            const frame = parseFrame(line.slice(6));
            if (frame === null) continue; // skip malformed frame
            if (frame.type === "done" || frame.type === "error" || frame.type === "stopped") {
              sawTerminalFrame = true;
            }
            if (onFrame(frame) === true) {
              await reader.cancel().catch(() => {});
              return;
            }
          }
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!sawTerminalFrame) {
    if (options?.signal?.aborted === true) {
      // The local AbortController fired (deliberate stop grace-abort): the
      // connection teardown is the CAUSE, not a sidecar crash — no
      // synthesized error frame (the desktop's exact carve-out).
      return;
    }
    onFrame({
      type: "error",
      status: 0,
      code: "STREAM_DISCONNECTED",
      message: "The stream from the agent ended unexpectedly (connection interrupted).",
    });
  }
}

/** Re-exported for callers that catch envelope errors outside streams. */
export { ApiError };
