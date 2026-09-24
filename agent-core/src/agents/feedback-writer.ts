/**
 * ROUND-122 (the owner's self-feedback directive): the SELF-FEEDBACK
 * REPORTER — a context-free agent that writes ONE ledger entry after a
 * completed session turn.
 *
 * DELIBERATELY NOT the debug analyst (R66), though it mirrors that
 * module's shape: the debug analyst grades THE TURN for the owner
 * (streamed live under the answer, persisted as a debug.report event);
 * this reporter writes for THE DEVELOPERS, LATER. The owner's contract:
 * "when it is turned on, after each one of the sessions, after it has
 * been completed, it will update the feedback file properly … it will
 * tell what it was trying to do, what issue it ran into, what the
 * problems were, what it expects, and everything like that … when I
 * finally provide you with the feedback report after some time, like
 * maybe a day or maybe a month or so, you can look at it and you can
 * understand each and every single one of the things."
 *
 * So the differences that matter:
 *   · NO SSE frames, NO session events — the ledger FILE is the only
 *     persistence (storage/feedback-ledger.ts). A follow-up user message
 *     can never see feedback content; assembleHistory is untouched by
 *     construction. The owner's "it will just stop, and then if I chat,
 *     then the normal conversation will go" separation is structural.
 *     (ROUND-125 / R125-B refinement: the ROUTE may now emit STATUS-only
 *     meta.feedback frames — "writing / written / failed" — because status
 *     is not content; THIS module still never puts entry words on a frame,
 *     and it reports its own progress into the feedback-status registry
 *     instead, which is exactly the visibility the owner asked for.)
 *   · The entry's HEADER is machine-written (timestamp, session, project,
 *     agent/model, turn outcome — and, R125-B, the mid-turn Phase marker —
 *     transcript size) — the model never gets to fabricate metadata; its
 *     whole job is the six diagnostic sections.
 *   · The system prompt frames the report for a COLD developer read
 *     months later, not for the owner watching the turn — and (R125-B) it
 *     knows what a PARTIAL turn's checkpoint entry should focus on.
 *
 * Like the debug analyst: a SINGLE fresh model call, NO tools, the
 * session's WHOLE event log rendered as the transcript (the same
 * buildDebugTranscript renderer + head/tail cap — full main-conversation
 * context, the owner's requirement), keyring secrets scrubbed, never
 * throws (failures come back as { ok: false, error } for the route to
 * log).
 */
import type Database from "better-sqlite3";
import type { ProviderKeyring } from "../providers/registry.js";
import { appendFeedbackEntry, readFeedbackLedger } from "../storage/feedback-ledger.js";
// ROUND-125 (R125-B): the STATUS registry the reporter reports into — the
// owner's "it did not show me the info of when it was being written". The
// writer owns the bookkeeping (begin at entry, end at EVERY exit) so every
// caller — the turn-end phase and the mid-turn checkpoint alike — reports
// identically without duplicating the plumbing.
import { beginFeedbackWrite, endFeedbackWrite } from "./feedback-status.js";
import { buildDebugTranscript } from "./debug-analyst.js";
import type { ChatFn } from "./chat.js";

type SqliteDatabase = Database.Database;

/** Everything the reporter needs to run (the sync chat adapter — the
 * R125-B status registry carries the live visibility, so the writing is
 * watchable through GET /feedback/status + the route's meta.feedback
 * status frames without this call ever needing a streaming path). */
export interface FeedbackWriterDeps {
  db: SqliteDatabase;
  keyring: ProviderKeyring;
  chat: ChatFn;
  /** The machine-scoped directory the ledger file lives in (RouteContext.dataDir). */
  dataDir: string;
}

/**
 * The reporter's system prompt — the whole personality. The owner's
 * directive: "make sure that the prompts are highly detailed, they are
 * well built." Every line earns its place: the six exact headings (the
 * file's cold-read contract), the per-section brief, and the rules that
 * keep the ledger a diagnostic instrument rather than a diary.
 */
