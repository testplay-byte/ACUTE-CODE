/**
 * The updater ORCHESTRATION's tests (R124) — the anonymous-first check
 * policy with faked floors (no native bridge anywhere near this file):
 *
 *   · anonymous 200 → the interpreted answer, no token leg ever fired
 *   · anonymous 403 rate-limit + no token → rate-limited, tokenTried:false
 *   · anonymous 403 rate-limit + saved token → ONE token retry; a clean
 *     200 after it is interpreted normally
 *   · the token retry still rate-limited → rate-limited, tokenTried:true
 *   · anonymous 404 (the private-repo shape) + token → the retry leg
 *   · non-200 → the honest HTTP error state
 *   · the network THROW → the error state, never a rejection
 *
 * The SecureStore + Constants seams are the jest.setup.js globals (null
 * token; expoConfig may be undefined — APP_VERSION's fallback is exercised
 * implicitly).
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { checkForAppUpdate, deleteDownloadedUpdate } from "../updater";
import type { GithubFetch, GithubHttpAnswer, InstallerFloor } from "../installer-floor";
import { getSavedGithubToken, saveGithubToken } from "../updater";
import * as SecureStore from "expo-secure-store";

// The native floor is mocked OUT of the jest suite (the repo's discipline:
// nothing touches the native bridge at test time — installer-floor.ts is
// the single acute-installer import site, and this mock keeps the import
// chain from ever loading it). Every test below injects its own fake
// floors through checkForAppUpdate's deps anyway.
jest.mock("../installer-floor", () => ({
  githubFetch: {
    fetchLatestReleaseJson: async (): Promise<never> => {
      throw new Error("the real github floor is mocked out of the jest suite");
    },
  },
  installerFloor: {
    downloadApk: async (): Promise<never> => {
      throw new Error("the real installer floor is mocked out of the jest suite");
    },
    cancelDownload: async () => false,
    deleteDownloadedApk: async () => true,
    installApk: async () => undefined,
    canRequestInstalls: async () => true,
    openInstallPermissionSettings: async () => true,
    onProgress: () => () => undefined,
  },
}));

/** A fake fetch that answers a scripted sequence, recording every call's
 * headers (the token leg's presence is what these tests assert). */
function fakeFetch(answers: GithubHttpAnswer[], calls: Array<Record<string, string>>) {
  const impl: GithubFetch = {
    async fetchLatestReleaseJson(_url, headers) {
      calls.push(headers);
      const next = answers.shift();
      if (!next) throw new Error("no scripted answer left");
      return next;
    },
  };
  return impl;
}

const ok200 = (body: unknown): GithubHttpAnswer => ({
  status: 200,
  bodyText: JSON.stringify(body),
  rateLimitRemaining: "50",
});

const rate403: GithubHttpAnswer = {
  status: 403,
  bodyText: "API rate limit exceeded",
  rateLimitRemaining: "0",
};

const notFound404: GithubHttpAnswer = {
  status: 404,
  bodyText: "Not Found",
  rateLimitRemaining: null,
};

const release = (tag: string) => ({
  tag_name: tag,
  name: `v${tag}`,
  body: "notes",
  assets: [
    {
      name: "ACUTE-CODE_0.117.0_android-arm64.apk",
      url: "api",
      browser_download_url: "browser",
      size: 57,
    },
  ],
});

