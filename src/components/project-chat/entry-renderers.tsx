import type { ReactNode } from "react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import type { WorkingEntry } from "../../lib/api";
import { ThoughtRow } from "./WorkingSection";
import { QuestionCard } from "./QuestionCard";
import { TodoCard } from "./TodoCard";
import { ScreenshotRow } from "./ScreenshotRow";

/**
 * ROUND-95 (R95-F) — the MESSAGE-PART RENDERER REGISTRY for the working
 * stream, the extensibility answer to the owner's ask (verbatim: "Make sure
 * that everything is modular, easily editable… it should be able to display
 * various other info in the future too. Currently it does show images with
 * the screenshots… but I am also thinking about making it much more
 * compatible in the future, much more robust").
 *
 * TODAY every WorkingEntry kind renders through an if-chain in
 * WorkingSection.tsx (`if (entry.type === "thinking") … if (entry.type ===
 * "text") …`), duplicated across WorkingSection + BareWorkingEntries, with
 * kind-specific props threaded as locals. Every NEW entry kind the owner
 * wants to display means editing that chain (a file owned by a different
 * round's workstream) — and forgetting one arm silently drops entries.
 *
 * THIS module inverts it: kind → renderer lives in ONE registry. A future
 * entry kind (say `type: "file-diff"` or `type: "usage-note"`) becomes:
 *
 *   1. add the variant to WorkingEntry (src/lib/api.ts);
 *   2. write its component;
 *   3. ONE registerWorkingEntryRenderer({ kind, label, render }) call;
 *   4. update KNOWN_WORKING_ENTRY_KINDS' exhaustiveness map (the compiler
 *      demands it);
 *   5. missingWorkingEntryKinds() goes back to [] — the wire-up test fails
 *      loudly until it does.
 *
 * ── ADOPTION PATH (deliberately UNWIRED this round) ─────────────────────────
 * WorkingSection.tsx is D's committed file (R95-D) — do not churn it. The
 * follow-up round that owns it replaces the if-chain body with:
 *
 *   {entries.map((entry, i) => (
 *     <Fragment key={`we-${i}`}>
 *       {renderWorkingEntry(entry, {
 *         surface: "section",
 *         entryIndex: i,
 *         liveEntryIndex,
 *         live,
 *         sessionId,
 *         projectId,
 *         onApprovalDecision,
 *         onQuestionAnswer,
 *         delegateClaims,
 *       })}
 *     </Fragment>
 *   ))}
 *
 * …after exporting NarrationRow/ToolLine/ApprovalRow from WorkingSection.tsx
 * and registering the remaining three kinds here (they are module-internal
 * today — see PENDING_ADOPTION notes below). BareWorkingEntries uses the
 * same call with surface: "bare" (renderers may skip — e.g. screenshots are
 * live-only and bare blocks have no tool row to anchor an inline capture).
 * The per-kind React keys WorkingSection builds today (`t-${i}`,
 * `tool-${seq}`, `shot-${frameId}-${ts}`…) move into the renderer metadata
 * or stay at the call site — the registry returns keyless nodes and the
 * CALLER wraps (keys are a list-position concern, not a kind concern).
 *
 * ── HONESTY CONTRACTS ───────────────────────────────────────────────────────
 *  · An UNREGISTERED kind renders the quiet placeholder below — never a
 *    crash, never a silent drop (a folded future session must stay readable).
 *  · missingWorkingEntryKinds() is the wire-up gate: it must be [] before
 *    WorkingSection dispatches through the registry.
 *  · render() returning null IS a skip (the bare-surface screenshot rule).
 */

/** One WorkingEntry kind (the discriminant of src/lib/api.ts's WorkingEntry). */
export type WorkingEntryKind = WorkingEntry["type"];

/** Narrow a WorkingEntry by its kind. */
export type EntryOfKind<K extends WorkingEntryKind> = Extract<WorkingEntry, { type: K }>;

/**
 * The compile-time exhaustiveness map — adding a WorkingEntry variant
 * without listing it here is a TYPE ERROR (and the runtime list below is
 * derived from it, so the registry's "missing kinds" check fails loudly
 * until the new kind is registered).
 */
const KNOWN_KINDS_EXHAUSTIVE: Record<WorkingEntryKind, true> = {
  thinking: true,
  text: true,
  tool: true,
  approval: true,
  screenshot: true,
  question: true,
  todo: true,
};

/** Every WorkingEntry kind the code knows about (source of truth: the map
 * above, which the compiler keeps in lockstep with the WorkingEntry union). */