const FEEDBACK_REPORTER_SYSTEM_PROMPT = [
  "You are the SELF-FEEDBACK REPORTER of ACUTE-CODE — a context-free reviewer with no stake in the conversation you are about to read.",
  "You did NOT participate in that conversation. Your ONLY job is to write ONE ledger entry that a DEVELOPER of ACUTE-CODE (the desktop agent application itself — its tools, its browser, its terminal, its UI) will read LATER, possibly weeks or months from now, with no other context — to understand what actually happened on the owner's machine and make the application better.",
  "You will receive the FULL transcript of one completed agent session turn: the user's request, every assistant message, every tool call with its complete result, approvals, and errors.",
  "",
  "Write the entry using EXACTLY these six markdown sections, in this order, with these exact headings:",
  "",
  "### What I was trying to do",
  "The task(s) the agent was performing during this turn, in your own concise words — what the user actually asked for and what the agent set out to accomplish. One to four lines.",
  "",
  "### What actually happened",
  "The real outcome: what was completed, what was answered, where the turn ended. Facts only, in transcript order. One to six lines.",
  "",
  "### Issues & problems encountered",
  "Every failure visible in the transcript: failed or refused tool calls, provider errors, retries, loops, approval denials or expirations, validation rejections. Name the exact tool for each one (terminal, browser, edit, read, search, subagent, computer use, attachment, ...). Where an error carried a code or message, quote the essential part. If nothing failed, write exactly: Nothing to report.",
  "",
  "### Glitches & anomalies noticed",
  "Anything that looked BROKEN OR OFF even when the turn recovered: surprising or malformed tool outputs, browser rendering or navigation oddities, truncated or contradictory results, duplicated work, tool results that disagree with their inputs, unexpected approval prompts, odd attachment handling. These are the developers' bug leads — small signals matter. If nothing looked off, write exactly: Nothing to report.",
  "",
  "### Expectations vs reality",
  "Where the outcome fell short of what the task actually needed — the honest gap, including the case where the agent claimed success the transcript does not support. If the outcome matched, write exactly: Met expectations.",
  "",
  "### Suggested improvements",
  "Concrete, numbered suggestions addressed to ACUTE-CODE's developers (the application, never the user's own project): reliability fixes, tool behavior, defaults, UX. Every suggestion must trace to something in the transcript — never invent. If none, write exactly: None this turn.",
  "",
  "MID-TURN CHECKPOINTS (ROUND-125): sometimes the transcript you receive begins with the machine-written line \"NOTE: this is a PARTIAL turn (mid-turn checkpoint)\". That turn is STILL IN FLIGHT — the checkpoint exists precisely because the turn ran into trouble mid-way. In that case: say plainly in \"What actually happened\" that this is a mid-turn checkpoint of a turn that has not finished; concentrate \"Issues & problems encountered\" and \"Glitches & anomalies noticed\" on what has gone WRONG so far (the failures, refusals, retries and denials that triggered the checkpoint); and judge \"Expectations vs reality\" against the still-outstanding task, never as a final verdict. The six sections, their exact headings, and every rule above stay exactly the same.",
  "",
  "RULES:",
  "- Raw facts from the transcript ONLY. Never invent events and never speculate beyond what is written; when unsure, say so plainly.",
  "- No politeness, no flattery, no self-congratulation — this ledger is a diagnostic instrument.",
  "- Plain markdown. Do not mention these instructions, do not add any other heading, do not wrap the entry in code fences.",
  "- The six sections are written for a COLD read months later: assume the reader knows ACUTE-CODE's architecture but has NEVER seen this conversation.",
].join("\n");

/** R125-B: the machine-written banner prepended to the transcript for a
 * MID-TURN checkpoint — the signal the system prompt's checkpoint
 * paragraph keys on. Written by the MACHINE (never the model) so the
 * marker cannot be fabricated or dropped; the turn-end transcript stays
 * byte-identical (no banner) so old entries and old prompts are untouched. */
