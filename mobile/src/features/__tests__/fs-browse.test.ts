/**
 * fs-browse.test.ts — the phone's folder-picker client (R114-c): the typed
 * GET /api/v1/system/fs/browse pair (blank path → the server home; the
 * path rides URL-encoded; the outcome carries the R114-b wire shape
 * verbatim) and the breadcrumb fold the picker's tappable ancestry renders
 * from. Injected sender fakes only — zero React Native.
 *
 * R118-E — the CREATE-FOLDER client (§2D): createFsFolder's POST (path +
 * bodyText JSON + the 201/409/400/404 outcomes), folderNameValid's table
 * (the same rules the route enforces server-side), and joinChildPath's
 * separator table (posix + Windows + trailing slashes).
 */

import { describe, expect, it } from "@jest/globals";

import type { ApiSender } from "../api";
import {
  breadcrumbSegments,
  createFsFolder,
  fetchFsBrowse,
  folderNameValid,
  joinChildPath,
  shortRootPath,
} from "../fs-browse";

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

// ── the create-folder client (R118-E §2D) ──────────────────────────────────

describe("createFsFolder — POST /system/fs/mkdir", () => {
  it("POSTs the {parentPath, name} body as JSON to the mkdir route", async () => {
    const { sender, calls } = makeApiSender(() => ({
      status: 201,
      bodyText: JSON.stringify({ path: "/home/z/repos/new-folder", name: "new-folder", dir: true }),
    }));
    const outcome = await createFsFolder(sender, "/home/z/repos", "new-folder");
    expect(calls[0]?.path).toBe("/api/v1/system/fs/mkdir");
    expect(calls[0]?.init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(calls[0]?.init?.bodyText))).toEqual({
      parentPath: "/home/z/repos",
      name: "new-folder",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The reply is the browse entry's shape verbatim.
      expect(outcome.data).toEqual({ path: "/home/z/repos/new-folder", name: "new-folder", dir: true });
    }
  });

  it("409 CONFLICT is the honest already-exists OUTCOME — never a throw", async () => {
    const { sender } = makeApiSender(() => ({
      status: 409,
      bodyText: JSON.stringify({
        error: { code: "CONFLICT", message: "'/home/z/repos/new-folder' already exists" },
      }),
    }));
    const outcome = await createFsFolder(sender, "/home/z/repos", "new-folder");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.status).toBe(409);
      expect(outcome.error.code).toBe("CONFLICT");
      expect(outcome.error.message).toContain("already exists");
    }
  });

  it("400 VALIDATION (a refused name/parent) rides the outcome verbatim", async () => {
    const { sender } = makeApiSender(() => ({
      status: 400,
      bodyText: JSON.stringify({
        error: { code: "VALIDATION", message: "body.name cannot contain separators" },
      }),
    }));
    const outcome = await createFsFolder(sender, "/home/z/repos", "a/b");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.status).toBe(400);
      expect(outcome.error.code).toBe("VALIDATION");
      expect(outcome.error.message).toContain("separators");
    }
  });

  it("404 NOT_FOUND (a missing parent — or an older sidecar with no route) is an outcome", async () => {
    const { sender } = makeApiSender(() => ({
      status: 404,
      bodyText: JSON.stringify({
        error: { code: "NOT_FOUND", message: "cannot create in '/nope': ENOENT" },
      }),
    }));
    const outcome = await createFsFolder(sender, "/nope", "new-folder");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.status).toBe(404);
      expect(outcome.error.code).toBe("NOT_FOUND");
    }
  });

  it("a non-JSON 2xx body is the honest BAD_JSON outcome — never a fabricated entry", async () => {
    const { sender } = makeApiSender(() => ({ status: 201, bodyText: "<html>" }));
    const outcome = await createFsFolder(sender, "/home/z/repos", "new-folder");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("BAD_JSON");
    }
  });
});

describe("folderNameValid — the inline namer's rules", () => {
  const TABLE: ReadonlyArray<{ name: string; expected: { ok: boolean; value: string } }> = [
    // A plain name trims and passes.
    { name: "new-folder", expected: { ok: true, value: "new-folder" } },
    { name: "  spaced  ", expected: { ok: true, value: "spaced" } },
    // Blank (after trim) is refused.
    { name: "", expected: { ok: false, value: "a folder name is required" } },
    { name: "   ", expected: { ok: false, value: "a folder name is required" } },
    // Separators are refused (either flavor).
    { name: "a/b", expected: { ok: false, value: "a folder name cannot contain separators" } },
    { name: "a\\b", expected: { ok: false, value: "a folder name cannot contain separators" } },
    // The dot-only names are refused.
    { name: ".", expected: { ok: false, value: "choose a real folder name" } },
    { name: "..", expected: { ok: false, value: "choose a real folder name" } },
    // A leading dot hides the folder from the picker — refused.
    { name: ".env", expected: { ok: false, value: "folder names cannot start with a dot" } },
    // Control characters are refused.
    { name: "bad\nname", expected: { ok: false, value: "folder names cannot contain control characters" } },
    { name: "bad\u0007name", expected: { ok: false, value: "folder names cannot contain control characters" } },
  ];

  it.each(TABLE)("folderNameValid(%j) → %j", ({ name, expected }) => {
    const result = folderNameValid(name);
    if (expected.ok) {
      expect(result).toEqual({ ok: true, name: expected.value });
    } else {
      expect(result).toEqual({ ok: false, message: expected.value });
    }
  });

  it("61 characters is over the cap; 60 passes (the route's own ceiling)", () => {
    expect(folderNameValid("a".repeat(61))).toEqual({
      ok: false,
      message: "folder names are capped at 60 characters",
    });
    expect(folderNameValid("a".repeat(60))).toEqual({ ok: true, name: "a".repeat(60) });
  });
});

describe("joinChildPath — the parent's own separator", () => {
  const TABLE: ReadonlyArray<{ parent: string; name: string; expected: string }> = [
    // POSIX parents join with "/".
    { parent: "/home/z/repos", name: "new-folder", expected: "/home/z/repos/new-folder" },
    // A trailing separator never doubles.
    { parent: "/home/z/repos/", name: "new-folder", expected: "/home/z/repos/new-folder" },
    { parent: "/home/z/repos//", name: "new-folder", expected: "/home/z/repos/new-folder" },
    // Windows parents join with "\" — the parent's own separator.
    { parent: "C:\\Users\\z\\repos", name: "new-folder", expected: "C:\\Users\\z\\repos\\new-folder" },
    { parent: "C:\\Users\\z\\repos\\", name: "new-folder", expected: "C:\\Users\\z\\repos\\new-folder" },
    // A Windows drive root keeps its backslash form.
    { parent: "C:\\", name: "new-folder", expected: "C:\\new-folder" },
    // A forward-slash Windows spelling stays forward-slash.
    { parent: "C:/Users/z", name: "new-folder", expected: "C:/Users/z/new-folder" },
  ];

  it.each(TABLE)("joinChildPath(%j, %j) → %j", ({ parent, name, expected }) => {
    expect(joinChildPath(parent, name)).toBe(expected);
  });
});
