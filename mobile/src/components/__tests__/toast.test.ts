/**
 * toast.test.ts — the R120-M toast law's compile-time pins, in the
 * clay-icon-chip.test.ts idiom: TYPE-ONLY imports (erased at runtime — the
 * mobile suite stays pure-logic, nothing pulls react-native into the jest
 * sandbox), so `npx tsc --noEmit` is the assertion's execution engine: if
 * the vocabulary drifts, THIS file stops compiling.
 *
 * What is pinned (round-120 §1 item 16 — "a failed model test and a
 * Hide-model action ... must be a toast that auto-dismisses in ~2s"):
 *   · ToastSpec carries EXACTLY the tone + the one text line — a toast
 *     never asks a question (no actions, no duration override, no stack
 *     position; the law owns all of those);
 *   · the tone set is the NoteLine's own three (saved / caution / error —
 *     no new vocabulary);
 *   · the show() seam takes a ToastSpec and returns void (the newest toast
 *     REPLACES the one before it — never a queue handle, never a dismiss
 *     token; the 2s auto-dismiss is the provider's own timer).
 */
import { describe, expect, it } from "@jest/globals";

import type { ToastSpec, ToastContextValue, ToastKind } from "@/components/toast";

// The spec's whole vocabulary — no accidental API creep beyond the law.
type SpecKeys = keyof ToastSpec;
type NoVocabularyDrift = Exclude<SpecKeys, "kind" | "text"> extends never ? true : never;
const vocabularyPinned: NoVocabularyDrift = true;

// The tone set is EXACTLY the NoteLine's three — both directions.
type ToneUnion = ToastKind;
type ToneIsTheNoteLineSet =
  | "saved"
  | "caution"
  | "error" extends ToneUnion
  ? Exclude<ToneUnion, "saved" | "caution" | "error"> extends never
    ? true
    : never
  : never;
const tonePinned: ToneIsTheNoteLineSet = true;

// show() takes the spec and answers void — no queue handle, no dismiss
// token (the auto-dismiss belongs to the provider, never the caller).
type ShowTakes = Parameters<ToastContextValue["show"]>[0];
type ShowTakesTheSpec = ShowTakes extends ToastSpec ? true : never;
const showTakesTheSpec: ShowTakesTheSpec = true;
type ShowReturns = ReturnType<ToastContextValue["show"]>;
const showReturnsVoid: ShowReturns extends void ? true : never = true;

describe("Toast — the R120-M toast law's vocabulary (item 16)", () => {
  it("ToastSpec is exactly the tone + the one text line — a toast never asks a question", () => {
    expect(vocabularyPinned).toBe(true);
  });

  it("the tone set is the NoteLine's own three: saved / caution / error", () => {
    expect(tonePinned).toBe(true);
  });

  it("show() takes one ToastSpec and answers void — the 2s auto-dismiss is never the caller's business", () => {
    expect(showTakesTheSpec).toBe(true);
    expect(showReturnsVoid).toBe(true);
  });
});
