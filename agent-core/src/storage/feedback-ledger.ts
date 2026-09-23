/**
 * ROUND-122 (the owner's self-feedback directive): the LEDGER FILE — the
 * one shared markdown file every feedback agent appends to.
 *
 * Location: <dataDir>/feedback.md (the machine-scoped directory beside
 * the SQLite file and vapid.json — the R87 RouteContext.dataDir contract).
 * The app-wide reset purges it (routes/system.ts, mirroring vapid.json).
 *
 * Format (designed for a COLD developer read months later — the owner's
 * exact contract: "when I finally provide you with the feedback report
 * after some time … you can look at it and you can understand each and
 * every single one of the things"):
 *
 *   · a fixed header block explaining what the file is (written once, at
 *     the first append — a bare ledger with no header would fail the cold
 *     read);
 *   · one entry per completed session turn, appended at the END (append
 *     semantics keep writes O(1) and atomic; the settings viewer renders
 *     the file top-down and the newest entries are simply at the bottom);
 *   · each entry's structured header + six model-written sections are
 *     assembled by agents/feedback-writer.ts — THIS module only owns the
 *     file's byte-level discipline.
 *
 * WRITE SERIALIZATION: one module-level promise chain. Two turns ending
 * at the same moment (different sessions, two SSE routes) would otherwise
 * interleave their appendFile calls; the chain guarantees whole-entry
 * ordering forever — the owner's "all the agents will be given this single
 * file" phrasing made the multi-writer case a design requirement, not an
 * edge case.
 *
 * EVENTS-BUS publish (R113-a pattern): every append and every clear
 * broadcasts a {type:"settings", domain:"feedback", value:{…}} frame so
 * any open Settings → Self-Feedback viewer refetches live. The value is
 * informational (file meta, not content) — the frame's job is the
 * invalidation, the same job every settings-domain frame does.
 */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getEventsBus } from "../lib/events-bus.js";

/** The ledger's file name inside the machine-scoped data directory. */
export const FEEDBACK_FILE_NAME = "feedback.md";

/** The fixed header written when the ledger is first created. */
export const FEEDBACK_LEDGER_HEADER = `# ACUTE-CODE — Agent Self-Feedback Ledger

This file is maintained by the self-feedback system (Settings → Self-Feedback,
master switch OFF by default). While the switch is ON, after each completed
session turn a separate context-free agent reviews the whole conversation and
appends one entry below: what it was trying to do, what actually happened,
every issue and glitch it ran into (tools, browser, approvals), where reality
fell short of expectations, and the improvements it would suggest.

Entries are diagnostics for ACUTE-CODE's developers — they are never injected
into any conversation. Newest entries are at the bottom.
`;

/** What GET /feedback/file serves: the raw content plus honest file meta. */
export interface FeedbackLedger {
  exists: boolean;
  /** The raw file text, "" when the ledger has never been written. */
  content: string;
  /** File size in bytes (0 when absent). */
  bytes: number;
  /** The file's mtime as ISO (null when absent) — "last updated". */
  updatedAt: string | null;
  /** Count of entries — the number of "## Entry — " header occurrences. */
  entries: number;
}

/** Resolve the ledger path; exported for the reset purge + tests. */
export function feedbackLedgerPath(dataDir: string): string {
  return join(dataDir, FEEDBACK_FILE_NAME);
}

/** Read the ledger (never throws — a missing file is the honest empty state). */
export function readFeedbackLedger(dataDir: string): FeedbackLedger {
  const path = feedbackLedgerPath(dataDir);
  try {
    if (!existsSync(path)) {
      return { exists: false, content: "", bytes: 0, updatedAt: null, entries: 0 };
    }
    const content = readFileSync(path, "utf8");
    const stat = statSync(path);
    const entries = countEntries(content);
    return {
      exists: true,
      content,
      bytes: stat.size,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      entries,
    };
  } catch {
    // An unreadable ledger serves its empty state — the route stays honest
    // rather than 500-ing on a file the owner can inspect by hand.
    return { exists: false, content: "", bytes: 0, updatedAt: null, entries: 0 };
  }
}

/** Count entries by their header marker (one per appended turn). */
function countEntries(content: string): number {
  return content.split("\n").filter((line) => line.startsWith("## Entry — ")).length;
}

// ── The write chain ─────────────────────────────────────────────────────────
//
// Module-level serialization: every append/clear runs on the tail of this
// chain, so entries can never interleave no matter how many turns end at
// once. The chain's errors are absorbed (each link try/catches its own
// body) so one failed write can never poison the queue for the next.

let ledgerWriteChain: Promise<void> = Promise.resolve();

/** Broadcast the post-write file meta on the events bus (best-effort). */
function publishLedgerFrame(dataDir: string): void {
  try {
    const meta = readFeedbackLedger(dataDir);
    getEventsBus().publishSettingsFrame("feedback", {
      exists: meta.exists,
      bytes: meta.bytes,
      updatedAt: meta.updatedAt,
      entries: meta.entries,
    });
  } catch {
    // The bus never throws into callers by contract; this belt costs one
    // line and keeps the append path total.
  }
}

/**
 * Append ONE whole entry (the caller-assembled markdown block, starting
 * with its "## Entry — " header). Creates the file with the fixed header
 * when absent. Returns the append promise so callers can await their own
 * write (tests do); production fire-and-forgets it via the chain.
 */
export function appendFeedbackEntry(dataDir: string, entryMarkdown: string): Promise<void> {
  const run = async (): Promise<void> => {
    const path = feedbackLedgerPath(dataDir);
    if (!existsSync(path)) {
      writeFileSync(path, FEEDBACK_LEDGER_HEADER, { encoding: "utf8" });
    }
    // The separator keeps entries visually distinct in the raw file; the
    // leading newline guarantees the header's last line never fuses with
    // the first entry when the file was just created.
    await appendFile(path, `\n---\n\n${entryMarkdown.trimEnd()}\n`, { encoding: "utf8" });
  };
  const next = ledgerWriteChain.then(run, run);
  // Absorb a failed write into the chain itself: the NEXT append must
  // still run (one ENOSPC moment must not kill the ledger forever), and
  // the caller's await must surface THIS write's failure.
  ledgerWriteChain = next.catch(() => {});
  return next.finally(() => {
    publishLedgerFrame(dataDir);
  });
}

/**
 * Delete the ledger (the settings viewer's Clear action — DESKTOP token
 * only; the device-token blocklist guards the route). Returns the entry
 * count that was wiped, for the honest confirmation line. Serialized on
 * the same chain so a concurrent append lands AFTER the clear (never
 * half-wiped).
 */
export function clearFeedbackLedger(dataDir: string): Promise<{ entries: number }> {
  const run = async (): Promise<{ entries: number }> => {
    const path = feedbackLedgerPath(dataDir);
    const before = readFeedbackLedger(dataDir);
    if (before.exists) {
      unlinkSync(path);
    }
    return { entries: before.entries };
  };
  const next = ledgerWriteChain.then(run, run);
  ledgerWriteChain = next.then(
    () => {},
    () => {},
  );
  return next.finally(() => {
    publishLedgerFrame(dataDir);
  });
}
