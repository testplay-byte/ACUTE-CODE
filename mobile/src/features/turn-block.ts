/**
 * turn-block.ts — ROUND-119 (R119-A): the §N center-section rethink's PURE
 * display layer. The owner's verdict on v0.112.0's session center —
 * thinking / tool call / failed tool call "each get a proper card of
 * itself, which makes the whole interface bad… everything looks ugly" —
 * dies HERE, in the display math: one visual TURN per exchange. The fold
 * and the live reducer keep emitting the same `TranscriptItem` stream
 * (kinds, order, contracts untouched — the persisted-fold/live-reducer
 * tests keep their pins); this module PARTITIONS that stream into the
 * rendered rows:
 *
 *   · `orderDisplayItems` — the QUEUED-POSITION LAW (round-119 §1 item 7):
 *     every STILL-QUEUED user row (the live `q${seq}` rows, the folded
 *     `message.queued` rows, the outbox rows) renders AFTER everything
 *     else — in particular after the in-progress turn's items and the
 *     synthetic thinking marker — never above the "currently processing"
 *     section. Stable + idempotent; delivered rows never move.
 *   · `groupDisplayRows` — the TURN PARTITION: runs of consecutive
 *     assistant/thinking/tool items fold into ONE `TurnGroup` (the
 *     TurnBlock's data); every other kind (user / error / approval /
 *     question / todo / subagent / image / meta / debug — the interactive
 *     and terminal surfaces) splits the run and renders as its own row.
 *     The group's key is its FIRST item's key, so the inverted FlatList's
 *     recycling stays stable across frames.
 *   · `activitySummary` / `turnBlockA11yLabel` — the collapsed rail's
 *     summary strings and the block's one container label, PURE so jest
 *     can pin them ("Thought for 8s · 3 actions").
 *   · the tool-line word helpers (`runningToolWord`, `writePath`, …) —
 *     moved from transcript.tsx (they were module-private); the rail's
 *     live verb and the well's rows share them.
 *
 * Pure TypeScript, zero React Native — unit-tested directly.
 */

import type { ToolActivity } from "@/design/theme";
import {
  extractWritePreview,
  READ_TOOLS,
  TERMINAL_TOOLS,
  WRITE_TOOLS,
} from "./streaming-args";
import type { TranscriptItem } from "./sessions";

// ── the tool-line helpers (moved from transcript.tsx, verbatim logic) ───────

/** The tool item's narrowed shape (the rows' + the words' input). */
export type ToolItem = TranscriptItem & { kind: "tool" };

/** "run_command" → "run command" (the humanized name the rows lead with). */
export function humanizeToolName(name: string): string {
  return name.replace(/_/g, " ");
}

/** The write row's file path: the streaming raw's `path` arg first (the
 * tolerant extractor — live, before the args complete), else the settled
 * argsSummary's `path: …` segment. */
export function writePath(item: ToolItem): string | null {
  if (item.inputRaw !== null) {
    const preview = extractWritePreview(item.inputRaw);
    if (preview.path !== null) return preview.path;
  }
  return item.argsSummary.match(/^path:\s*([^,]+)/)?.[1] ?? null;
}

/**
 * R116-m — the settled WRITE row's +A/−B line counts, parsed from the
 * server's own edit confirmation (agent-core fs-ops.ts editConfirmation):
 *   "Edited '<path>': 2 replacements, +12 −3 lines"
 * The minus is U+2212 (−, the REAL server glyph — verified against the
 * source; an ASCII hyphen never rides this wire), the plus is ASCII, and
 * the "N replacements, " prefix + " lines" suffix pin the shape so a
 * lookalike string never lies. Plain writes ("wrote N bytes to '<path>'")
 * and every failure shape miss the pattern → null → NO chips (the byte
 * summary line below carries that story) — the PC's toolStatusDetail
 * twin, honestly tolerant of both output shapes.
 */
const EDIT_LINE_DIFF_RE = /(\d+) replacements?, \+(\d+) \u2212(\d+) lines/;

/** The settled row's parsed line delta (null while running / failed / a
 * plain write — only a SETTLED, SUCCEEDED call whose summary parsed answers;
 * a failed call never wears success-tinted +A chips). */
export function writeLineDiff(item: ToolItem): { added: number; removed: number } | null {
  if (item.ok !== true || item.outputSummary === null) return null;
  const match = EDIT_LINE_DIFF_RE.exec(item.outputSummary);
  if (match === null) return null;
  return { added: Number(match[2]), removed: Number(match[3]) };
}

