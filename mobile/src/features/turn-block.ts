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
 *   · `toolHint` / `toolHintList` — ROUND-120 (R120-CM, §1 item 40): the
 *     collapsed rail's TOOL HINTS. The owner's verdict on the mobile center
 *     — "file edits, created files, tool/command hints" were not shown; the
 *     collapsed rail carried only "3 actions", so a settled turn told the
 *     owner NOTHING about what ran. The summary line now carries the honest
 *     glance — the write family's file paths, the terminal family's
 *     commands, the read family's targets — deduped, capped, riding BOTH
 *     the visual rail and the a11y label. The well (one tap away) keeps
 *     the full rows; the hint is the collapsed state's honest teaser,
 *     never a replacement.
 *
 * ROUND-123 (R123-W-m — the mobile transcript redesign): the web families
 * join the grammar. browser_control / web_search / web_fetch are tools the
 * agent ACTUALLY runs, and the generic row rendered their raw key:value
 * argsSummary verbatim ("action: navigate, url: …") — the shapeless
 * rendering behind the owner's "no tool calls were shown to me". The new
 * `webTargetSegment` (query/url) and `browserTargetSegment` (action +url)
 * feed the SAME three surfaces every family speaks — `toolRowTitle`,
 * `runningToolWord`, `toolHint` — live off the streaming raw (the tolerant
 * extractor's new action/query/url keys) and settled off the argsSummary's
 * own segments. The PC's tool-args.ts `argValue` tolerance is ported as
 * `summarySegment` (values run to the next ", key: " boundary, so a URL
 * with commas reads whole).
 *
 * ROUND-129 (R129-M — the separated-elements rework): the grouping's OUTPUT
 * feeds the turn's SEPARATED renderers now (chat.md §Transcript R129 — the
 * R119-A "ONE clay container" law is retired as a CONTAINER): the rail is a
 * PLAIN tertiary line (no control, no chevron — `activitySummary` unchanged),
 * the thinking row is its own collapsible element (`thinkingRowLabel` below),
 * the tool calls render as one clay CARD each, and the reply is FLAT. The
 * DATA MODEL and the partition are untouched — the same `TurnGroup` stream,
 * the same `orderDisplayItems` queued law, the same summary string table;
 * only the renderers moved (transcript.tsx's `turnElementsPlan` is the new
 * pure render contract).
 *
 * Pure TypeScript, zero React Native — unit-tested directly.
 */

