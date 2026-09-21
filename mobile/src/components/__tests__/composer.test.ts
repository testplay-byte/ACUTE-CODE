/**
 * composer.test.ts — the R115-I → R116-l header/composer contract, pinned in
 * the screen-scaffold.test.ts idiom: TYPE-ONLY imports (erased at runtime —
 * zero React Native pulled in, the suite's pure-logic convention), so
 * `npm run typecheck` is the assertion's execution engine and this file
 * fails to COMPILE the moment the surface drifts.
 *
 * R115-I deleted the composer's CONTROL PILL ROW: the mode / model /
 * thinking / context sheets are now KEBAB-DRIVEN — the session screen owns
 * the open state and renders the kebab; the composer renders every sheet's
 * content, controlled through `sheet`/`onSheetChange`, and reports its live
 * control values through `onControlsSnapshot`. The task-mode picker is gone
 * from mobile entirely (the round-115 verdict — the desktop keeps it).
 *
 * R116-l (the owner's verdicts #55-#57): the kebab's menu is an ANCHORED
 * DROPDOWN now (the session screen's own state — never a ComposerSheet
 * value), the composer's input is the PILL bar with the paperclip INSIDE at
 * the right, and the MODEL SHEET lists REAL MODELS ONLY — the "Agent
 * default" row is retired (donts #36: the PC's actual selection carries the
 * check via the context report; the label ladder's floor is the em-dash
 * "—", never "Agent default"), and clearing rides tapping the checked
 * session-selected row → pickModel(null) → onModelChange(null) (the
 * PATCH-null path).
 *
 * (The composer itself remains un-rendered surface by convention — the pure
 * logic it rides is pinned by composer-state / context-meter / attachments /
 * sessions / outbox; groupModelsByProvider lives in the component file and
 * so stays type-pinned here rather than value-tested.)
 */

import { describe, expect, it } from "@jest/globals";

import type { ComposerControlsSnapshot, ComposerProps, ComposerSheet } from "@/components/composer";

// The task-mode picker's prop pair is DELETED from the composer's surface
// (round-115 verdict: mobile shows only the three operating modes).
type TaskModeIsGone =
  "activeMode" extends keyof ComposerProps
    ? never
    : "onActiveModeChange" extends keyof ComposerProps
      ? never
      : true;
const taskModeGone: TaskModeIsGone = true;

// The CONTROLLED-sheet pair is REQUIRED: the session screen owns the open
// sheet; the composer receives it.
type ControlledSheetIsIn =
  "sheet" extends keyof ComposerProps ? ("onSheetChange" extends keyof ComposerProps ? true : never) : never;
const controlledSheet: ControlledSheetIsIn = true;

// The sheet vocabulary: exactly the six composer sheets — the kebab's
// dropdown is the session screen's own boolean state and never appears here
// (R116-l: the retired "kebab" member is gone from the screen's union too).
type ExpectedSheets = "attach" | "files" | "mode" | "model" | "thinking" | "context";
type SheetVocabularyPinned =
  Exclude<ComposerSheet, ExpectedSheets> extends never
    ? Exclude<ExpectedSheets, ComposerSheet> extends never
      ? true
      : never
    : never;
const sheetVocabulary: SheetVocabularyPinned = true;

// The live control-values report carries exactly the three kebab rows the
// composer owns (the mode row reads the session row itself).
type ExpectedSnapshotKeys = "modelLabel" | "thinkingLabel" | "ctxPct";
type SnapshotVocabularyPinned = Exclude<keyof ComposerControlsSnapshot, ExpectedSnapshotKeys> extends never
  ? Exclude<ExpectedSnapshotKeys, keyof ComposerControlsSnapshot> extends never
    ? true
    : never
  : never;
const snapshotVocabulary: SnapshotVocabularyPinned = true;

// R116-l — the model CLEAR path survives the "Agent default" row's
// retirement: onModelChange still accepts null (tapping the row checked via
// the session's selectedModel tier PATCHes null — donts #36's picker lists
// real models only, so the clear is reachable ONLY from the checked row).
type ModelChangeAcceptsNull = NonNullable<ComposerProps["onModelChange"]> extends (
  model: { providerId: string; model: string } | null,
) => void
  ? true
  : never;
const modelClearPin: ModelChangeAcceptsNull = true;

describe("Composer — the R116-l kebab-dropdown control surface", () => {
  it("the task-mode props are deleted; the controlled sheet pair is required", () => {
    // The runtime mirror of the compile-time pins above (both would fail to
    // COMPILE first — that is the point: typecheck is the gate that runs them).
    expect(taskModeGone).toBe(true);
    expect(controlledSheet).toBe(true);
  });

  it("the sheet vocabulary is exactly the six composer sheets (no kebab here)", () => {
    expect(sheetVocabulary).toBe(true);
  });

  it("the controls snapshot carries exactly the dropdown rows' live values", () => {
    expect(snapshotVocabulary).toBe(true);
    // R116-l: the honest model label — a real short label when the ladder
    // knows one, the em-dash floor when it knows nothing ("Agent default"
    // is retired vocabulary, donts #36).
    const snapshot: ComposerControlsSnapshot = {
      modelLabel: "L2N Flash",
      thinkingLabel: "Medium",
      ctxPct: 42,
    };
    expect(snapshot.modelLabel).toBe("L2N Flash");
    expect(snapshot.ctxPct).toBe(42);
    const floor: ComposerControlsSnapshot = {
      modelLabel: "—",
      thinkingLabel: "Default",
      ctxPct: null,
    };
    expect(floor.modelLabel).toBe("—");
    expect(floor.ctxPct).toBeNull();
    expect(floor.modelLabel).not.toBe("Agent default");
  });

  it("the model pick's clear path still PATCHes null (tapping the checked row)", () => {
    expect(modelClearPin).toBe(true);
  });
});
