/**
 * screen-scaffold.test.ts — the compact-only header contract (R113-e: the
 * owner: "at the very top on every single one of the screens it shows the
 * headings… takes up way too much important space"). The mobile suite is
 * PURE-LOGIC by convention (jest.config.js: "no screen snapshots, no native
 * bridge"), so the pin is the compile-time surface: the large TypeDisplay
 * header tier is GONE from the scaffold's props — every screen, tab roots
 * included, renders the one compact row (title + caption + right + pill).
 * The import is TYPE-ONLY (erased at runtime — zero React Native pulled in),
 * which makes `npm run typecheck` the assertion's execution engine: if the
 * `large` prop ever came back, THIS file stops compiling.
 */

import { describe, expect, it } from "@jest/globals";

import type { ScreenScaffoldProps } from "@/components/screen-scaffold";

// The R113-e verdict, as types: no `large` key on the scaffold's props.
type LargeIsGone = "large" extends keyof ScreenScaffoldProps ? never : "compact-only";
const headerTier: LargeIsGone = "compact-only";

// The compact row's own vocabulary stays: title (required), the optional
// context caption, the right slot, back — and nothing else beyond the body
// plumbing.
type ExpectedKeys =
  | "title"
  | "subtitle"
  | "back"
  | "right"
  | "children"
  | "refreshControl"
  | "scroll"
  | "bottomInset"
  | "keyboardAware"
  | "noPill"
  | "tabBarAware";
type PropKeys = keyof ScreenScaffoldProps;
type NoNewHeaderVocabulary = Exclude<PropKeys, ExpectedKeys> extends never ? true : never;
const vocabularyPinned: NoNewHeaderVocabulary = true;

describe("ScreenScaffold — the compact-only header (R113-e)", () => {
  it("the large-title prop is deleted; the compact vocabulary is the whole surface", () => {
    // The runtime mirror of the compile-time pins above (both would fail to
    // COMPILE first — that is the point: typecheck is the gate that runs them).
    expect(headerTier).toBe("compact-only");
    expect(vocabularyPinned).toBe(true);
  });

  it("subtitle stays an OPTIONAL context line (pushed screens' status/kind; tab roots pass none)", () => {
    // Compile-time: `subtitle?: string` — its absence must remain legal and
    // a pushed screen's context line must still typecheck.
    const props: Pick<ScreenScaffoldProps, "title" | "subtitle"> = { title: "Projects" };
    expect(props.title).toBe("Projects");
    expect(props.subtitle).toBeUndefined();
  });
});