export const KNOWN_WORKING_ENTRY_KINDS: readonly WorkingEntryKind[] = Object.keys(
  KNOWN_KINDS_EXHAUSTIVE,
) as WorkingEntryKind[];

/** Which call site is rendering (renderers may skip per surface — the
 * BareWorkingEntries screenshot rule). */
export type WorkingEntrySurface = "section" | "bare";

/**
 * Everything a renderer may need, distilled from the WorkingSection call
 * sites. Optional fields are the callbacks/lookups only some kinds consume —
 * a renderer must degrade honestly when one is absent (the folded log, for
 * example, answers no questions).
 */
export interface WorkingEntryRenderContext {
  /** "section" = WorkingSection's tooled block; "bare" = the tools-free
   * variant (renderers like screenshots may skip there). */
  surface: WorkingEntrySurface;
  /** The entry's index in the rendered list (the live-entry check). */
  entryIndex: number;
  /** Which list index is the LIVE in-flight entry (undefined = none). */
  liveEntryIndex?: number;
  /** True while the owning turn is streaming. */
  live: boolean;
  sessionId: string;
  projectId: string;
  /** The approval card's decision callback (absent on read-only surfaces). */
  onApprovalDecision?: (
    approvalId: string,
    decision: "approved" | "denied",
    remember: "once" | "always",
  ) => void;
  /** The ask_user card's answer callback (absent when not live). */
  onQuestionAnswer?: (questionId: string, answers: string[], sources: Array<"option" | "custom">) => void;
  /** delegate_task child claims by tool seq (the tool renderer's lookup). */
  delegateClaims?: Map<number, string>;
}

/** One registry entry: the kind, a human label, the renderer, and docs. */
export interface WorkingEntryRendererRegistration<K extends WorkingEntryKind = WorkingEntryKind> {
  kind: K;
  /** Human-readable name (docs/tests — not rendered today). */
  label: string;
  /** Adoption + behavior notes (rendered into this file's docs). */
  notes?: string;
  render: (entry: EntryOfKind<K>, ctx: WorkingEntryRenderContext) => ReactNode;
}

/** The typed registry: exactly one renderer slot per known kind. */
type RendererMap = {
  [K in WorkingEntryKind]?: (entry: EntryOfKind<K>, ctx: WorkingEntryRenderContext) => ReactNode;
};

const renderers: RendererMap = {};
const registrationMeta = new Map<WorkingEntryKind, { label: string; notes?: string }>();

/**
 * Register (or REPLACE) a kind's renderer. Replacement is allowed and
 * last-wins — a surface-specific override can swap a renderer at runtime
 * (tests do this); the meta map keeps the newest label/notes.
 */
export function registerWorkingEntryRenderer<K extends WorkingEntryKind>(
  registration: WorkingEntryRendererRegistration<K>,
): void {
  renderers[registration.kind] = registration.render as RendererMap[K];
  registrationMeta.set(registration.kind, { label: registration.label, notes: registration.notes });
}

/** Remove a kind's renderer (test isolation + explicit deprecation). */
export function unregisterWorkingEntryRenderer(kind: WorkingEntryKind): void {
  delete renderers[kind];
  registrationMeta.delete(kind);
}

/** The meta (label/notes) for a registered kind — docs/tests. */
export function workingEntryRegistrationMeta(
  kind: WorkingEntryKind,
): { label: string; notes?: string } | undefined {
  return registrationMeta.get(kind);
}

/** Kinds with a renderer registered. */
export function registeredWorkingEntryKinds(): WorkingEntryKind[] {
  return Object.keys(renderers) as WorkingEntryKind[];
}

/**
 * The WIRE-UP GATE: known kinds WITHOUT a renderer. Must be [] before
 * WorkingSection dispatches through the registry (a missing kind would fall
 * to the placeholder — honest, but a visual regression vs today).
 */
export function missingWorkingEntryKinds(): WorkingEntryKind[] {
  const registered = new Set(registeredWorkingEntryKinds());
  return KNOWN_WORKING_ENTRY_KINDS.filter((k) => !registered.has(k));
}

/**
 * The honest placeholder for an UNREGISTERED kind — never a crash, never a
 * silent drop. A KNOWN kind without a renderer yet (the pending-adoption
 * three) says so explicitly; a NEVER-SEEN kind (a future wire variant in a
 * folded session) reads as one quiet muted line.
 */
