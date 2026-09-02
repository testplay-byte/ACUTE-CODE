/**
 * ROUND-61 (R61): the audit journal — doc 08-safety.md §4. Append-only JSONL
 * at <project>/.acute/computer-use/audit.jsonl, one record per tool call
 * (args, receipt, ts, session). Retention + redaction policy: clipboard
 * TEXT is omitted (length only), credential-shaped strings are scrubbed,
 * screenshots never enter the journal (frame ids only — the raster bytes
 * are not journal material and could contain anything).
 *
 * Fail-soft by design: a broken journal must never take a turn down (the
 * same subscriber-throw rule as the notification bus) — every write is
 * wrapped, failures logged to stderr.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../lib/log.js";
import type { Receipt, Refusal } from "./types.js";

export interface AuditRecord {
  ts: number;
  sessionStartedAt: number | null;
  tool: string;
  args: Record<string, unknown>;
  outcome:
    | { kind: "receipt"; receipt: Receipt }
    | { kind: "refusal"; refusal: Refusal };
}

/** Patterns that must never reach the journal in cleartext. */
const CREDENTIAL_RE =
  /(sk-[a-zA-Z0-9-]{16,}|ghp_[a-zA-Z0-9]+|github_pat_[a-zA-Z0-9_]+|AKIA[A-Z0-9]{12}|Bearer\s+[a-zA-Z0-9._-]{12,}|(?:api[_-]?key|password|token|secret)\s*[:=]\s*\S+)/gi;

/** Max length of any single string field in the journal. */
const FIELD_CAP = 2000;

function scrubString(value: string): string {
  return value.replace(CREDENTIAL_RE, "[REDACTED]").slice(0, FIELD_CAP);
}

/**
 * Recursively redact: credential-shaped strings, oversized strings, and
 * clipboard/text payloads (length only — doc 08's redaction policy).
 * `omitKeys` names keys whose STRING values are replaced by {len} markers
 * (clipboard text, typed text).
 */
export function redactForAudit(
  value: unknown,
  omitKeys: ReadonlySet<string> = new Set(["text", "clipboard", "value"]),
): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => redactForAudit(v, omitKeys));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && omitKeys.has(k)) {
        out[k] = { redacted: true, len: v.length };
      } else {
        out[k] = redactForAudit(v, omitKeys);
      }
    }
    return out;
  }
  return value;
}

export function auditPath(root: string): string {
  return join(root, ".acute", "computer-use", "audit.jsonl");
}

/**
 * Append one record. Best-effort: creates the directory, writes one line,
 * logs (never throws) on failure. Returns true when the line landed.
 */
export function appendAudit(root: string, record: AuditRecord): boolean {
  try {
    const dir = join(root, ".acute", "computer-use");
    mkdirSync(dir, { recursive: true });
    const redacted: AuditRecord = {
      ...record,
      args: redactForAudit(record.args) as Record<string, unknown>,
    };
    appendFileSync(auditPath(root), `${JSON.stringify(redacted)}\n`, "utf8");
    return true;
  } catch (err) {
    log("warn", "computer.audit.append_failed", { error: String(err) });
    return false;
  }
}

/** Test helper: truncate the journal (production never truncates). */
export function resetAuditForTests(root: string): void {
  try {
    writeFileSync(auditPath(root), "", "utf8");
  } catch {
    // absent file is fine
  }
}
