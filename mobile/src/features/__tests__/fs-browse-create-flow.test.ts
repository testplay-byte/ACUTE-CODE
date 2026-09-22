/**
 * fs-browse-create-flow.test.ts — the optimistic create-folder flow's pure
 * leg (R118-E §5.4): the moment POST /system/fs/mkdir answers 201, the New
 * Project sheet flips to the SELECTED state on the REPLY's path and plants
 * the created entry into the current listing through nextBrowseAfterCreate
 * — dirs-first, alphabetical within the directory group (the route's own
 * order) — so a fast "Select another folder" tap already sees the new
 * folder while the background re-browse reconciles. Injected sender fakes
 * only — zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import type { ApiSender } from "../api";
import { createFsFolder, nextBrowseAfterCreate, type FsBrowseReply } from "../fs-browse";

function makeApiSender(
  respond: () => { status: number; bodyText: string },
): { sender: ApiSender } {
  const sender: ApiSender = {
    async api(_path: string, _init = {}) {
      const res = respond();
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        headers: {},
        bodyText: res.bodyText,
      };
    },
  };
  return { sender };
}

/** A realistic listing: dirs then files, each alphabetical (the route's order). */
const BROWSE: FsBrowseReply = {
  path: "/home/z/repos",
  parent: "/home/z",
  entries: [
    { name: "acute-code", path: "/home/z/repos/acute-code", dir: true },
    { name: "dashboard", path: "/home/z/repos/dashboard", dir: true },
    { name: "zeta", path: "/home/z/repos/zeta", dir: true },
    { name: "app.ts", path: "/home/z/repos/app.ts", dir: false },
    { name: "notes.txt", path: "/home/z/repos/notes.txt", dir: false },
  ],
  truncated: false,
};

describe("nextBrowseAfterCreate — the optimistic listing", () => {
  it("inserts the created entry DIRS-FIRST, alphabetical within the directory group", () => {
    const next = nextBrowseAfterCreate(BROWSE, {
      name: "middle-folder",
      path: "/home/z/repos/middle-folder",
      dir: true,
    });
    expect(next.entries.map((e) => e.name)).toEqual([
      "acute-code",
      "dashboard",
      "middle-folder", // alphabetical among the dirs…
      "zeta",
      "app.ts", // …and still ahead of every file.
      "notes.txt",
    ]);
    expect(next.entries[2]).toEqual({ name: "middle-folder", path: "/home/z/repos/middle-folder", dir: true });
  });

  it("a name sorting BEFORE the existing dirs lands at the head; one after them, at the dir tail", () => {
    expect(
      nextBrowseAfterCreate(BROWSE, { name: "aaa", path: "/home/z/repos/aaa", dir: true }).entries.map(
        (e) => e.name,
      )[0],
    ).toBe("aaa");
    expect(
      nextBrowseAfterCreate(BROWSE, { name: "zzz-last", path: "/home/z/repos/zzz-last", dir: true }).entries.map(
        (e) => e.name,
      ),
    ).toEqual(["acute-code", "dashboard", "zeta", "zzz-last", "app.ts", "notes.txt"]);
  });

  it("the created entry's path IS the reply's path — the auto-select target and the listing share ONE truth", () => {
    const reply = { name: "fresh", path: "/home/z/repos/fresh", dir: true as const };
    const next = nextBrowseAfterCreate(BROWSE, reply);
    // The sheet's selectFolder rides outcome.data.path; the optimistic
    // listing's inserted entry rides the SAME field — never a re-derived
    // join that could drift from what the server answered.
    const inserted = next.entries.find((e) => e.name === "fresh");
    expect(inserted?.path).toBe(reply.path);
  });

  it("never mutates the input listing (the background re-browse owns the reconciliation)", () => {
    const before = JSON.parse(JSON.stringify(BROWSE)) as FsBrowseReply;
    nextBrowseAfterCreate(BROWSE, { name: "fresh", path: "/home/z/repos/fresh", dir: true });
    expect(BROWSE).toEqual(before);
  });

  it("a same-path entry (a race the re-browse already settled) is REPLACED, never duplicated", () => {
    const next = nextBrowseAfterCreate(BROWSE, {
      name: "dashboard",
      path: "/home/z/repos/dashboard",
      dir: true,
    });
    expect(next.entries.filter((e) => e.name === "dashboard")).toHaveLength(1);
    expect(next.entries).toHaveLength(BROWSE.entries.length);
  });

  it("an empty listing becomes the single created entry (the empty state's affordance)", () => {
    const empty: FsBrowseReply = { path: "/home/z/empty", parent: "/home/z", entries: [], truncated: false };
    const next = nextBrowseAfterCreate(empty, { name: "first", path: "/home/z/empty/first", dir: true });
    expect(next.entries).toEqual([{ name: "first", path: "/home/z/empty/first", dir: true }]);
  });
});

describe("the create flow's outcome feeds the optimistic listing verbatim", () => {
  it("a 201 reply's {path, name, dir} rides nextBrowseAfterCreate untouched", async () => {
    const { sender } = makeApiSender(() => ({
      status: 201,
      bodyText: JSON.stringify({ path: "/home/z/repos/fresh", name: "fresh", dir: true }),
    }));
    const outcome = await createFsFolder(sender, "/home/z/repos", "fresh");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const next = nextBrowseAfterCreate(BROWSE, outcome.data);
      const inserted = next.entries.find((e) => e.name === outcome.data.name);
      expect(inserted).toEqual(outcome.data);
    }
  });
});
