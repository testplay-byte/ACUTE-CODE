/**
 * composer-state.ts — the composer's PURE control-row state (R113-c): the
 * operating-mode options, the thinking-level menu spec, and the model
 * override. Ported from the DESKTOP's composer-utils.ts (R50/R81/R95/R96 —
 * the same vocabulary, labels, and model-aware logic, kept in lockstep so
 * both ends offer exactly the same levels), trimmed to the pieces the phone
 * renders. Pure TypeScript — zero React Native — the unit-test surface.
 */

// ── operating modes (the desktop's MODE_OPTIONS, verbatim semantics) ───────

export type PermissionMode = "full" | "ask" | "plan";

export interface ModeOption {
  id: PermissionMode;
  label: string;
  description: string;
}

/** The 3 operating modes with their one-line descriptions (owner spec, R81 —
 * the unified picker that retired the old permission switcher + task-mode
 * picker). "ask" is the default. */
export const MODE_OPTIONS: readonly ModeOption[] = [
  {
    id: "full",
    label: "Full Access",
    description: "All tools, no permission asks — the agent decides how to work and switches postures itself.",
  },
  {
    id: "ask",
    label: "Ask",
    description: "Full tools; asks before important commands and changes.",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only — research and plan, no edits or commands.",
  },
];

export function modeOption(id: string): ModeOption {
  return MODE_OPTIONS.find((m) => m.id === id) ?? MODE_OPTIONS[1];
}

// ── thinking levels (the desktop's THINKING_OPTIONS + thinkingMenuSpec) ────

export type ThinkingLevel = "default" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ThinkingOption {
  id: ThinkingLevel;
  label: string;
  description: string;
}

/** The FULL accepted vocabulary (shared/src THINKING_LEVELS, 1:1 — the
 * backend's send validation accepts exactly these). */
export const THINKING_OPTIONS: readonly ThinkingOption[] = [
  { id: "default", label: "Default", description: "The model's own reasoning default." },
  { id: "low", label: "Low", description: "Light reasoning — fastest replies." },
  { id: "medium", label: "Medium", description: "Balanced reasoning effort." },
  { id: "high", label: "High", description: "Deeper reasoning for complex work." },
  { id: "xhigh", label: "X-High", description: "Extra-deep reasoning — the rung above high." },
  { id: "max", label: "Max", description: "Maximum reasoning effort." },
];

export function thinkingOption(id: string): ThinkingOption {
  return THINKING_OPTIONS.find((t) => t.id === id) ?? THINKING_OPTIONS[0];
}

/** The classic R50 four — what a model with UNKNOWN capabilities offers
 * (the desktop's CLASSIC_THINKING_OPTIONS, kept at four). Exported for the
 * unit tests' "classic four" assertions. */
export const CLASSIC_THINKING_OPTIONS: readonly ThinkingOption[] = THINKING_OPTIONS.filter(
  (o) => o.id !== "medium" && o.id !== "xhigh",
);

/** A model's DETECTED reasoning capability — the configured-model rows carry
 * it (mobile config.ts ModelRecord.reasoningSupport, the R95-B wire). */
export interface ModelReasoningSupport {
  supported: boolean;
  efforts: string[];
  defaultEffort?: string;
}

export interface ThinkingMenuSpec {
  /** The levels the menu offers ("Default" always; then the model's ACTUAL
   * rungs, each VERBATIM — never a folded subset). Empty only when the model
   * takes no reasoning parameter at all. */
  options: readonly ThinkingOption[];
  /** The honest footer note (null = none). */
  note: string | null;
  /** True when the catalog says this model takes NO reasoning parameter —
   * the control renders disabled with an honest label; no menu at all. */
  unsupported: boolean;
  /** The row matching the provider's published default rung (null when
   * unknown or unoffered) — the quiet "default" mark. */
  defaultRow: ThinkingLevel | null;
}

