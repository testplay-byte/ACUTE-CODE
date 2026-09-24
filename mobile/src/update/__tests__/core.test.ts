/**
 * The updater core's tests (R124) — every branch of the pure grammar:
 * tag parsing, version comparison, asset picking (both workflow naming
 * eras), release interpretation (all four honest states), byte formatting.
 * Pure TS only — no native imports anywhere near this file.
 */

import { describe, expect, it } from "@jest/globals";

import {
  compareVersions,
  formatBytes,
  interpretLatestRelease,
  parseReleaseTag,
  pickApkAsset,
} from "../core";

// ── parseReleaseTag ─────────────────────────────────────────────────────────

describe("parseReleaseTag", () => {
  it("parses the v-prefixed tag", () => {
    expect(parseReleaseTag("v0.117.0")).toBe("0.117.0");
  });
  it("parses the bare version", () => {
    expect(parseReleaseTag("0.117.0")).toBe("0.117.0");
  });
  it("trims whitespace", () => {
    expect(parseReleaseTag("  v1.2.3  ")).toBe("1.2.3");
  });
  it("rejects a draft-only tag", () => {
    expect(parseReleaseTag("v0.118.0-rc1")).toBeNull();
  });
  it("rejects two-component versions", () => {
    expect(parseReleaseTag("v0.118")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(parseReleaseTag("latest")).toBeNull();
    expect(parseReleaseTag("")).toBeNull();
  });
});

// ── compareVersions ─────────────────────────────────────────────────────────

describe("compareVersions", () => {
  it("orders major versions", () => {
    expect(compareVersions("0.116.0", "0.117.0")).toBe(-1);
    expect(compareVersions("0.117.0", "0.116.0")).toBe(1);
  });
  it("orders minor versions", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
  });
  it("orders patch versions", () => {
    expect(compareVersions("1.0.1", "1.0.2")).toBe(-1);
  });
  it("equals on identical versions", () => {
    expect(compareVersions("0.117.0", "0.117.0")).toBe(0);
  });
  it("accepts the v-prefixed shape on either side", () => {
    expect(compareVersions("v0.117.0", "0.116.0")).toBe(1);
  });
  it("sorts null (broken) versions LAST — a broken remote never reads as newer", () => {
    expect(compareVersions("0.1.0", "garbage")).toBe(1);
    expect(compareVersions("garbage", "0.1.0")).toBe(-1);
    expect(compareVersions("garbage", "junk")).toBe(0);
  });
});

// ── pickApkAsset ────────────────────────────────────────────────────────────

describe("pickApkAsset", () => {
  it("picks the current-workflow arm64 deliverable", () => {
    const asset = pickApkAsset([
      {
        name: "ACUTE-CODE_0.117.0_android-arm64.apk",
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/123",
        browser_download_url: "https://github.com/.../ACUTE-CODE_0.117.0_android-arm64.apk",
        size: 57_000_000,
      },
      { name: "ACUTE-CODE_0.117.0_x64-setup.exe", url: "u", browser_download_url: "b", size: 1 },
    ]);
    expect(asset).not.toBeNull();
    expect(asset!.name).toBe("ACUTE-CODE_0.117.0_android-arm64.apk");
    expect(asset!.size).toBe(57_000_000);
    expect(asset!.url).toContain("api.github.com");
    expect(asset!.browserDownloadUrl).toContain("github.com/...");
  });

  it("falls back to the legacy app-arm64-v8a-release.apk shape", () => {
    const asset = pickApkAsset([
      { name: "app-arm64-v8a-release.apk", url: "u", browser_download_url: "b", size: 1 },
    ]);
    expect(asset).not.toBeNull();
    expect(asset!.name).toBe("app-arm64-v8a-release.apk");
  });

  it("prefers the new shape over the legacy when both exist", () => {
    const asset = pickApkAsset([
      { name: "app-arm64-v8a-release.apk", url: "legacy", browser_download_url: "lb", size: 1 },
      { name: "ACUTE-CODE_0.117.0_android-arm64.apk", url: "modern", browser_download_url: "mb", size: 2 },
    ]);
    expect(asset!.url).toBe("modern");
  });

  it("returns null when no APK ships", () => {
    expect(
      pickApkAsset([
        { name: "ACUTE-CODE_0.117.0_x64-setup.exe", url: "u", browser_download_url: "b", size: 1 },
        { name: "ACUTE-CODE_0.117.0_amd64.AppImage", url: "u", browser_download_url: "b", size: 1 },
      ])
    ).toBeNull();
  });

  it("returns null on empty assets", () => {
    expect(pickApkAsset([])).toBeNull();
  });

  it("misses size gracefully (null, not NaN)", () => {
    const asset = pickApkAsset([{ name: "ACUTE-CODE_0.117.0_android-arm64.apk", url: "u" }]);
    expect(asset!.size).toBeNull();
    expect(asset!.browserDownloadUrl).toBe("u"); // falls back to the API url
  });
});

