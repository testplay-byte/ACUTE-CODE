/**
 * fs-browse.test.ts — the phone's folder-picker client (R114-c): the typed
 * GET /api/v1/system/fs/browse pair (blank path → the server home; the
 * path rides URL-encoded; the outcome carries the R114-b wire shape
 * verbatim) and the breadcrumb fold the picker's tappable ancestry renders
 * from. Injected sender fakes only — zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import type { ApiSender } from "../api";
import { breadcrumbSegments, fetchFsBrowse, shortRootPath } from "../fs-browse";

// ── fixtures ────────────────────────────────────────────────────────────────

const HOME_REPLY = {
  path: "/home/z",
  parent: "/home",
  entries: [
    { name: "repos", path: "/home/z/repos", dir: true },
    { name: "notes.txt", path: "/home/z/notes.txt", dir: false },
  ],
  truncated: false,
};

function makeApiSender(
  respond: (path: string) => { status: number; bodyText: string },
): {
  sender: ApiSender;
  calls: Array<{ path: string; init?: Record<string, unknown> }>;
} {
  const calls: Array<{ path: string; init?: Record<string, unknown> }> = [];
  const sender: ApiSender = {
    async api(path, init = {}) {
      calls.push({ path, init: init as Record<string, unknown> });
      const res = respond(path);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        headers: {},
        bodyText: res.bodyText,
      };
    },
  };
  return { sender, calls };
}

// ── the client ──────────────────────────────────────────────────────────────

describe("fetchFsBrowse — the R114-b wire contract", () => {
  it("blank/omitted path browses the SERVER home (no query at all)", async () => {
    const { sender, calls } = makeApiSender(() => ({
      status: 200,
      bodyText: JSON.stringify(HOME_REPLY),
    }));
    const outcome = await fetchFsBrowse(sender);
    expect(calls[0]?.path).toBe("/api/v1/system/fs/browse");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.path).toBe("/home/z");
      expect(outcome.data.parent).toBe("/home");
      expect(outcome.data.truncated).toBe(false);
      expect(outcome.data.entries).toEqual(HOME_REPLY.entries);
    }
  });

  it("an explicit path rides URL-encoded as the path query param", async () => {
    const { sender, calls } = makeApiSender(() => ({
      status: 200,
      bodyText: JSON.stringify(HOME_REPLY),
    }));
    await fetchFsBrowse(sender, "/home/z/my repos/acute code");
    expect(calls[0]?.path).toBe(
      "/api/v1/system/fs/browse?path=%2Fhome%2Fz%2Fmy%20repos%2Facute%20code",
    );
  });

  it("a whitespace-only path is treated as blank (the home browse)", async () => {
    const { sender, calls } = makeApiSender(() => ({
      status: 200,
      bodyText: JSON.stringify(HOME_REPLY),
    }));
    await fetchFsBrowse(sender, "   ");
    expect(calls[0]?.path).toBe("/api/v1/system/fs/browse");
  });

  it("a missing folder is the route's honest 404 OUTCOME — never a throw", async () => {
    const { sender } = makeApiSender(() => ({
      status: 404,
      bodyText: JSON.stringify({
        error: { code: "NOT_FOUND", message: "cannot browse '/nope': ENOENT" },
      }),
    }));
    const outcome = await fetchFsBrowse(sender, "/nope");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.status).toBe(404);
      expect(outcome.error.code).toBe("NOT_FOUND");
      expect(outcome.error.message).toContain("ENOENT");
    }
  });

  it("a non-JSON 2xx body is the honest BAD_JSON outcome — never a fabricated value", async () => {
    const { sender } = makeApiSender(() => ({ status: 200, bodyText: "<html>" }));
    const outcome = await fetchFsBrowse(sender);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("BAD_JSON");
    }
  });
});

// ── the breadcrumb fold ─────────────────────────────────────────────────────

describe("breadcrumbSegments — the picker's tappable ancestry", () => {
  it("splits a POSIX absolute path into prefix crumbs", () => {
    expect(breadcrumbSegments("/home/z/repos/acute-code")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "z", path: "/home/z" },
      { label: "repos", path: "/home/z/repos" },
      { label: "acute-code", path: "/home/z/repos/acute-code" },
    ]);
  });

  it("the filesystem root is ONE crumb; a trailing slash adds nothing", () => {
    expect(breadcrumbSegments("/")).toEqual([{ label: "/", path: "/" }]);
    expect(breadcrumbSegments("")).toEqual([{ label: "/", path: "/" }]);
    expect(breadcrumbSegments("/home/z/")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "z", path: "/home/z" },
    ]);
  });

  it("Windows separators normalize; the drive root keeps its own crumb", () => {
    expect(breadcrumbSegments("C:\\Users\\z\\repos")).toEqual([
      { label: "C:", path: "C:" },
      { label: "Users", path: "C:/Users" },
      { label: "z", path: "C:/Users/z" },
      { label: "repos", path: "C:/Users/z/repos" },
    ]);
  });
});

// ── the smart path line (R115-h — the project row's TypeMono meta;
// R116-k — the budget tightened 28 → 22, a mono-12px string the row can
// actually show alongside its ellipsizeMode="head" clamp) ────────────────

describe("shortRootPath — the project row's folded root path", () => {
  const TABLE: ReadonlyArray<{ rootPath: string; projectName: string; expected: string }> = [
    // The filesystem root answers itself.
    { rootPath: "/", projectName: "anything", expected: "/" },
    // A single segment fits — and never drops, even when it IS the name
    // (the path would otherwise collapse to a bare "/").
    { rootPath: "/srv", projectName: "other", expected: "/srv" },
    { rootPath: "/dashboard", projectName: "dashboard", expected: "/dashboard" },
    // The trailing project-name segment drops (case-insensitive) — the row
    // already says the name; the path line orients.
    { rootPath: "/home/z/repos/acute-code", projectName: "acute-code", expected: "/home/z/repos" },
    { rootPath: "/home/z/repos/ACUTE-CODE", projectName: "Acute-Code", expected: "/home/z/repos" },
    // Overflow sheds the leading folders under a "…/" prefix — the TAIL
    // that fits the 22-char budget is what stays (the row's head clamp
    // keeps the surviving tail honest at any residual overflow).
    {
      rootPath: "/home/z/dev/projects/very/deeply/nested/here/now",
      projectName: "proj",
      expected: "…/nested/here/now",
    },
    // Windows drives normalize to "/"; the drive root answers "C:/".
    { rootPath: "C:\\Users\\z\\repos\\dashboard", projectName: "dashboard", expected: "C:/Users/z/repos" },
    { rootPath: "C:\\", projectName: "proj", expected: "C:/" },
    // A single over-long segment (40 chars > the budget) middle-truncates.
    {
      rootPath: `/home/z/repos/${"a".repeat(40)}`,
      projectName: "proj",
      expected: `${"a".repeat(11)}…${"a".repeat(10)}`,
    },
  ];

  it.each(TABLE)(
    "shortRootPath(%j, %j) folds to %j",
    ({ rootPath, projectName, expected }) => {
      expect(shortRootPath(rootPath, projectName)).toBe(expected);
    },
  );

  it("the budget is callable — a tighter budget sheds more leading folders", () => {
    // At the default 22 the full tail fits; at 12 only the deepest pair.
    expect(shortRootPath("/home/z/repos/acute-code", "acute-code")).toBe("/home/z/repos");
    expect(shortRootPath("/home/z/repos/acute-code", "acute-code", 12)).toBe("…/z/repos");
  });
});
