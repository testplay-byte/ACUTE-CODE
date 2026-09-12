/**
 * R93 (the computer-use v2 rework): the ELEMENT MAP tests — identity
 * hashing (rect quantization), scan diffing (+new/−lost), the app-profile
 * upserts, the reliability counters, and the relocation scoring. The store
 * runs against the REAL migration-0034 schema (openDatabase applies every
 * pending migration — the same gate the app boots through).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  appProfile,
  elementIdentity,
  recordActionOutcome,
  registerScan,
  relocateElement,
} from "../src/computer/element-map";
import type { Element, Snapshot } from "../src/computer/types";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-elmap-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

// Lesson #88: every DB-opening test closes its handle — Windows refuses the
// afterAll rmSync (EPERM) while SQLite still holds the .db open.
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    stateId: "s-test",
    app: { pid: 4242, name: "Notepad", title: "Untitled - Notepad" },
    window: { title: "Untitled - Notepad", windowId: 7, bounds: [0, 0, 800, 600] },
    surface: { kind: "window", actualWindowId: 7, lifecycle: "stable" },
    elements: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

const el = (i: number, over: Partial<Element> = {}): Element => ({
  index: i,
  kind: "button",
  name: `btn-${i}`,
  flags: ["pressable"],
  ...(over.bounds !== undefined ? {} : {}),
  ...over,
});

describe("R93: element identity", () => {
  it("quantizes the rect to an 8px grid — a shift up to 7px keeps the identity", () => {
    const a = elementIdentity("App", "Win", "button", "Save", [10, 10, 100, 40]);
    const b = elementIdentity("App", "Win", "button", "Save", [14, 12, 102, 44]);
    const c = elementIdentity("App", "Win", "button", "Save", [30, 10, 120, 40]);
    expect(b).toBe(a); // within the quantum
    expect(c).not.toBe(a); // 20px = a different cell
  });

  it("different names / kinds / windows always differ", () => {
    const base = elementIdentity("App", "Win", "button", "Save", [0, 0, 10, 10]);
    expect(elementIdentity("App", "Win", "button", "Cancel", [0, 0, 10, 10])).not.toBe(base);
    expect(elementIdentity("App", "Win", "textfield", "Save", [0, 0, 10, 10])).not.toBe(base);
    expect(elementIdentity("App", "Other", "button", "Save", [0, 0, 10, 10])).not.toBe(base);
  });
});

describe("R93: registerScan — the diff loop", () => {
  it("the first scan counts every element NEW; nothing lost", () => {
    const delta = registerScan(db, makeSnapshot({ elements: [el(0), el(1), el(2)] }), "sess-1", 40);
    expect(delta.newCount).toBe(3);
    expect(delta.lostCount).toBe(0);
    expect(delta.knownTotal).toBe(3);
    expect(delta.newNames).toHaveLength(3);
    // The scan row landed.
    expect((db.prepare("SELECT COUNT(*) n FROM computer_scan").get() as { n: number }).n).toBe(1);
  });

  it("the SECOND identical scan: nothing new, nothing lost; seen_count bumps", () => {
    const snap = makeSnapshot({ elements: [el(0), el(1)] });
    registerScan(db, snap, "sess-1", 10);
    const delta2 = registerScan(db, snap, "sess-1", 8);
    expect(delta2.newCount).toBe(0);
    expect(delta2.lostCount).toBe(0);
    expect(delta2.knownTotal).toBe(2);
    const seen = db
      .prepare("SELECT seen_count FROM computer_element WHERE name = 'btn-0'")
      .get() as { seen_count: number };
    expect(seen.seen_count).toBe(2);
  });

  it("a REMOVED element counts lost (the row is KEPT, last_seen frozen)", () => {
    registerScan(db, makeSnapshot({ elements: [el(0), el(1)] }), "sess-1", 10);
    const delta2 = registerScan(db, makeSnapshot({ elements: [el(0)] }), "sess-1", 9);
    expect(delta2.lostCount).toBe(1);
    expect(delta2.newCount).toBe(0);
    // The row survives with its history.
    expect((db.prepare("SELECT COUNT(*) n FROM computer_element").get() as { n: number }).n).toBe(2);
    // …and a RETURNING element keeps its identity (not "new" again).
    const delta3 = registerScan(db, makeSnapshot({ elements: [el(0), el(1)] }), "sess-1", 9);
    expect(delta3.lostCount).toBe(0);
  });

  it("the app profile accumulates windows + stability", () => {
    registerScan(db, makeSnapshot({ elements: [el(0), el(1)] }), "s", 10);
    registerScan(
      db,
      makeSnapshot({
        window: { title: "settings.json - Notepad", windowId: 9, bounds: [0, 0, 800, 600] },
        elements: [el(0), el(1)],
      }),
      "s",
      12,
    );
    registerScan(db, makeSnapshot({ elements: [el(0), el(1)] }), "s", 8);
    // A 4th scan of window 1: its elements have now been seen 3 times —
    // the stability threshold.
    registerScan(db, makeSnapshot({ elements: [el(0), el(1)] }), "s", 7);
    const profile = appProfile(db, "Notepad");
    expect(profile.scanCount).toBe(4); // 3 on window 1 + 1 on the settings window
    expect(profile.windowTitles).toContain("Untitled - Notepad");
    expect(profile.windowTitles).toContain("settings.json - Notepad");
    expect(profile.elementCount).toBe(4); // two windows × two elements
    // seen_count >= 3 → stable (btn-0/btn-1 on the first window).
    expect(profile.stableElementCount).toBeGreaterThanOrEqual(2);
  });
});

describe("R93: recordActionOutcome — the reliability model", () => {
  it("verified outcomes bump both counters; unverified bump only the click", () => {
    const snap = makeSnapshot({ elements: [el(0)] });
    registerScan(db, snap, "s", 10);
    recordActionOutcome(db, "Notepad", "Untitled - Notepad", snap.elements[0]!, "matched");
    recordActionOutcome(db, "Notepad", "Untitled - Notepad", snap.elements[0]!, "unverified");
    recordActionOutcome(db, "Notepad", "Untitled - Notepad", snap.elements[0]!, undefined);
    const row = db
      .prepare("SELECT click_count, verify_success_count FROM computer_element WHERE name = 'btn-0'")
      .get() as { click_count: number; verify_success_count: number };
    expect(row.click_count).toBe(3);
    expect(row.verify_success_count).toBe(1);
    // …and appProfile surfaces the reliability leader.
    const profile = appProfile(db, "Notepad");
    expect(profile.mostReliable).toHaveLength(1);
    expect(profile.mostReliable[0]!.reliability).toBeCloseTo(1 / 3);
  });
});

describe("R93: relocateElement — the stale-target recovery", () => {
  const current: Element[] = [
    { index: 0, kind: "button", name: "Save", flags: [], bounds: [100, 100, 80, 30] },
    { index: 1, kind: "button", name: "Save as…", flags: [], bounds: [104, 140, 80, 30] },
    { index: 2, kind: "textfield", name: "Search", flags: [], bounds: [400, 100, 200, 30] },
    { index: 3, kind: "button", name: "Completely elsewhere", flags: [], bounds: [900, 700, 80, 30] },
  ];

  it("an exact name + same kind + nearby scores highest", () => {
    const stale: Element = {
      index: 9,
      kind: "button",
      name: "Save",
      flags: [],
      bounds: [102, 98, 80, 30],
    };
    const candidates = relocateElement(stale, current);
    expect(candidates[0]!.index).toBe(0);
    expect(candidates[0]!.score).toBeGreaterThanOrEqual(
      4.0 + 1.5 + 0.5, // name + kind + category, proximity adds more
    );
    expect(candidates[0]!.because).toContain("exact name");
  });

  it("a far-away different element never clears the threshold", () => {
    const stale: Element = {
      index: 9,
      kind: "slider",
      name: "Zoom",
      flags: [],
      bounds: [10, 500, 200, 20],
    };
    expect(relocateElement(stale, current)).toHaveLength(0);
  });

  it("bounded results, best first", () => {
    const stale: Element = {
      index: 9,
      kind: "button",
      name: "Save",
      flags: [],
      bounds: [102, 120, 80, 30],
    };
    const candidates = relocateElement(stale, current, 1);
    expect(candidates).toHaveLength(1);
  });
});