// ── interpretLatestRelease — the four honest states ────────────────────────

describe("interpretLatestRelease", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    tag_name: "v0.117.0",
    name: "v0.117.0 — the round's title",
    body: "The release notes, plain text.",
    assets: [
      {
        name: "ACUTE-CODE_0.117.0_android-arm64.apk",
        url: "api-asset-url",
        browser_download_url: "browser-asset-url",
        size: 57_000_000,
      },
    ],
    ...overrides,
  });

  it("answers available when the remote is newer", () => {
    const check = interpretLatestRelease(body(), "0.116.0");
    expect(check.kind).toBe("available");
    if (check.kind !== "available") return;
    expect(check.current).toBe("0.116.0");
    expect(check.version).toBe("0.117.0");
    expect(check.title).toBe("v0.117.0 — the round's title");
    expect(check.notes).toBe("The release notes, plain text.");
    expect(check.apk).not.toBeNull();
    expect(check.apk!.size).toBe(57_000_000);
  });

  it("answers up-to-date on the same version", () => {
    const check = interpretLatestRelease(body(), "0.117.0");
    expect(check.kind).toBe("up-to-date");
    if (check.kind !== "up-to-date") return;
    expect(check.latest).toBe("0.117.0");
  });

  it("answers up-to-date when the local build is NEWER than the release", () => {
    const check = interpretLatestRelease(body(), "0.118.0");
    expect(check.kind).toBe("up-to-date");
  });

  it("answers available with a null apk when the release ships no APK", () => {
    const check = interpretLatestRelease(body({ assets: [] }), "0.116.0");
    expect(check.kind).toBe("available");
    if (check.kind !== "available") return;
    expect(check.apk).toBeNull();
  });

  it("falls back to the tag as the title when the release name is blank", () => {
    const check = interpretLatestRelease(body({ name: "   " }), "0.116.0");
    if (check.kind !== "available") throw new Error("expected available");
    expect(check.title).toBe("v0.117.0");
  });

  it("answers error on a non-version tag", () => {
    const check = interpretLatestRelease(body({ tag_name: "nightly" }), "0.116.0");
    expect(check.kind).toBe("error");
    if (check.kind !== "error") return;
    expect(check.message).toContain("nightly");
  });

  it("answers error on a missing tag", () => {
    const check = interpretLatestRelease(body({ tag_name: undefined }), "0.116.0");
    expect(check.kind).toBe("error");
  });

  it("answers error on a non-object body", () => {
    expect(interpretLatestRelease("nope", "0.116.0").kind).toBe("error");
    expect(interpretLatestRelease(null, "0.116.0").kind).toBe("error");
    expect(interpretLatestRelease(undefined, "0.116.0").kind).toBe("error");
  });

  it("treats a missing body as empty notes (not an error)", () => {
    const check = interpretLatestRelease(body({ body: undefined }), "0.116.0");
    if (check.kind !== "available") throw new Error("expected available");
    expect(check.notes).toBe("");
  });
});

// ── formatBytes ─────────────────────────────────────────────────────────────

describe("formatBytes", () => {
  it("formats megabytes", () => {
    expect(formatBytes(57_000_000)).toBe("54 MB");
    expect(formatBytes(56_842_097)).toBe("54 MB");
  });
  it("formats gigabytes", () => {
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
  it("formats kilobytes under 1 MB", () => {
    expect(formatBytes(500_000)).toBe("488 KB");
    expect(formatBytes(1024)).toBe("1 KB");
  });
  it("handles zero", () => {
    expect(formatBytes(0)).toBe("0 MB");
  });
});
