/**
 * ROUND-106 (R106-S3, CLI-DESIGN §2): the FLAGS TABLE — the single source
 * of truth that drives BOTH argv parsing AND `--help` generation (the
 * oh-my-pi blueprint: one table, no duplicated usage strings).
 *
 * Global flags (from the design's table): -p/--print, --mode text|json,
 * --agent, --model, --session, --db, --quiet, --no-color, --auto-approve
 * (ROUND-107 adds --version).
 *
 * ROUND-107 (R107-c-impl, F1): COMMAND_FLAGS — the per-command flag rows.
 * `parseArgv` alone knows only the GLOBAL table, so a documented flag like
 * `sessions ls --limit N` used to land in `unknown` → hard error before the
 * command ever ran. main.ts now re-parses argv with the command's own rows
 * spliced in (the two-pass parse); the flags stay "validated per command"
 * (context.ts) — the command module decides which of them its subcommands
 * actually honor.
 */

/** One row of the flag table. */
export interface FlagSpec {
  /** Long name (without `--`). */
  readonly name: string;
  /** Optional short alias (without `-`). */
  readonly short?: string;
  /** `true` when the flag takes a value (otherwise it is boolean). */
  readonly value?: boolean;
  /** Help text (one line, no trailing period — the repo's comment style). */
  readonly description: string;
}

export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "help", short: "h", description: "show this help and exit" },
  { name: "version", description: "print the CLI version and exit" },
  {
    name: "print",
    short: "p",
    value: true,
    description: 'one-shot: run PROMPT in a session, stream the reply, exit',
  },
  {
    name: "mode",
    value: true,
    description: "output mode: text (terminal rendering) or json (NDJSON frame passthrough)",
  },
  { name: "agent", value: true, description: "agent id for new sessions (default: first registry agent)" },
  { name: "model", value: true, description: "per-turn model override (model id)" },
  { name: "session", value: true, description: "continue an existing session id instead of creating one" },
  { name: "db", value: true, description: "spawn with an isolated SQLite DB path (spawn mode only)" },
  { name: "quiet", description: "suppress status/meta lines — assistant text only" },
  { name: "no-color", description: "disable ANSI colors (also: NO_COLOR env, non-TTY)" },
  { name: "auto-approve", description: "decide approval.requested frames as approved (no prompt)" },
] as const;

/** ROUND-107 (F1): extra flag rows a COMMAND accepts beyond the globals —
 * keyed by command name, spliced into the re-parse in main.ts. Each row is
 * documented in its command's own usage block (the sessions precedent). */
export const COMMAND_FLAGS: Readonly<Record<string, readonly FlagSpec[]>> = {
  sessions: [
    { name: "limit", value: true, description: "row cap (sessions ls / sessions events)" },
  ],
  approvals: [
    { name: "status", value: true, description: "status filter: pending|approved|denied|expired (approvals ls)" },
    { name: "remember", value: true, description: "decision memory: once|always (approvals <id> approve)" },
  ],
};

/** The extra flag rows for one command ("" table → no extras → no re-parse). */
export function commandFlagSpecs(command: string | undefined): readonly FlagSpec[] {
  if (command === undefined) return [];
  return COMMAND_FLAGS[command] ?? [];
}

/** The parsed argv: known flags (string | true), unknown flags (for the
 * honest error), and positionals after `--` handling. */
export interface ParsedFlags {
  flags: Record<string, string | true>;
  unknown: string[];
  positionals: string[];
}

const isFlagToken = (token: string): boolean => token.startsWith("-") && token !== "-";

/** Short-flag lookup (`-p` → the `print` row). */
function shortFlagIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const spec of GLOBAL_FLAGS) {
    if (spec.short !== undefined) index.set(`-${spec.short}`, spec.name);
  }
  return index;
}

/** Split argv into flag pairs + positionals (acute.mjs's parser, extended
 * with short flags, `--flag=value`, and `-pvalue` joining). */
export function parseArgv(argv: readonly string[], specs: readonly FlagSpec[] = GLOBAL_FLAGS): ParsedFlags {
  const flags: Record<string, string | true> = {};
  const unknown: string[] = [];
  const positionals: string[] = [];
  const known = new Set(specs.map((s) => s.name));
  const takesValue = new Set(specs.filter((s) => s.value === true).map((s) => s.name));
  const shortIndex = shortFlagIndex();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (isFlagToken(token)) {
      let name: string | undefined;
      let inlineValue: string | undefined;
      if (token.startsWith("--")) {
        const eq = token.indexOf("=");
        if (eq >= 0) {
          name = token.slice(2, eq);
          inlineValue = token.slice(eq + 1);
        } else {
          name = token.slice(2);
        }
      } else {
        const short = token.slice(0, 2);
        const rest = token.slice(2);
        const long = shortIndex.get(short);
        if (long !== undefined) {
          name = long;
          if (rest !== "") inlineValue = rest;
        } else {
          name = token.slice(1); // unknown single-dash token → honest error path
          if (rest !== "") inlineValue = rest;
        }
      }
      if (name === "") {
        positionals.push(token);
        continue;
      }
      if (!known.has(name)) {
        unknown.push(token);
        continue;
      }
      if (takesValue.has(name)) {
        if (inlineValue !== undefined) {
          flags[name] = inlineValue;
        } else {
          const next = argv[i + 1];
          if (next !== undefined && !isFlagToken(next)) {
            flags[name] = next;
            i++;
          } else {
            flags[name] = true; // value flag with no value → bare true (validated later)
          }
        }
      } else {
        flags[name] = true;
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, unknown, positionals };
}

/** `--flag value` → trimmed string, or undefined when absent/bare/blank. */
export function flagString(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Boolean flag: present with any value counts (no-value flags only). */
export function flagBool(flags: Record<string, string | true>, name: string): boolean {
  return flags[name] !== undefined;
}

/** Render the flag rows for --help (pure — the table is the only input). */
export function renderFlagHelp(specs: readonly FlagSpec[]): string[] {
  const rows: string[] = [];
  for (const spec of specs) {
    const left = spec.short !== undefined ? `  -${spec.short}, --${spec.name}` : `      --${spec.name}`;
    const takes = spec.value === true ? " <value>" : "";
    rows.push(`${`${left}${takes}`}  ${spec.description}`);
  }
  return rows;
}