export function UnknownWorkingEntryRow({ kind }: { kind: string }) {
  const styles = useThemeStyles();
  const known = (KNOWN_WORKING_ENTRY_KINDS as readonly string[]).includes(kind);
  return (
    <div
      data-unknown-entry-kind={kind}
      // R100-D: 10.5→10px mono (the ladder's no-half-pixel rule — meta-mono).
      className="px-1 py-0.5 font-mono text-[10px]"
      style={{ color: styles.textTertiary }}
    >
      {known ? `${kind} — renderer not registered yet` : `unrecognized entry kind: ${kind}`}
    </div>
  );
}

/**
 * Render one WorkingEntry through the registry. Returns null ONLY when the
 * kind's renderer deliberately skips (surface rules); an unregistered OR
 * never-seen kind returns the placeholder row. The CALLER owns the React key
 * (wrap in a keyed Fragment).
 */
export function renderWorkingEntry(entry: WorkingEntry, ctx: WorkingEntryRenderContext): ReactNode {
  const kind: string = entry.type;
  if (!Object.prototype.hasOwnProperty.call(renderers, kind)) {
    return <UnknownWorkingEntryRow kind={kind} />;
  }
  // The RendererMap slots are per-kind-typed; the hasOwnProperty guard
  // above proved the slot exists, and the stored function accepts exactly
  // this entry's narrowed shape.
  const render = renderers[kind as WorkingEntryKind] as
    | ((entry: WorkingEntry, ctx: WorkingEntryRenderContext) => ReactNode)
    | undefined;
  return render !== undefined ? render(entry, ctx) : <UnknownWorkingEntryRow kind={kind} />;
}

// ── The default registrations ───────────────────────────────────────────────
//
// FOUR kinds register REAL renderers today — exactly the components that
// already live in their own modules (importable without touching D's
// WorkingSection.tsx beyond its existing exports):
//
//   thinking → ThoughtRow (WorkingSection's R95-D export — the stick-to-
//              bottom scroller with the inner jump pill)
//   question → QuestionCard (R87)
//   todo     → TodoCard (R87)
//   screenshot → ScreenshotRow (R68-A — the inline capture row)
//
// THREE kinds stay UNREGISTERED on purpose — text/tool/approval, whose
// components (NarrationRow, ToolLine, ApprovalRow) are module-INTERNAL to
// WorkingSection.tsx. The wire-up round exports them and registers them
// here; until then missingWorkingEntryKinds() reports them (the deliberate,
// honest state — the gate the wire-up test asserts on) and the placeholder
// above names them as "renderer not registered yet", never as unknown.
const PENDING_ADOPTION: Partial<Record<WorkingEntryKind, string>> = {
  text: "NarrationRow (module-internal to WorkingSection.tsx)",
  tool: "ToolLine (module-internal to WorkingSection.tsx)",
  approval: "ApprovalRow (module-internal to WorkingSection.tsx)",
};

/** The pending-adoption note for an unregistered KNOWN kind (docs/tests). */
export function pendingAdoptionNote(kind: WorkingEntryKind): string | undefined {
  return PENDING_ADOPTION[kind];
}

function registerDefaultWorkingEntryRenderers(): void {
  registerWorkingEntryRenderer({
    kind: "thinking",
    label: "Thought",
    render: (entry, ctx) => (
      <ThoughtRow
        text={entry.text}
        thinkingMs={entry.thinkingMs}
        live={ctx.live && ctx.entryIndex === ctx.liveEntryIndex}
      />
    ),
  });
  registerWorkingEntryRenderer({
    kind: "question",
    label: "Ask-user card",
    render: (entry, ctx) => <QuestionCard entry={entry} onAnswer={ctx.live ? ctx.onQuestionAnswer : undefined} />,
  });
  registerWorkingEntryRenderer({
    kind: "todo",
    label: "Todo card",
    render: (entry) => <TodoCard entry={entry} />,
  });
  registerWorkingEntryRenderer({
    kind: "screenshot",
    label: "Inline capture",
    notes:
      "Live-only entries; a BARE (tools-free) block has no tool row to anchor an inline capture — the renderer skips there (WorkingSection's existing rule, kept verbatim).",
    render: (entry, ctx) =>
      ctx.surface === "bare" ? null : (
        <ScreenshotRow shot={{ frameId: entry.frameId, tool: entry.tool, ts: entry.ts }} />
      ),
  });
}

/**
 * Test isolation: clear the registry and restore the DEFAULT registrations.
 * Production code never calls this (the defaults install at module load).
 */
export function resetWorkingEntryRenderersForTests(): void {
  for (const kind of registeredWorkingEntryKinds()) unregisterWorkingEntryRenderer(kind);
  registerDefaultWorkingEntryRenderers();
}

registerDefaultWorkingEntryRenderers();
