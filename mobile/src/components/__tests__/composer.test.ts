/**
 * composer.test.ts — the R115-I → R116-l → R118-D composer contract, pinned
 * in the screen-scaffold.test.ts idiom: the surface pins are TYPE-ONLY
 * (erased at runtime), so `npm run typecheck` is the assertion's execution
 * engine and this file fails to COMPILE the moment the surface drifts. The
 * GEOMETRY pins are VALUE imports — the R118-D constants are the contract
 * the auto-grow + the two-tier attach band ride — which pull the component
 * module's own import graph into the sandbox, so the three native-heavy
 * leaves are jest-mocked the chart-donut.test.ts way (reanimated,
 * lucide, keyboard-controller — mocked, never loaded).
 *
 * R118-D (spec-d-session.md §2.4/§2.5): the composer's growth is NATIVE
 * (the controlled height + flex:1 pair is deleted; only minHeight 44 /
 * maxHeight 176 remain — 6 lines × 21 + 10 + the 40px ATTACH_BAND), the
 * mode/model/thinking/context SHEETS are deleted (the kebab's menu renders
 * their levels in place now), and ComposerSheet narrows to the attach PAIR.
 * ComposerProps itself is UNCHANGED — the screen's call site rides frozen.
 */

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  default: { createAnimatedComponent: () => () => null, View: () => null },
  runOnJS: (fn: unknown) => fn,
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useReducedMotion: () => true,
  useSharedValue: (initial: number) => ({ value: initial }),
  withRepeat: (v: unknown) => v,
  withSequence: (...v: unknown[]) => v[0],
  withSpring: (v: number) => v,
  withTiming: (v: number) => v,
}));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("react-native-keyboard-controller", () => ({
  KeyboardEvents: { addListener: () => ({ remove: () => {} }) },
}));
jest.mock("@/link/use-link", () => ({
  useLink: () => ({ status: "connected" }),
}));
jest.mock("@/link/runtime", () => ({
  getLinkManager: () => ({}),
}));

import {
  ATTACH_BAND,
  INPUT_MAX_LINES,
  INPUT_TALL_THRESHOLD,
  MAX_INPUT_HEIGHT,
  type ComposerControlsSnapshot,
  type ComposerProps,
  type ComposerSheet,
} from "@/components/composer";

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

// R118-D — the sheet vocabulary NARROWS to the attach pair: the
// mode/model/thinking/context sheets are deleted (the kebab's menu owns
// their levels in place now). Both directions, so neither a missing nor a
// resurrected member can slip in.
type ExpectedSheets = "attach" | "files";
type SheetVocabularyPinned =
  Exclude<ComposerSheet, ExpectedSheets> extends never
    ? Exclude<ExpectedSheets, ComposerSheet> extends never
      ? true
      : never
    : never;
const sheetVocabulary: SheetVocabularyPinned = true;

// R118-D — ComposerProps is UNCHANGED (the frozen surface): the screen's
// call site rides byte-identical; permissionMode + onPermissionModeChange
// SURVIVE as vestigial-but-required (the menu's Mode level calls the
// screen's own handler now — the props stay so the call site never churns).
type ExpectedProps =
  | "mode"
  | "outboxCount"
  | "sessionId"
  | "projectId"
  | "permissionMode"
  | "selectedModel"
  | "sheet"
  | "onSheetChange"
  | "onControlsSnapshot"
  | "onPermissionModeChange"
  | "onModelChange"
  | "onSend"
  | "onStop"
  | "onQueue"
  | "onDismissOutbox"
  | "streaming";
type PropKeys = keyof ComposerProps;
type PropsUnchanged = Exclude<PropKeys, ExpectedProps> extends never
  ? Exclude<ExpectedProps, PropKeys> extends never
    ? true
    : never
  : never;
const propsUnchanged: PropsUnchanged = true;

// R118-D — the snapshot v2 surface: the three live labels PLUS the menu's
// own data (the model sections, the thinking spec, the context report) and
// the STABLE pick callbacks — exactly ten fields, no API creep.
type ExpectedSnapshotKeys =
  | "modelLabel"
  | "thinkingLabel"
  | "ctxPct"
  | "modelSections"
  | "thinkingOptions"
  | "thinkingUnsupported"
  | "thinkingSelected"
  | "contextReport"
  | "pickModel"
  | "pickThinking";
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

describe("Composer — the R118-D kebab-menu control surface", () => {
  it("the task-mode props are deleted; the controlled sheet pair is required", () => {
    // The runtime mirror of the compile-time pins above (both would fail to
    // COMPILE first — that is the point: typecheck is the gate that runs them).
    expect(taskModeGone).toBe(true);
    expect(controlledSheet).toBe(true);
  });

  it("the sheet vocabulary is EXACTLY the attach pair (the control sheets are deleted)", () => {
    expect(sheetVocabulary).toBe(true);
  });

  it("ComposerProps is unchanged — the frozen surface, vestigial pair included", () => {
    expect(propsUnchanged).toBe(true);
  });

  it("the controls snapshot v2 carries exactly the menu's ten fields", () => {
    expect(snapshotVocabulary).toBe(true);
    // R116-l: the honest model label — a real short label when the ladder
    // knows one, the em-dash floor when it knows nothing ("Agent default"
    // is retired vocabulary, donts #36).
    const snapshot: ComposerControlsSnapshot = {
      modelLabel: "L2N Flash",
      thinkingLabel: "Medium",
      ctxPct: 42,
      modelSections: [
        { providerId: "z-ai", label: "Z.AI", rows: [{ key: "m1", model: "glm-4.7", providerId: "z-ai", label: "GLM 4.7", selected: true }] },
      ],
      thinkingOptions: [{ id: "default", label: "Default", description: "" }],
      thinkingUnsupported: false,
      thinkingSelected: "default",
      contextReport: null,
      pickModel: () => {},
      pickThinking: () => {},
    };
    expect(snapshot.modelLabel).toBe("L2N Flash");
    expect(snapshot.ctxPct).toBe(42);
    expect(snapshot.modelSections?.[0]?.rows[0]?.selected).toBe(true);
    const floor: ComposerControlsSnapshot = {
      modelLabel: "—",
      thinkingLabel: "Default",
      ctxPct: null,
      modelSections: null,
      thinkingOptions: [],
      thinkingUnsupported: false,
      thinkingSelected: "default",
      contextReport: null,
      pickModel: () => {},
      pickThinking: () => {},
    };
    expect(floor.modelLabel).toBe("—");
    expect(floor.ctxPct).toBeNull();
    expect(floor.modelLabel).not.toBe("Agent default");
  });

  it("the model pick's clear path still PATCHes null (tapping the checked row)", () => {
    expect(modelClearPin).toBe(true);
  });
});

describe("Composer — the R118-D native-growth geometry (spec §2.4)", () => {
  it("the constants pin: 6 lines, the 40px attach band, the 24px tall threshold", () => {
    expect(INPUT_MAX_LINES).toBe(6);
    expect(ATTACH_BAND).toBe(40);
    expect(INPUT_TALL_THRESHOLD).toBe(24);
  });

  it("the growth cap is EXACTLY 176 (6×21 + 10 + 40 — the tall band included)", () => {
    expect(MAX_INPUT_HEIGHT).toBe(176);
    expect(MAX_INPUT_HEIGHT).toBe(INPUT_MAX_LINES * 21 + 10 + ATTACH_BAND);
    // the tall threshold is the same arithmetic that used to drive the
    // controlled height: 44 − 2×10
    expect(INPUT_TALL_THRESHOLD).toBe(44 - 2 * 10);
  });
});