/** The one-line summary the collapsed generic row shows. */
export function genericOneLineSummary(item: ToolItem): string {
  if (TERMINAL_TOOLS.has(item.toolName)) {
    return item.argsSummary.match(/^command:\s*(.*)$/)?.[1] ?? item.argsSummary;
  }
  return item.argsSummary;
}

/** The read family's one-line target: the argsSummary's first "key: value"
 * segment, key stripped ("path: src/a.ts" → "src/a.ts"). */
export function readTargetSegment(item: ToolItem): string {
  const segment = item.argsSummary.split(",")[0] ?? "";
  return segment.replace(/^[a-zA-Z_]+:\s*/, "").trim();
}

/**
 * R119-A — the rail's LIVE verb while a tool runs ("Reading src/a.ts…"),
 * the one line the collapsed rail breathes (never the thinking card AND a
 * tool card — ONE line). The write family keeps its "Writing {file}…"
 * grammar, the terminal family leads with its command, the read family
 * with its target, everything else the humanized verb.
 */
export function runningToolWord(item: ToolItem): string {
  if (WRITE_TOOLS.has(item.toolName)) {
    const path = writePath(item);
    const verb = item.toolName === "write_file" ? "Writing" : "Editing";
    return path !== null ? `${verb} ${path}…` : `${verb}…`;
  }
  if (TERMINAL_TOOLS.has(item.toolName)) {
    const command = genericOneLineSummary(item);
    return command !== "" ? `Running ${command}…` : "Running…";
  }
  if (READ_TOOLS.has(item.toolName)) {
    const target = readTargetSegment(item);
    return target !== "" ? `Reading ${target}…` : "Reading…";
  }
  return `${humanizeToolName(item.toolName)}…`;
}

// ── the turn partition (the display-layer grouping) ─────────────────────────

/** The item kinds that belong to a TURN BLOCK — everything the assistant
 * stream emits between two boundaries. Every other kind (user / error /
 * approval / question / todo / subagent / image / meta / debug) splits the
 * run: those are the interactive + terminal surfaces, not narration. */
const TURN_ITEM_KINDS: ReadonlySet<string> = new Set(["assistant", "thinking", "tool"]);

/** One member of a turn group (the narrowed union the block renders). */
export type TurnItem =
  | (TranscriptItem & { kind: "assistant" })
  | (TranscriptItem & { kind: "thinking" })
  | ToolItem;

/** The standalone kinds the grouping passes through untouched (the
 * TranscriptItem union minus the three turn kinds — the item rows' type). */
export type StandaloneTranscriptItem = Exclude<
  TranscriptItem,
  { kind: "assistant" } | { kind: "thinking" } | { kind: "tool" }
>;

/**
 * ONE TURN — the TurnBlock's data: the consecutive assistant/thinking/tool
 * items of one exchange, plus the display flags the block derives its
 * anatomy from (all pure, all computed at group time so the component stays
 * a renderer and the tests can pin the partition).
 */
export interface TurnGroup {
  kind: "turn";
  /** The group's key = its FIRST item's existing key — stable across
   * frames, so the inverted FlatList's recycling stays correct. */
  key: string;
  /** The turn's items in emission order. */
  items: TurnItem[];
  /** The turn is IN PROGRESS (a live member, or the pending marker). */
  live: boolean;
  /** The synthetic thinking marker is a member — the pre-first-delta
   * breathing state (thinkingPlaceholderVisible's verdict, moved here). */
  pending: boolean;
  /** The turn's resolved model (the marker's own, or the first assistant
   * item's — null when neither carried one; never a guess). */
  model: string | null;
}

/** One rendered row: a TURN BLOCK, or a standalone item card. */
export type DisplayRow =
  | TurnGroup
  | { kind: "item"; key: string; item: StandaloneTranscriptItem };

/**
 * Partition the (ordered) item stream into display rows. Pure +
 * order-preserving: a run of consecutive turn-kind items becomes ONE
 * TurnGroup; every other item becomes its own row in place. The ITEM MODEL
 * is untouched — the fold and the live reducer keep their emission
 * contracts; this is the display layer only.
 */
