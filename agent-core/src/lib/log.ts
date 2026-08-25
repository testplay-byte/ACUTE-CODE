/**
 * ROUND-37 structured logging (owner: "look into proper logging of things…
 * so that we have a much better, smoother, well-thought-out, and well-planned
 * future").
 *
 * Zero-dependency JSON-lines logger: every line is a single JSON object with
 * a timestamp, level, event name, and structured fields. Output goes to
 * BOTH stdout (the sidecar console) and `$ACUTE_LOG_PATH` (default
 * `<cwd>/.dev/acute.log`) when writable — the file is dev-only and
 * gitignored.
 *
 * SECURITY (hard rule): NEVER log tool OUTPUT (may contain secrets the
 * keyring doesn't know) or key VALUES. Tool calls log name + argsSummary
 * only — the same sanitized shape the session event log persists.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function logFilePath(): string {
  const configured = process.env.ACUTE_LOG_PATH;
  if (configured !== undefined && configured !== "") return resolve(configured);
  return resolve(process.cwd(), ".dev", "acute.log");
}

function minLevel(): LogLevel {
  const raw = process.env.ACUTE_LOG_LEVEL;
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

let fileReady = false;
function appendToFile(line: string): void {
  try {
    const path = logFilePath();
    if (!fileReady) {
      mkdirSync(dirname(path), { recursive: true });
      fileReady = true;
    }
    appendFileSync(path, line + "\n");
  } catch {
    // Unwritable path (read-only cwd, etc.) — console logging still works.
    fileReady = false;
  }
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < LEVELS[minLevel()]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(entry);
  appendToFile(line);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Turn lifecycle (one line per turn — the backbone of the log). */
export function logTurnStart(sessionId: string, agentId: string, model: string, streamed: boolean): void {
  log("info", "turn.start", { sessionId, agentId, model, streamed });
}

export function logTurnEnd(sessionId: string, ok: boolean, ms: number, inputTokens: number, outputTokens: number): void {
  log("info", "turn.end", { sessionId, ok, ms, inputTokens, outputTokens });
}

/** Tool call — name + argsSummary ONLY (never outputs, never secrets). */
export function logTool(sessionId: string, toolName: string, argsSummary: string, ok: boolean): void {
  log("info", "tool.call", { sessionId, toolName, argsSummary, ok });
}

/** Approval lifecycle (the security-relevant trail). */
export function logApproval(
  phase: "requested" | "resolved" | "expired",
  approvalId: string,
  fields: Record<string, unknown> = {},
): void {
  log("info", `approval.${phase}`, { approvalId, ...fields });
}

/** Errors with context. */
export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  log("error", event, {
    message: error instanceof Error ? error.message : String(error),
    ...fields,
  });
}