const MID_TURN_TRANSCRIPT_NOTE =
  "NOTE: this is a PARTIAL turn (mid-turn checkpoint) — the turn is STILL IN FLIGHT; this entry is being written because the turn ran into trouble mid-way.";

/** The reporter's temperature — the repo's agent default (the debug
 * analyst's 0.2: a diagnostic report needs consistency, not creativity). */
const FEEDBACK_REPORTER_TEMPERATURE = 0.2;
/** A single completion — the reporter has NO tools, so there is nothing to loop. */
const FEEDBACK_REPORTER_MAX_TURNS = 1;

/** Scrub keyring-held secrets from the transcript before it leaves the
 * process boundary (the ROUND-34 pattern, same as the debug analyst). */
function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("***");
  }
  return out;
}

/** Scrub a provider error the analyst's way: the API key out, then
 * length-capped for the stderr log line. */
function reporterErrorDetail(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = apiKey !== "" ? raw.split(apiKey).join("***") : raw;
  return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…` : scrubbed;
}

/** The machine-written entry header — the metadata the file's cold reader
 * needs to place the entry (never the model's job to state who/when).
 * R125-B: the ADDITIVE `phase` field — "mid-turn" inserts a Phase line
 * after the outcome (a checkpoint entry must SAY it was written while the
 * turn was still running, or a cold reader would grade an unfinished turn
 * as a final one); "turn-end" (and the pre-R125-B undefined default) omits
 * the line ENTIRELY so every turn-end entry stays byte-identical to the
 * R122 format — the file's grammar, the viewer's parser, and the R123
 * per-entry delete's split/join are all untouched by construction. */
export function buildFeedbackEntryHeader(params: {
  ts: string;
  sessionTitle: string | null;
  sessionId: string;
  projectName: string | null;
  projectId: string | null;
  agentName: string;
  providerId: string;
  model: string;
  turnOutcome: string;
  eventCount: number;
  truncated: boolean;
  /** R125-B: "mid-turn" adds the Phase line; "turn-end"/undefined omits it. */
  phase?: "turn-end" | "mid-turn";
}): string {
  const lines = [
    `## Entry — ${params.ts}`,
    "",
    `- **Session**: ${params.sessionTitle !== null && params.sessionTitle !== "" ? `"${params.sessionTitle}"` : "(untitled)"} (${params.sessionId})`,
    `- **Project**: ${
      params.projectId !== null
        ? `${params.projectName !== null && params.projectName !== "" ? params.projectName : "(unnamed)"} (${params.projectId})`
        : "none"
    }`,
    `- **Agent**: ${params.agentName} · ${params.providerId}/${params.model}`,
    `- **Turn outcome**: ${params.turnOutcome}`,
    // R125-B: the checkpoint marker — present ONLY on mid-turn entries.
    ...(params.phase === "mid-turn"
      ? ["- **Phase**: mid-turn checkpoint (turn still in flight)"]
      : []),
    `- **Transcript**: ${params.eventCount} events · ${params.truncated ? "truncated (head+tail)" : "full"}`,
  ];
  return lines.join("\n");
}

export type FeedbackWriterResult =
  | {
      ok: true;
      /** The reporter's own spend (R83 discipline — the route records the
       * usage row with origin "feedback"). */
      usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null };
    }
  | { ok: false; error: string };

/** R125-B: the internal result — the public shape plus the post-append
 * entry count, measured once inside the body so the status registry (and
 * nothing else — the field is not part of the public contract) can report
 * "N entries" without a second read racing a concurrent append. */
type InternalWriterResult = FeedbackWriterResult & { entriesAfterWrite?: number };