export function groupDisplayRows(items: TranscriptItem[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let run: TurnItem[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    rows.push(turnGroupOf(run));
    run = [];
  };
  for (const item of items) {
    if (TURN_ITEM_KINDS.has(item.kind)) {
      run.push(item as TurnItem);
      continue;
    }
    flushRun();
    rows.push({ kind: "item", key: item.key, item: item as StandaloneTranscriptItem });
  }
  flushRun();
  return rows;
}

/** Build one group off a completed run (module-private — the shape is pinned
 * through groupDisplayRows). */
function turnGroupOf(run: TurnItem[]): TurnGroup {
  const first = run[0];
  if (first === undefined) throw new Error("turnGroupOf: empty run");
  const pending = run.some((item) => item.kind === "thinking");
  const live =
    pending ||
    run.some((item) => (item.kind === "assistant" || item.kind === "tool") && item.live);
  let model: string | null = null;
  for (const item of run) {
    if (item.kind === "thinking" && item.model !== null) {
      model = item.model;
      break;
    }
    if (item.kind === "assistant" && item.model !== null) {
      model = item.model;
      break;
    }
  }
  return { kind: "turn", key: first.key, items: run, live, pending, model };
}

// ── the queued-position law (round-119 §1 item 7) ───────────────────────────

/**
 * R119-A — THE QUEUED-AFTER-TURN LAW: every STILL-QUEUED user row moves to
 * the END of the display list (order among them preserved), so a waiting
 * message renders AFTER the in-progress turn — whose synthetic processing
 * state (the thinking marker) now lives INSIDE the TurnBlock — never above
 * it. Covers all three producers: the live `q${seq}` rows (already at the
 * tail — idempotent), the folded `message.queued` rows (their log position
 * is early — right after the last persisted event), and the outbox rows
 * (appended last while no overlay). A DELIVERED row (`queued: false` — the
 * log flips message.queued → message.user IN PLACE) never moves. Pure +
 * stable + idempotent; the reference is returned untouched when nothing
 * moves (the memo's cheap path).
 */
export function orderDisplayItems(items: TranscriptItem[]): TranscriptItem[] {
  const queued: TranscriptItem[] = [];
  const rest: TranscriptItem[] = [];
  for (const item of items) {
    if (item.kind === "user" && item.queued) queued.push(item);
    else rest.push(item);
  }
  if (queued.length === 0) return items;
  return [...rest, ...queued];
}

// ── the rail's summary strings (pure, pinned) ───────────────────────────────

/**
 * The collapsed rail's FACTS — everything `activitySummary` and
 * `turnBlockA11yLabel` read, pre-shaped by `turnActivityFacts` (which
 * applies the toolActivity pref: with `hidden` the tool rows are invisible,
 * so the summary must not tease a count the well will not show).
 */
export interface TurnActivityFacts {
  /** The turn's measured thinking time (the folded events' additive
   * `thinkingMs`, summed). null = the wire carried none (older sidecars,
   * thinking-less turns) — the rail reads the plain "Thought" word. */
  thoughtMs: number | null;
  /** The turn carries thinking TEXT (the well has a thinking section). */
  hasThinking: boolean;
  /** The tool calls the well renders (pref-applied: 0 when hidden). */
  toolCount: number;
  /** The FAILED calls among them (pref-applied the same way). */
  failedCount: number;
  /** The block is the in-progress turn. */
  live: boolean;
  /** While live: the running tool's one-line verb ("Reading src/a.ts…"),
   * null when no call is running. */
  runningToolWord: string | null;
  /** While live: the reply's text has started streaming. */
  writing: boolean;
}

/** The turn's thinking text — the assistant members' `thinking` segments
 * joined (they are segments of one reasoning stream), null when none. A
 * BLANK segment is none (the fold's own normalization law — never a
 * whitespace-only well). */
export function turnThinkingText(items: TurnItem[]): string | null {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === "assistant" && item.thinking !== null && item.thinking.trim() !== "") {
      parts.push(item.thinking);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/** The turn's measured thinking time — the assistant members' additive
 * `thinkingMs` summed (each segment carries its own measured span). null
 * when the wire carried none. */
export function turnThoughtMs(items: TurnItem[]): number | null {
  let total = 0;
  let any = false;
  for (const item of items) {
    if (item.kind === "assistant" && item.thinkingMs !== null && item.thinkingMs !== undefined) {
      total += item.thinkingMs;
      any = true;
    }
  }
  return any ? total : null;
}

/** The reply's plain text (the a11y preview's source): the assistant
 * members' live chunks or settled content, joined with a space. */
export function turnReplyText(items: TurnItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind !== "assistant") continue;
    const live = item.live && item.chunks !== null ? item.chunks.join("") : "";
    const text = live !== "" ? live : item.content;
    if (text !== "") parts.push(text);
  }
  return parts.join(" ");
}

/**
 * Derive the rail's facts off a group + the toolActivity pref (the single
 * place the pref shapes the SUMMARY — the well's rows apply it again at
 * render time through the same vocabulary). With `hidden` the tool rows
 * are invisible, so the counts read 0: the summary never teases content
 * the block will not show (the "clean document" verdict).
 */
