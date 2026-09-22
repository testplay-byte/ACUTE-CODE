/**
 * chat-prefs.ts — R114-d: the appearance domain's four chat prefs (R114-c's
 * useChatPrefs hook resolves them; Wave 3 wires the RENDERING), mapped to
 * pure numbers/folds the transcript consumes. One module, zero React Native
 * (the values are pinned by tests; the hook is reactive so every consumer
 * re-renders when a pref flips — the mapping itself never needs state).
 *
 * The four prefs and their render contracts (the owner's ask, R114-b's wire):
 *   chatDensity    comfortable → the current bubble paddings;
 *                  compact     → reduced VERTICAL padding on the
 *                                user/assistant/tool cards (the horizontal
 *                                gutters + the type scale stay put).
 *   chatTextSize   small/medium/large → a body-text scale on the transcript
 *                  (0.92 / 1.0 / 1.08). Micro/mono lines stay UNSCALED —
 *                  they are the calibration marks (tool paths, badges,
 *                  counters); scaling them would blur the hierarchy.
 *   timestampsMode hidden → omit entirely;
 *                  hover  → on the phone (no hover) a subtle clock in each
 *                  message's meta line.
 *   toolActivity   detailed → the TurnBlock's full activity well (R119-A:
 *                  thinking text + expandable tool ROWS inside the recessed
 *                  well — the standalone expandable tool cards are retired);
 *                  compact → always-collapsed single-line tool rows;
 *                  hidden  → consecutive tool items fold into ONE quiet
 *                  meta line per turn ("· 6 tool calls").
 */

import type { ChatDensity, ChatTextSize, TimestampsMode, ToolActivity } from "@/design/theme";
import type { TranscriptItem } from "./sessions";

// The types above are imported TYPE-ONLY (erased at runtime — the theme
// module owns the vocabulary; this module stays pure for the tests).

/** comfortable = the house card padding (spacing.md = 12); compact halves it. */
export function densityVerticalPadding(density: ChatDensity): number {
  return density === "compact" ? 6 : 12;
}

/** The body-text scale (micro/mono stay unscaled — see the header). */
export function textSizeScale(size: ChatTextSize): number {
  switch (size) {
    case "small":
      return 0.92;
    case "large":
      return 1.08;
    default:
      return 1;
  }
}

/** Does the timestamps pref render the per-message clock at all? */
export function timestampsVisible(mode: TimestampsMode): boolean {
  return mode === "hover";
}

/**
 * The subtle message clock — "14:32" (locale-shaped, hour + minute only:
 * chat timestamps answer "when did this land", not "what day is it"). An
 * absent/blank ts reads as null (the caller omits the line entirely).
 */
export function messageClock(ts: string | null): string | null {
  if (ts === null || ts.trim() === "") return null;
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The tool-card visibility the toolActivity pref picks. */
export interface ToolActivityVisibility {
  /** Full expandable cards (detailed). */
  expandable: boolean;
  /** Always-collapsed single-line rows (compact) — no expansion. */
  collapsedRows: boolean;
  /** Tool items fold into quiet meta lines entirely (hidden). */
  hidden: boolean;
}

export function toolActivityVisibility(activity: ToolActivity): ToolActivityVisibility {
  switch (activity) {
    case "compact":
      return { expandable: false, collapsedRows: true, hidden: false };
    case "hidden":
      return { expandable: false, collapsedRows: false, hidden: true };
    default:
      return { expandable: true, collapsedRows: false, hidden: false };
  }
}

/**
 * Fold the transcript items per the toolActivity pref (the session screen's
 * displayItems memo runs this before rendering):
 *   · hidden  — every RUN of consecutive `tool` items collapses into ONE
 *               quiet meta line ("· N tool calls", an honest "· running"
 *               appended while any call in the run is still in flight — a
 *               hidden running tool must never read as silence).
 *   · compact / detailed — the items pass through UNCHANGED (the card
 *               component renders collapsed rows / expandable cards).
 * Pure + order-preserving; non-tool items never merge.
 *
 * ROUND-119 (R119-A — the §N center rethink): the session screen no longer
 * runs this fold — the toolActivity pref now applies INSIDE the TurnBlock
 * (hidden = no tool rows + the rail only while thinking text exists, the
 * "clean document" verdict that supersedes the meta line; compact =
 * one-line rows; detailed = the full anatomy). The helper stays as the
 * vocabulary's documented fold (pinned by chat-prefs.test.ts) — the
 * pure law, ready for any future consumer that renders the UNgrouped item
 * stream.
 */
export function foldToolActivity(
  items: TranscriptItem[],
  activity: ToolActivity,
): TranscriptItem[] {
  if (activity !== "hidden") return items;
  const out: TranscriptItem[] = [];
  let run: TranscriptItem[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    const anyRunning = run.some((item) => item.kind === "tool" && item.ok === null);
    const n = run.length;
    out.push({
      kind: "meta",
      key: `tools-${n}-${out.length}`,
      text: `· ${n} tool call${n === 1 ? "" : "s"}${anyRunning ? " · running" : ""}`,
    });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      run.push(item);
      continue;
    }
    flushRun();
    out.push(item);
  }
  flushRun();
  return out;
}