import type { ToolActivity } from "@/design/theme";
import {
  BROWSER_TOOLS,
  extractStringArg,
  extractWritePreview,
  READ_TOOLS,
  TERMINAL_TOOLS,
  WEB_TOOLS,
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

/**
 * The write row's file path: the streaming raw's `path` arg first (the
 * tolerant extractor — live, before the args complete), else the settled
 * argsSummary's `path: …` segment. R128-W6 — the segment scan is UNANCHORED
 * (first occurrence, same capture rules): the server's summarizeArgs orders
 * its segments by the MODEL's JSON key order, so an edit_file emitted as
 * {oldString, newString, path} lands as "oldString: …, newString: N chars,
 * path: src/a.ts" — the leading-`path:` match the old regex required never
 * fired, and the row lost its file name. A `path:` anywhere in the summary
 * now answers; null only when no `path:` rides it at all.
 */
export function writePath(item: ToolItem): string | null {
  if (item.inputRaw !== null) {
    const preview = extractWritePreview(item.inputRaw);
    if (preview.path !== null) return preview.path;
  }
  return item.argsSummary.match(/path:\s*([^,]+)/)?.[1] ?? null;
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

// ── R123-W-m — the web families' honest one-line targets ────────────────────

/**
 * One `key: value` segment of the SETTLED argsSummary (the summarizeArgs
 * "key: value, key: value" display string — the PC's own tool-args.ts
 * `argValue` tolerance, ported): the value runs to the next ", key: "
 * boundary or end-of-string, so a URL with commas still reads whole. null
 * when the key never rides the summary. */
function summarySegment(argsSummary: string, key: string): string | null {
  const match = new RegExp(`(?:^|, )${key}: ([\\s\\S]+?)(?=, [A-Za-z_]+: |$)`).exec(argsSummary);
  return match !== null ? match[1] : null;
}

/**
 * R123-W-m — the LIVE half of the web targets: the tolerant extractor over
 * the accumulated PARTIAL-JSON raw (the args stream in flight — a URL that
 * is still being typed answers its typed-so-far prefix, exactly the write
 * family's own live behavior). Empty string when the raw carries nothing
 * usable yet. */
function liveStringArg(item: ToolItem, key: "action" | "query" | "url"): string {
  if (item.inputRaw === null) return "";
  const arg = extractStringArg(item.inputRaw, key);
  return arg.found ? arg.value.trim() : "";
}

/**
 * R123-W-m — the WEB pair's one-line target: web_search's QUERY,
 * web_fetch's URL (the PC's own "Searched {query}" / "Fetched {url}"
 * honesty, in the mobile rows' noun · target grammar). Live calls read the
 * streaming raw first (the tolerant extractor), settled calls the
 * argsSummary's own segment; "" when neither source carries one (never a
 * guess). Pure. */
export function webTargetSegment(item: ToolItem): string {
  const key = item.toolName === "web_search" ? "query" : "url";
  const live = liveStringArg(item, key);
  if (live !== "") return live;
  return summarySegment(item.argsSummary, key)?.trim() ?? "";
}

/**
 * R123-W-m — the EMBEDDED BROWSER family's one-line target: the call's own
 * ACTION (+ its URL when the action carries one — "navigate
 * https://example.com", "read_dom", "click"). The action is the verb the
 * owner's reference rows lead with; the raw key:value dump is retired.
 * "" when neither source carries an action (never a guess). Pure. */
export function browserTargetSegment(item: ToolItem): string {
  let action = liveStringArg(item, "action");
  if (action === "") action = summarySegment(item.argsSummary, "action")?.trim() ?? "";
  if (action === "") return "";
  let url = liveStringArg(item, "url");
  if (url === "") url = summarySegment(item.argsSummary, "url")?.trim() ?? "";
  return url !== "" ? `${action} ${url}` : action;
}

/**
 * R119-A — the rail's LIVE verb while a tool runs ("Reading src/a.ts…"),
 * the one line the collapsed rail breathes (never the thinking card AND a
 * tool card — ONE line). The write family keeps its "Writing {file}…"
 * grammar, the terminal family leads with its command, the read family
 * with its target, everything else the humanized verb. R123-W-m: the web
 * pair carries its own verbs ("Searching {query}…" / "Fetching {url}…")
 * and the browser family leads with its URL while one rides ("Browsing
 * {url}…", else the action word — "read_dom…").
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
  if (WEB_TOOLS.has(item.toolName)) {
    const target = webTargetSegment(item);
    const verb = item.toolName === "web_search" ? "Searching" : "Fetching";
    return target !== "" ? `${verb} ${target}…` : `${verb}…`;
  }
  if (BROWSER_TOOLS.has(item.toolName)) {
    const url = liveStringArg(item, "url") || summarySegment(item.argsSummary, "url")?.trim() || "";
    if (url !== "") return `Browsing ${url}…`;
    const action = liveStringArg(item, "action") || summarySegment(item.argsSummary, "action")?.trim() || "";
    return action !== "" ? `${action}…` : "Browsing…";
  }
  return `${humanizeToolName(item.toolName)}…`;
}

/**
 * R120-CM — the TOOL ROW's ONE-line title, extracted from the component so
 * jest pins the exact grammar the well renders (item 40's "the TurnBlock
 * renders them" pin — the component stays a thin renderer): the write
 * family keeps its "Writing {file}… · {n} chars" streaming verb and
 * "Wrote/Edited {file}" settle, every other family the "verb · target"
 * one-line law. R123-W-m: the web pair and the browser family join with
 * their own honest targets (query / url / action+url) — the raw
 * "query: …" key:value dump never rides a row again. Pure.
 */
export function toolRowTitle(item: ToolItem): string {
  const running = item.ok === null;
  if (WRITE_TOOLS.has(item.toolName)) {
    const path = writePath(item);
    const verbRunning = item.toolName === "write_file" ? "Writing" : "Editing";
    const verbDone = item.toolName === "write_file" ? "Wrote" : "Edited";
    if (running) {
      if (path === null) return `${verbRunning}…`;
      if (item.inputRaw === null) return `${verbRunning} ${path}…`;
      const preview = extractWritePreview(item.inputRaw);
      return `${verbRunning} ${path}… · ${preview.chars.toLocaleString()} chars`;
    }
    return path !== null ? `${verbDone} ${path}` : humanizeToolName(item.toolName);
  }
  let summary: string;
  if (READ_TOOLS.has(item.toolName)) {
    summary = readTargetSegment(item);
  } else if (WEB_TOOLS.has(item.toolName)) {
    summary = webTargetSegment(item);
  } else if (BROWSER_TOOLS.has(item.toolName)) {
    summary = browserTargetSegment(item);
  } else {
    summary = genericOneLineSummary(item);
  }
  return summary !== ""
    ? `${humanizeToolName(item.toolName)} · ${summary}`
    : humanizeToolName(item.toolName);
}

// ── the rail's collapsed tool hints (R120-CM, item 40) ──────────────────────

/** How many hints the collapsed rail carries before the "+N more" tail — one
 *  line, glance-sized (the well behind the tap owns the full story). */
export const TOOL_HINT_MAX = 3;

/**
 * R120-CM — one call's COMPACT HINT for the collapsed rail: the write
 * family's file path ("src/a.ts" — the edit/create verdict the owner asked
 * to see), the terminal family's command ("npm test"), the read family's
 * target. R123-W-m: the web pair hints its query/url and the browser
 * family its action (+url) — the row's own target, the same law every
 * other hint family follows. Everything else answers null — a generic verb
 * adds no information the "N actions" count doesn't already carry. Pure.
 */
export function toolHint(item: ToolItem): string | null {
  if (WRITE_TOOLS.has(item.toolName)) {
    const path = writePath(item);
    return path !== null && path !== "" ? path : null;
  }
  if (TERMINAL_TOOLS.has(item.toolName)) {
    const command = genericOneLineSummary(item);
    return command !== "" ? command : null;
  }
  if (READ_TOOLS.has(item.toolName)) {
    const target = readTargetSegment(item);
    return target !== "" ? target : null;
  }
  if (WEB_TOOLS.has(item.toolName)) {
    const target = webTargetSegment(item);
    return target !== "" ? target : null;
  }
  if (BROWSER_TOOLS.has(item.toolName)) {
    const target = browserTargetSegment(item);
    return target !== "" ? target : null;
  }
  return null;
}

/** The hint list for the rail — the calls' hints, ORDER-PRESERVING deduped
 *  (two edits of one file hint once), capped at TOOL_HINT_MAX with an honest
 *  "+N more" tail. Pure + exported for the tests. */
export function toolHintList(items: ToolItem[]): string[] {
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const item of items) {
    const hint = toolHint(item);
    if (hint === null || seen.has(hint)) continue;
    seen.add(hint);
    hints.push(hint);
  }
  if (hints.length <= TOOL_HINT_MAX) return hints;
  return [...hints.slice(0, TOOL_HINT_MAX), `+${hints.length - TOOL_HINT_MAX} more`];
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
  /** R120-CM — the collapsed rail's TOOL HINTS (pref-applied with the rows:
   *  empty when hidden — the summary never teases content the well will not
   *  show). Deduped + capped by `toolHintList`. */
  toolHints: string[];
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

/**
 * R129-M — the THINKING ROW's label (pure, pinned): "Thinking…" while the
 * turn is live (the separated collapsible row's live-open state), else the
 * settled duration word in the SAME span-measure grammar the rail's summary
 * speaks (`Thought for 8s`; the plain "Thought process" fallback when the
 * wire carried no measured span — never a guess). The separated thinking
 * row renders no label at all when the turn has no thinking text (the
 * component gates on `turnThinkingText`, not on this).
 */
export function thinkingRowLabel(live: boolean, thoughtMs: number | null): string {
  if (live) return "Thinking…";
  return thoughtMs !== null ? `Thought for ${thoughtSeconds(thoughtMs)}s` : "Thought process";
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
    toolHints: toolHintList(tools),
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
 *             glance while collapsed) / R120-CM: the TOOL HINTS segment
 *             ("· src/a.ts, npm test +1 more") between the actions count
 *             and the failed tail — the files touched and the commands run
 *             ride the collapsed rail itself, so a settled turn tells the
 *             owner WHAT ran at one glance. null when the turn has NO
 *             activity at all (no thinking text, no tools) — the block
 *             renders as the clean document, no rail.
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
  if (facts.toolHints.length > 0) {
    segments.push(facts.toolHints.join(", "));
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
 *             turn carries no activity at all. R120-CM: the tool hints
 *             ride as a parenthetical ("3 actions (src/a.ts, npm test)") —
 *             the screen reader hears what the glance sees.
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
      const actions = `${input.toolCount} action${input.toolCount === 1 ? "" : "s"}`;
      words.push(
        input.toolHints.length > 0 ? `${actions} (${input.toolHints.join(", ")})` : actions,
      );
    }
    if (input.failedCount > 0) {
      words.push(`${input.failedCount} failed`);
    }
    head = words.length > 0 ? `Assistant turn — ${words.join(", ")}` : "Assistant reply";
  }
  return reply === null ? head : `${head}. Reply: ${reply}`;
}