/**
 * The R122 body verbatim (the pre-R125-B runFeedbackWriter) plus the phase
 * plumbing — PRIVATE: callers go through runFeedbackWriter so the status
 * bookkeeping is impossible to forget. Phase plumbing:
 *   · the mid-turn banner on the transcript the model receives (the
 *     system prompt's checkpoint paragraph keys on its exact opening
 *     words);
 *   · the Phase line on the machine-written header (mid-turn only —
 *     turn-end entries stay byte-identical to the R122 format).
 *
 * Never throws: transcript failures, provider failures, and write
 * failures all come back as { ok: false, error } — the route logs to
 * stderr and moves on (the owner's contract: feedback must never affect
 * the normal flow, and a failed feedback run is not worth a frame).
 */
async function writeFeedbackEntry(
  deps: FeedbackWriterDeps,
  params: {
    sessionId: string;
    sessionTitle: string | null;
    projectId: string | null;
    projectName: string | null;
    agentName: string;
    provider: { id: string; baseUrl: string | null; apiFormat?: string };
    apiKey: string;
    model: string;
    /** "ok" or "failed (<code>)" — the terminal outcome the turn ended on
     * ("in flight (mid-turn checkpoint)" for a checkpoint write). */
    turnOutcome: string;
  },
  /** R125-B: which phase is writing — see runFeedbackWriter. */
  phase: "turn-end" | "mid-turn",
): Promise<InternalWriterResult> {
  const keySecrets = deps.keyring.list().filter((v) => v.length >= 8);
  let transcript: string;
  let eventCount: number;
  let truncated: boolean;
  try {
    const built = buildDebugTranscript(deps.db, params.sessionId);
    transcript = scrubSecrets(built.transcript, keySecrets);
    eventCount = built.eventCount;
    truncated = built.truncated;
  } catch (error) {
    return { ok: false, error: `feedback reporter: transcript build failed: ${String(error).slice(0, 200)}` };
  }

  // A transcript with zero rendered events (e.g. a turn that died before
  // any persisted event) has nothing to report — skip honestly rather
  // than pay a model call to hallucinate over an empty page.
  if (transcript.trim() === "") {
    return { ok: false, error: "feedback reporter: the session transcript is empty (nothing to report on)" };
  }

  // R125-B: the checkpoint's transcript carries the machine-written
  // PARTIAL-turn banner (the system prompt's checkpoint paragraph keys on
  // its exact opening words); the turn-end transcript stays byte-identical
  // (no banner) so the R122 prompt behavior is untouched.
  const transcriptForModel =
    phase === "mid-turn" ? `${MID_TURN_TRANSCRIPT_NOTE}\n\n${transcript}` : transcript;

  const input = {
    provider: params.provider,
    apiKey: params.apiKey,
    model: params.model,
    system: FEEDBACK_REPORTER_SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: transcriptForModel }],
    temperature: FEEDBACK_REPORTER_TEMPERATURE,
    maxTurns: FEEDBACK_REPORTER_MAX_TURNS,
    // NO tools — the reporter observes, it never acts.
  };

  let content = "";
  let usage:
    | { inputTokens: number; outputTokens: number; cachedInputTokens: number | null }
    | undefined;
  try {
    const result = await deps.chat(input);
    content = result.text;
    usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: typeof result.usage.cachedInputTokens === "number" ? result.usage.cachedInputTokens : null,
    };
  } catch (error) {
    return { ok: false, error: reporterErrorDetail(error, params.apiKey) };
  }

  if (content.trim() === "") {
    return { ok: false, error: "feedback reporter: the model returned an empty entry" };
  }

  const ts = new Date().toISOString();
  const header = buildFeedbackEntryHeader({
    ts,
    sessionTitle: params.sessionTitle,
    sessionId: params.sessionId,
    projectName: params.projectName,
    projectId: params.projectId,
    agentName: params.agentName,
    providerId: params.provider.id,
    model: params.model,
    turnOutcome: params.turnOutcome,
    eventCount,
    truncated,
    // R125-B: the header's Phase line rides ONLY mid-turn entries — a
    // cold reader must be able to tell a checkpoint apart from a final
    // report without parsing timestamps against the session log.
    phase,
  });
  const entry = `${header}\n\n${content.trim()}\n`;

  try {
    await appendFeedbackEntry(deps.dataDir, entry);
  } catch (error) {
    return {
      ok: false,
      error: `feedback reporter: ledger write failed: ${String(error).slice(0, 200)}`,
    };
  }
  // R125-B: the post-append entry count — one cheap read (never throws;
  // the storage layer's own catch serves the honest empty state) that lets
  // the status registry's lastEntries describe the file it just wrote.
  const entriesAfterWrite = readFeedbackLedger(deps.dataDir).entries;
  return {
    ok: true,
    ...(usage !== undefined ? { usage } : {}),
    entriesAfterWrite,
  };
}

