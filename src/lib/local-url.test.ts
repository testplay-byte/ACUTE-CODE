// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fileUrlToLocalPath, normalizeBrowserUrl } from "./local-url";

/**
 * ROUND-95 (R95-C) — the local-path → file:// normalization the browser
 * panel's address bar (and, in mirrored form, the agent-core browser tool)
 * runs before any navigation. Pure functions, node env (the WHATWG URL
 * parser is the engine under test).
 */
describe("normalizeBrowserUrl (R95-C)", () => {
  it("converts Windows drive paths (both slash styles), keeping query/hash and encoding segments", () => {
    expect(normalizeBrowserUrl("C:\\Users\\me\\page.html")).toEqual({
      url: "file:///C:/Users/me/page.html",
    });
    expect(normalizeBrowserUrl("C:/Users/me/page.html")).toEqual({
      url: "file:///C:/Users/me/page.html",
    });
    expect(normalizeBrowserUrl("D:\\My Files\\demo page.htm?q=1#top")).toEqual({
      url: "file:///D:/My%20Files/demo%20page.htm?q=1#top",
    });
  });

  it("converts POSIX absolute paths", () => {
    expect(normalizeBrowserUrl("/home/z/repos/demo.html")).toEqual({
      url: "file:///home/z/repos/demo.html",
    });
    expect(normalizeBrowserUrl("/tmp/my page.html")).toEqual({
      url: "file:///tmp/my%20page.html",
    });
  });

  it("converts UNC paths into file://server/share form", () => {
    expect(normalizeBrowserUrl("\\\\server\\share\\index.html")).toEqual({
      url: "file://server/share/index.html",
    });
    // Host-only collapses to the server root (a directory — the local-file
    // route refuses directories honestly); a bare `\\` has nothing at all.
    expect(normalizeBrowserUrl("\\\\server")).toEqual({ url: "file://server/" });
    expect(normalizeBrowserUrl("\\\\")).toEqual({ error: expect.stringContaining("UNC") });
  });

  it("canonicalizes explicit file:// URLs and refuses unparseable ones", () => {
    expect(normalizeBrowserUrl("file:///C:/Users/me/page.html")).toEqual({
      url: "file:///C:/Users/me/page.html",
    });
    // A lone % in a PATH is passed through by the lenient WHATWG parser —
    // only a truly broken AUTHORITY (an invalid host) throws.
    expect(normalizeBrowserUrl("file:///C:/bad/%/name")).toEqual({
      url: "file:///C:/bad/%/name",
    });
    const broken = normalizeBrowserUrl("file://[");
    expect(broken !== null && "error" in broken).toBe(true);
  });

  it("passes http(s) through UNCHANGED and returns null for other schemes", () => {
    expect(normalizeBrowserUrl("https://github.com")).toEqual({ url: "https://github.com" });
    expect(normalizeBrowserUrl("http://127.0.0.1:5173/")).toEqual({ url: "http://127.0.0.1:5173/" });
    // about:/data:/mailto: are NOT local paths — the caller's legacy
    // handling decides (the panel passes them through; the backend refuses).
    expect(normalizeBrowserUrl("about:blank")).toBeNull();
    expect(normalizeBrowserUrl("data:text/html,hi")).toBeNull();
  });

  it("refuses relative local paths honestly (no base to resolve against)", () => {
    for (const input of ["demo.html", "./demo.html", "folder/demo.htm", "pic.svg?x=1"]) {
      const result = normalizeBrowserUrl(input);
      expect(result !== null && "error" in result).toBe(true);
      expect((result as { error: string }).error).toContain("absolute path");
    }
  });

  it("returns null for bare domains and search-shaped input (the caller's legacy call)", () => {
    expect(normalizeBrowserUrl("github.com")).toBeNull();
    expect(normalizeBrowserUrl("how do I center a div")).toBeNull();
    // A scheme-relative URL is NOT a local path — legacy owns it.
    expect(normalizeBrowserUrl("//example.com/x")).toBeNull();
    expect(normalizeBrowserUrl("")).toEqual({ error: expect.stringContaining("empty") });
  });
});

describe("fileUrlToLocalPath (R95-C)", () => {
  it("decodes Windows-drive, POSIX and UNC file URLs back to local paths", () => {
    expect(fileUrlToLocalPath("file:///C:/Users/me/page.html")).toBe("C:/Users/me/page.html");
    expect(fileUrlToLocalPath("file:///home/z/repos/demo.html")).toBe("/home/z/repos/demo.html");
    expect(fileUrlToLocalPath("file://server/share/index.html")).toBe("\\\\server\\share\\index.html");
    expect(fileUrlToLocalPath("file:///D:/My%20Files/page.htm")).toBe("D:/My Files/page.htm");
  });

  it("returns null for non-file URLs and unparseable input", () => {
    expect(fileUrlToLocalPath("https://github.com")).toBeNull();
    expect(fileUrlToLocalPath("not a url")).toBeNull();
  });
});