describe("checkForAppUpdate (anonymous-first policy)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  });

  it("interprets an anonymous 200 without ever building an Authorization header", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetch = fakeFetch([ok200(release("v0.117.0"))], calls);
    const check = await checkForAppUpdate({ fetch, now: () => 1234 });
    expect(check.kind).toBe("available");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.Authorization).toBeUndefined();
    if (check.kind === "available") expect(check.checkedAt).toBe(1234);
  });

  it("answers up-to-date when the release matches the build", async () => {
    // APP_VERSION falls back to "0.0.0" when expoConfig is absent in jest —
    // so a v0.0.0 release reads as up-to-date. That exercises the equal leg.
    const calls: Array<Record<string, string>> = [];
    const fetch = fakeFetch([ok200(release("v0.0.0"))], calls);
    const check = await checkForAppUpdate({ fetch });
    expect(check.kind).toBe("up-to-date");
  });

  it("answers rate-limited (tokenTried:false) when anonymous hits the limit with no token", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetch = fakeFetch([rate403], calls);
    const check = await checkForAppUpdate({ fetch });
    expect(check.kind).toBe("rate-limited");
    if (check.kind === "rate-limited") expect(check.tokenTried).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("retries ONCE with the token when anonymous rate-limits and a token is saved", async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue("ghp_saved-token");
    const calls: Array<Record<string, string>> = [];
    const fetch = fakeFetch([rate403, ok200(release("v0.117.0"))], calls);
    const check = await checkForAppUpdate({ fetch });
    expect(check.kind).toBe("available");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.Authorization).toBeUndefined();
    expect(calls[1]!.Authorization).toBe("Bearer ghp_saved-token");
  });

  it("answers rate-limited (tokenTried:true) when the token retry still hits the limit", async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue("ghp_saved-token");
    const calls: Array<Record<string, string>> = [];
    const fetch = fakeFetch([rate403, rate403], calls);
    const check = await checkForAppUpdate({ fetch });
    expect(check.kind).toBe("rate-limited");
    if (check.kind === "rate-limited") expect(check.tokenTried).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("treats a 404 as the private-repo shape and retries with the token", async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue("ghp_saved-token");
    const calls: Array<Record<string, string>> = [];
    const fetch = fakeFetch([notFound404, ok200(release("v0.117.0"))], calls);
    const check = await checkForAppUpdate({ fetch });
    expect(check.kind).toBe("available");
    expect(calls).toHaveLength(2);
  });

  it("answers the honest HTTP error on a plain non-200", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetch = fakeFetch([{ status: 500, bodyText: "boom", rateLimitRemaining: null }], calls);
    const check = await checkForAppUpdate({ fetch });
    expect(check.kind).toBe("error");
    if (check.kind === "error") expect(check.message).toContain("500");
  });

  it("answers the error state (never throws) when the fetch itself rejects", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetch: GithubFetch = {
      async fetchLatestReleaseJson() {
        calls.push({});
        throw new Error("airplane mode");
      },
    };
    const check = await checkForAppUpdate({ fetch });
    expect(check.kind).toBe("error");
    if (check.kind === "error") expect(check.message).toBe("airplane mode");
  });
});

describe("deleteDownloadedUpdate (R130-D — the discard affordance)", () => {
  it("hands the cached APK's path to the floor's deleteDownloadedApk — the screen's Delete button's whole job", async () => {
    const calls: Array<{ path: string }> = [];
    const floor: Pick<InstallerFloor, "deleteDownloadedApk"> = {
      deleteDownloadedApk: async (options) => {
        calls.push(options);
        return true;
      },
    };
    await deleteDownloadedUpdate("/cache/updates/app.apk", {
      installer: floor as InstallerFloor,
    });
    expect(calls).toEqual([{ path: "/cache/updates/app.apk" }]);
  });

  it("a floor failure propagates (the screen's catch owns the toast)", async () => {
    const floor: Pick<InstallerFloor, "deleteDownloadedApk"> = {
      deleteDownloadedApk: async () => {
        throw new Error("delete-failed");
      },
    };
    await expect(
      deleteDownloadedUpdate("/cache/updates/app.apk", { installer: floor as InstallerFloor }),
    ).rejects.toThrow("delete-failed");
  });
});

describe("the token store (SecureStore custody)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  });

  it("reads null when nothing is saved", async () => {
    expect(await getSavedGithubToken()).toBeNull();
  });

  it("trims on read", async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue("  ghp_token  ");
    expect(await getSavedGithubToken()).toBe("ghp_token");
  });

  it("treats a SecureStore failure as no-token (never throws)", async () => {
    jest.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("locked"));
    expect(await getSavedGithubToken()).toBeNull();
  });

  it("saves trimmed; an empty string CLEARS instead", async () => {
    await saveGithubToken("  ghp_token  ");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("acute.githubToken", "ghp_token");
    await saveGithubToken("   ");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("acute.githubToken");
  });
});