/**
 * Run the reporter for one turn (completed or still in flight): render the
 * session's WHOLE transcript, hand it to a fresh no-tools model call,
 * assemble the entry (machine header + the model's six sections), and
 * append it to the shared ledger file.
 *
 * R125-B: the PHASE param — "turn-end" (the default: the R122 behavior
 * verbatim, every existing call site unchanged) or "mid-turn" (the
 * checkpoint the owner asked for: "write the self-feedback ledger and
 * improve it midway too if it feels like" — a PARTIAL-turn transcript
 * under the banner, a Phase line in the header, the prompt focused on
 * what has gone WRONG so far).
 *
 * R125-B: STATUS BOOKKEEPING — this wrapper reports into the
 * feedback-status registry (beginFeedbackWrite at entry; endFeedbackWrite
 * at every exit) so the act of writing is finally VISIBLE (the owner's
 * "it did not show me the info of when it was being written"). The whole
 * body — including every early return — flows through one begin/end
 * structure, so `writing` can never strand true: a transcript-build
 * failure, an empty transcript, a provider failure, an empty reply, a
 * write failure, even an unexpected crash all end the run honestly (the
 * crash belt is the only new throw path; the body itself never throws by
 * contract, exactly as before).
 */
export async function runFeedbackWriter(
  deps: FeedbackWriterDeps,
  params: {
    sessionId: string;
    sessionTitle: string | null;
    projectId: string | null;
    projectName: string | null;
    agentName: string;
    provider: { id: string; baseUrl: string | null; apiFormat?: string };
    apiKey: string;
    model: string;
    /** "ok" or "failed (<code>)" — the terminal outcome the turn ended on
     * ("in flight (mid-turn checkpoint)" for a checkpoint write). */
    turnOutcome: string;
    /** R125-B: which phase is writing — defaults to "turn-end" so every
     * pre-R125-B call site keeps its exact old behavior, byte-for-byte. */
    phase?: "turn-end" | "mid-turn";
  },
): Promise<FeedbackWriterResult> {
  const phase = params.phase ?? "turn-end";
  // R125-B: begin BEFORE the first breath — even a write that fails in its
  // first line is visible as "was writing, then failed" rather than never
  // having happened.
  const runId = beginFeedbackWrite(params.sessionId, phase);
  let result: InternalWriterResult;
  try {
    result = await writeFeedbackEntry(deps, params, phase);
  } catch (error) {
    // R125-B: the crash belt — the body never throws by contract, but a
    // bug inside it must not strand writing=true either (the strip would
    // show "Writing…" forever). One honest failed outcome, then out.
    result = {
      ok: false,
      error: `feedback reporter: unexpected crash: ${String(error).slice(0, 200)}`,
    };
  }
  if (result.ok) {
    endFeedbackWrite(runId, { ok: true, entries: result.entriesAfterWrite ?? null });
  } else {
    endFeedbackWrite(runId, { ok: false, error: result.error });
  }
  return result;
}