/**
 * The menu spec a model's DETECTED reasoning capability yields (the desktop's
 * composer-utils.thinkingMenuSpec, ported verbatim):
 *  · null/absent — the classic four + the honest "capabilities unknown" note;
 *  · supported: false — unsupported: true;
 *  · supported: true, no discrete efforts — the classic four + a note;
 *  · supported: true with a ladder — Default + the rungs the ladder HOLDS
 *    (Low covers low OR minimal), the note NAMING the detection.
 */
export function thinkingMenuSpec(
  support: ModelReasoningSupport | null | undefined,
): ThinkingMenuSpec {
  if (support == null) {
    return {
      options: CLASSIC_THINKING_OPTIONS,
      note: "capabilities unknown for this model",
      unsupported: false,
      defaultRow: null,
    };
  }
  if (support.supported === false) {
    return { options: [], note: null, unsupported: true, defaultRow: null };
  }
  const efforts = support.efforts;
  if (efforts.length === 0) {
    return {
      options: CLASSIC_THINKING_OPTIONS,
      note: "this model supports reasoning; no discrete efforts listed",
      unsupported: false,
      defaultRow: null,
    };
  }
  const has = (rung: string): boolean => (efforts as readonly string[]).includes(rung);
  const options = THINKING_OPTIONS.filter(
    (o) =>
      o.id === "default" ||
      (o.id === "low" && (has("low") || has("minimal"))) ||
      (o.id === "medium" && has("medium")) ||
      (o.id === "high" && has("high")) ||
      (o.id === "xhigh" && has("xhigh")) ||
      (o.id === "max" && has("max")),
  );
  const note =
    `detected from provider: ${efforts.join(", ")}` +
    (support.defaultEffort !== undefined ? ` (model default: ${support.defaultEffort})` : "");
  const defaultCandidate: ThinkingLevel | null =
    support.defaultEffort === undefined
      ? null
      : support.defaultEffort === "minimal"
        ? "low"
        : (support.defaultEffort as ThinkingLevel);
  const defaultRow =
    defaultCandidate !== null && options.some((o) => o.id === defaultCandidate)
      ? defaultCandidate
      : null;
  return { options, note, unsupported: false, defaultRow };
}

/** The rank a thinking level occupies (default < low < medium < high <
 * xhigh < max) — displayThinkingLevel's ordering. */
const THINKING_RANK: Record<ThinkingLevel, number> = {
  default: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/**
 * The level the CONTROL should DISPLAY for a stored pick — the stored level
 * when the menu offers it, else the nearest supported one BELOW it, else the
 * LOWEST offered (display-only honesty; the stored value is never rewritten).
 */
export function displayThinkingLevel(
  level: ThinkingLevel,
  options: readonly ThinkingOption[],
): ThinkingLevel {
  if (options.some((o) => o.id === level)) return level;
  const levels = options.filter((o) => o.id !== "default").map((o) => o.id);
  if (levels.length === 0) return "default";
  let below: ThinkingLevel | null = null;
  for (const id of levels) {
    if (THINKING_RANK[id] <= THINKING_RANK[level] && (below === null || THINKING_RANK[id] > THINKING_RANK[below])) {
      below = id;
    }
  }
  if (below !== null) return below;
  return levels.reduce((lowest, id) => (THINKING_RANK[id] < THINKING_RANK[lowest] ? id : lowest));
}

// ── the per-send model override (the desktop's ModelOverride) ──────────────

export interface ModelOverride {
  /** The full model id (e.g. "z-ai/glm-5.2:free"). */
  model: string;
  /** The provider whose catalog it was picked from. */
  providerId: string;
}

/** The display label for a configured-model row — its displayName when one
 * is set, else the bare model id (the desktop ModelSelector's row label). */
export function modelLabel(row: {
  modelId: string;
  displayName: string | null;
}): string {
  const name = row.displayName ?? "";
  return name.trim() !== "" ? name.trim() : row.modelId;
}
