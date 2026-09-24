/**
 * ROUND-125 (R125-3): the per-session composer draft store's pins — the
 * owner's ask ("if I write a message and then switch to another section,
 * then it should remember which message was typed there") as pure laws:
 * save/load round-trips per session, blank clears, the send path's clear,
 * the cap, the eviction bound, and the never-throws degradation (corrupt
 * blob, unavailable storage).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionDraft,
  loadSessionDraft,
  MAX_DRAFT_CHARS,
  MAX_SESSION_DRAFTS,
  saveSessionDraft,
  setDraftStorageForTest,
} from "./draft-store";

/** A fresh in-memory localStorage fake (the Web Storage contract subset). */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

afterEach(() => {
  // Reset the seam to the UNAVAILABLE leg between cases (a leaked fake — or
  // the host's real localStorage — would cross-contaminate suites; every
  // case that needs storage installs its own fake).
  setDraftStorageForTest(null);
  vi.restoreAllMocks();
});

describe("ROUND-125 (R125-3): per-session drafts — the round-trip laws", () => {
  it("saves and loads a draft per session — two sessions never see each other's text", () => {
    setDraftStorageForTest(fakeStorage());
    saveSessionDraft("sess_a", "fix the login redirect");
    saveSessionDraft("sess_b", "refactor the store next");
    expect(loadSessionDraft("sess_a")).toBe("fix the login redirect");
    expect(loadSessionDraft("sess_b")).toBe("refactor the store next");
  });

  it("the LAST save for one session wins (typing updates the draft, not duplicates)", () => {
    setDraftStorageForTest(fakeStorage());
    saveSessionDraft("sess_a", "first attempt");
    saveSessionDraft("sess_a", "second attempt with more context");
    expect(loadSessionDraft("sess_a")).toBe("second attempt with more context");
  });

  it("a BLANK draft deletes the entry (an emptied composer is not a draft)", () => {
    setDraftStorageForTest(fakeStorage());
    saveSessionDraft("sess_a", "half-typed thought");
    saveSessionDraft("sess_a", "   ");
    expect(loadSessionDraft("sess_a")).toBe("");
  });

  it("clearSessionDraft removes exactly its own entry (the send path)", () => {
    setDraftStorageForTest(fakeStorage());
    saveSessionDraft("sess_a", "sent already");
    saveSessionDraft("sess_b", "still typing");
    clearSessionDraft("sess_a");
    expect(loadSessionDraft("sess_a")).toBe("");
    expect(loadSessionDraft("sess_b")).toBe("still typing");
  });

  it("loadSessionDraft answers '' for an unknown session (never null, never throws)", () => {
    setDraftStorageForTest(fakeStorage());
    expect(loadSessionDraft("sess_never")).toBe("");
    expect(loadSessionDraft("")).toBe("");
  });

  it("drafts SURVIVE a storage seam swap-and-back (real persistence, not memory)", () => {
    const store = fakeStorage();
    setDraftStorageForTest(store);
    saveSessionDraft("sess_a", "persistent draft");
    // A NEW seam over the SAME store — the module re-reads the blob.
    setDraftStorageForTest(store);
    expect(loadSessionDraft("sess_a")).toBe("persistent draft");
  });
});

describe("ROUND-125 (R125-3): the bounds", () => {
  it("an over-long draft is capped at MAX_DRAFT_CHARS (a draft is a message, not a document)", () => {
    setDraftStorageForTest(fakeStorage());
    const long = "x".repeat(MAX_DRAFT_CHARS + 5_000);
    saveSessionDraft("sess_big", long);
    expect(loadSessionDraft("sess_big")).toHaveLength(MAX_DRAFT_CHARS);
  });

  it("the map evicts beyond MAX_SESSION_DRAFTS entries, keeping the MOST RECENTLY TOUCHED", () => {
    setDraftStorageForTest(fakeStorage());
    for (let i = 0; i < MAX_SESSION_DRAFTS + 5; i++) {
      saveSessionDraft(`sess_${i}`, `draft ${i}`);
    }
    // The five OLDEST sessions were evicted; the newest ones survive.
    expect(loadSessionDraft("sess_0")).toBe("");
    expect(loadSessionDraft("sess_4")).toBe("");
    expect(loadSessionDraft("sess_5")).toBe("draft 5");
    expect(loadSessionDraft(`sess_${MAX_SESSION_DRAFTS + 4}`)).toBe(
      `draft ${MAX_SESSION_DRAFTS + 4}`,
    );
  });
});

describe("ROUND-125 (R125-3): the never-throws degradation", () => {
  it("a CORRUPT blob reads as empty (the next save rewrites it clean)", () => {
    const store = fakeStorage();
    store.setItem("acute.session-drafts.v1", "{not json at all");
    setDraftStorageForTest(store);
    expect(loadSessionDraft("sess_a")).toBe("");
    saveSessionDraft("sess_a", "clean rewrite");
    expect(loadSessionDraft("sess_a")).toBe("clean rewrite");
  });

  it("a NON-OBJECT blob (an array / a string) reads as empty, never crashes", () => {
    const store = fakeStorage();
    store.setItem("acute.session-drafts.v1", JSON.stringify(["not", "a", "map"]));
    setDraftStorageForTest(store);
    expect(loadSessionDraft("sess_a")).toBe("");
  });

  it("UNAVAILABLE storage degrades to the pre-R125 behavior (no persistence, '' loads)", () => {
    setDraftStorageForTest(null);
    saveSessionDraft("sess_a", "never stored");
    expect(loadSessionDraft("sess_a")).toBe("");
  });

  it("a setItem that THROWS (quota) never surfaces — the draft just doesn't persist", () => {
    const store = fakeStorage();
    const spy = vi.spyOn(store, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    setDraftStorageForTest(store);
    expect(() => saveSessionDraft("sess_a", "too big for the quota")).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});
