/**
 * ROUND-117 (R117-f): the per-tool ARG HUMANIZER — pure formatters that turn
 * the server's raw `argsSummary` display string ("key: value, key: value" —
 * agent-core chat.ts's summarizeArgs) into the ONE clean target a collapsed
 * tool row should show. The raw string stays the fallback (unknown shapes,
 * missing keys) and always rides the row's title/aria-label + the expand —
 * the formatter only cleans the GLANCE, never the record.
 *
 * Shapes it parses (summarizeArgs drops non-string args, truncates values at
 * 80 chars with "…", and turns content/newString into "N chars"):
 *   · file family   "path: src/app.ts, content: 20 chars"   → the path
 *   · run_command   "command: pnpm exec vitest run"         → the command's
 *                   first top-level command, plus "· N commands" when the
 *                   string chains several (R128-W5: && / ; / newlines,
 *                   split outside quotes — the glance names the batch, the
 *                   expanded card lists them one by one)
 *   · delegate_task "task: Fix login, role: coder, task_id: 4f2a"
 *                                                             → "coder · 4f2a"
 * Pure; exported for tests (the assignDelegateChildren pattern).
 */

/** One `key: value` segment of a summarizeArgs string (null when absent).
 * Tolerates multi-line values (the lazy `[\s\S]` body) and stops at the next
 * ", key: " boundary or end-of-string — the same tolerance the orchestrator's
 * `path:` parser applies to write-family summaries. */
function argValue(argsSummary: string, key: string): string | null {
  const m = new RegExp(`(?:^|, )${key}: ([\\s\\S]+?)(?=, [A-Za-z_]+: |$)`).exec(argsSummary);
  return m !== null ? m[1] : null;
}

/** The humanized collapsed-row target. */
export type ToolTarget =
  | { kind: "path"; value: string }
  | { kind: "text"; value: string };

/**
 * ROUND-128 (R128-W5): split a chained shell command into its top-level
 * COMMANDS — breaks on `&&`, `;`, and newlines OUTSIDE single/double quotes
 * (a quoted `;` is an argument, never a chain). Backslash escapes the next
 * character outside single quotes (the common shells); inside single quotes
 * every character is literal. Whitespace-only segments drop. Pure;
 * exported for tests + the terminal card's numbered COMMAND LIST.
 */
export function splitShellCommands(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed !== "") parts.push(trimmed);
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      // Inside single quotes everything is literal until the closing '.
      if (ch === "'") inSingle = false;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      // Escape: keep the pair verbatim (the shell sees the escaped char).
      current += ch + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inDouble && (ch === "\n" || ch === ";")) {
      flush();
      continue;
    }
    if (!inDouble && ch === "&" && command[i + 1] === "&") {
      flush();
      i += 1;
      continue;
    }
    current += ch;
  }
  flush();
  return parts;
}

/**
 * ROUND-128 (R128-W5): the run_command row's COMMAND LIST — the raw
 * `command:` segment of the argsSummary split into its top-level commands
 * (the terminal card renders one numbered mono row per command, in order;
 * the output below stays the merged truth). Falls back to the whole summary
 * for legacy shapes that carry the bare command with no `command:` key;
 * empty when the summary carries nothing. Pure.
 */
export function toolCommandList(argsSummary: string): string[] {
  if (argsSummary === "") return [];
  const command = argValue(argsSummary, "command") ?? argsSummary;
  return splitShellCommands(command);
}

/**
 * The per-tool formatter — the clean target a collapsed ToolLine shows in
 * place of the raw argsSummary, or null (→ the raw string) when the summary
 * carries nothing worth extracting. Deliberately per-tool, not generic:
 * only the three families the round called out get opinions.
 */
export function formatToolTarget(toolName: string, argsSummary: string): ToolTarget | null {
  if (argsSummary === "") return null;
  switch (toolName) {
    case "run_command": {
      // The command segment — fall back to the whole summary for fixture /
      // legacy shapes that carry the bare command with no "command:" key.
      // R128-W5: a CHAINED command (top-level && / ; / newlines, split
      // outside quotes) shows the FIRST command plus the honest count —
      // "cmd · N commands" — instead of one merged blob (the whole chained
      // string executes as ONE shell invocation; the glance says how many
      // commands that is, the expand lists them one by one).
      const command = argValue(argsSummary, "command") ?? argsSummary;
      const commands = splitShellCommands(command);
      const first = (commands[0] ?? "").trim();
      if (first === "") return null;
      if (commands.length > 1) {
        return { kind: "text", value: `${first} · ${commands.length} commands` };
      }
      return { kind: "text", value: first };
    }
    case "delegate_task": {
      // The R117-d1 addressability pair: role + task_id (the task text stays
      // behind the expand — the row is a glance, not the brief).
      const role = argValue(argsSummary, "role");
      const taskId = argValue(argsSummary, "task_id");
      const parts = [role, taskId].filter((p): p is string => p !== null);
      return parts.length > 0 ? { kind: "text", value: parts.join(" · ") } : null;
    }
    default: {
      // Every other tool: a `path:` segment becomes the target (the clickable
      // path pill at the call site). "." / "./" (a bare list_dir) reads worse
      // as a pill than as text — those and path-less summaries fall back.
      const path = argValue(argsSummary, "path");
      if (path !== null && path !== "" && path !== "." && path !== "./") {
        return { kind: "path", value: path };
      }
      return null;
    }
  }
}

/**
 * ROUND-117 (R117-f): the failed row's one-line ERROR EXCERPT — the first
 * non-empty line of the tool's own output summary (mono, danger, truncated at
 * the call site). Expanding the row still shows the full dump; this is the
 * glance that says WHAT failed. Null when the output carries no line at all
 * (the ✗ glyph alone stays honest).
 */
export function toolErrorExcerpt(outputSummary: string | undefined): string | null {
  if (outputSummary === undefined || outputSummary === "") return null;
  for (const line of outputSummary.split("\n")) {
    const t = line.trim();
    if (t !== "") return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  }
  return null;
}