export function turnActivityFacts(group: TurnGroup, activity: ToolActivity): TurnActivityFacts {
  const toolsHidden = activity === "hidden";
  const tools: ToolItem[] = [];
  if (!toolsHidden) {
    for (const item of group.items) {
      if (item.kind === "tool") tools.push(item);
    }
  }
  const runningTool = [...tools].reverse().find((item) => item.ok === null);
  return {
    thoughtMs: turnThoughtMs(group.items),
    hasThinking: turnThinkingText(group.items) !== null,
    toolCount: tools.length,
    failedCount: tools.filter((item) => item.ok === false).length,
    live: group.live,
    runningToolWord:
      group.live && runningTool !== undefined ? runningToolWord(runningTool) : null,
    writing: group.live && turnReplyText(group.items) !== "",
  };
}

/** The measured seconds label's floor — the PC's own formula
 * (WorkingSection: Math.max(1, Math.round(ms / 1000))). */
function thoughtSeconds(thoughtMs: number): number {
  return Math.max(1, Math.round(thoughtMs / 1000));
}

/**
 * The collapsed rail's ONE line (pure — the spec's own examples):
 *   · live  — the running tool's verb ("Reading src/a.ts…"), else
 *             "Writing…" once text streams, else the breathing
 *             "Thinking…" (the pre-first-delta state and the
 *             thinking-streaming state share the word).
 *   · settled — "Thought for 8s · 3 actions" / "Thought for 8s" when no
 *             tools / "3 actions" when no thinking / "Thought" when the
 *             wire carried no measured span (the PC's fallback word) /
 *             "· N failed" appended when calls failed (visible at a
 *             glance while collapsed). null when the turn has NO activity
 *             at all (no thinking text, no tools) — the block renders as
 *             the clean document, no rail.
 */
export function activitySummary(facts: TurnActivityFacts): string | null {
  if (facts.live) {
    if (facts.runningToolWord !== null) return facts.runningToolWord;
    if (facts.writing) return "Writing…";
    return "Thinking…";
  }
  const segments: string[] = [];
  if (facts.hasThinking) {
    segments.push(
      facts.thoughtMs !== null ? `Thought for ${thoughtSeconds(facts.thoughtMs)}s` : "Thought",
    );
  }
  if (facts.toolCount > 0) {
    segments.push(`${facts.toolCount} action${facts.toolCount === 1 ? "" : "s"}`);
  }
  if (facts.failedCount > 0) {
    segments.push(`${facts.failedCount} failed`);
  }
  return segments.length > 0 ? segments.join(" · ") : null;
}

/** The a11y preview's budget (chars) — one honest clause, never the wall. */
const A11Y_REPLY_CHARS = 60;

/** The reply's one-line preview for the container label (whitespace
 * collapsed, tail-ellipsized); null when the turn has no text. */
function replyPreview(replyText: string): string | null {
  const flat = replyText.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  return flat.length > A11Y_REPLY_CHARS ? `${flat.slice(0, A11Y_REPLY_CHARS)}…` : flat;
}

/**
 * The TurnBlock's ONE accessible container label — simple and honest (the
 * spec's "assistant turn: thought 8 seconds, 3 actions, reply …"):
 *   · live — "Assistant turn — thinking" / the running verb / "writing".
 *   · settled — "Assistant turn — thought 8 seconds, 3 actions" (+
 *             "N failed" when calls failed), "Assistant reply" when the
 *             turn carries no activity at all.
 *   · the reply rides as a final "Reply: {≤60 chars}" clause when present.
 */
export function turnBlockA11yLabel(input: TurnActivityFacts & { replyText: string }): string {
  const reply = replyPreview(input.replyText);
  let head: string;
  if (input.live) {
    const word =
      input.runningToolWord !== null ? input.runningToolWord : input.writing ? "writing" : "thinking";
    head = `Assistant turn — ${word}`;
  } else {
    const words: string[] = [];
    if (input.hasThinking) {
      words.push(
        input.thoughtMs !== null ? `thought ${thoughtSeconds(input.thoughtMs)} seconds` : "thought",
      );
    }
    if (input.toolCount > 0) {
      words.push(`${input.toolCount} action${input.toolCount === 1 ? "" : "s"}`);
    }
    if (input.failedCount > 0) {
      words.push(`${input.failedCount} failed`);
    }
    head = words.length > 0 ? `Assistant turn — ${words.join(", ")}` : "Assistant reply";
  }
  return reply === null ? head : `${head}. Reply: ${reply}`;
}
