/**
 * composer-draft.test.ts — R125-D's per-session drafts: the owner's v0.117.0
 * device verdict — "if I write a message and then switch to another session,
 * it should remember which message was typed there." The store module
 * (features/composer-draft.ts) mirrors outbox.ts's architecture exactly —
 * an injected key-value store seam, ONE owned AsyncStorage key, a pure
 * serialize/parse with the honest corrupt-blob fallback — so this suite
 * pins it the outbox.test.ts way: a memory fake store, the controller's
 * save/load/clear round-trip, the per-session isolation, the 20,000-char
 * cap ("a draft is not a document"), the blank-draft-clears law, and the
 * parse honesty. The COMPOSER-side wiring (the 400ms trailing debounce,
 * the hydrate guards, the flush-on-exit, the clear-on-send) is component
 * behavior and stays documented in composer.tsx's R125-D block; the store's
 * own contract is what this file keeps honest.
 *
 * Fake stores + zero React Native rendering — the module imports only
 * AsyncStorage (jest.setup.js's global mock keeps the import graph
 * native-free; the module-verbs describe reprograms that mock into a
 * working in-memory fake the updater.test.ts way).
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  clearComposerDraft,
  COMPOSER_DRAFT_MAX_CHARS,
  COMPOSER_DRAFTS_KEY,
  ComposerDraftsController,
  EMPTY_DRAFTS,
  loadComposerDraft,
  parseDrafts,
  saveComposerDraft,
  serializeDrafts,
  type ComposerDraftStore,
} from "../composer-draft";

function memoryStore(): ComposerDraftStore & { saved: string[] } {
  let blob: string | null = null;
  const saved: string[] = [];
  return {
    saved,
    async load() {
      return blob;
    },
    async save(serialized) {
      blob = serialized;
      saved.push(serialized);
    },
  };
}

// ── the controller: save / load / clear round-trip ──────────────────────────

describe("composer-draft — the controller round-trip", () => {
  it("saves and loads a session's draft; empty string when nothing was typed there", async () => {
    const controller = new ComposerDraftsController(memoryStore());
    await controller.save("sess_1", "finish this thought tomorrow");
    expect(await controller.load("sess_1")).toBe("finish this thought tomorrow");
    // the absent case — the composer's hydrate treats "" as "nothing to restore"
    expect(await controller.load("sess_2")).toBe("");
  });

  it("drafts are PER-SESSION: one session's text never bleeds into another", async () => {
    const controller = new ComposerDraftsController(memoryStore());
    await controller.save("sess_1", "the A draft");
    await controller.save("sess_2", "the B draft");
    expect(await controller.load("sess_1")).toBe("the A draft");
    expect(await controller.load("sess_2")).toBe("the B draft");
  });

  it("a BLANK draft is no draft: saving empty text clears the entry (no empty-string tombstones)", async () => {
    const controller = new ComposerDraftsController(memoryStore());
    await controller.save("sess_1", "typed then deleted");
    await controller.save("sess_1", "");
    expect(await controller.load("sess_1")).toBe("");
    // and the persisted map carries no empty-string tombstone
    const store = memoryStore();
    const pinned = new ComposerDraftsController(store);
    await pinned.save("sess_1", "");
    expect(JSON.parse(store.saved[0] ?? "{}")).toEqual({ drafts: {} });
  });

  it("clear removes ONLY the session's own draft (the send path)", async () => {
    const controller = new ComposerDraftsController(memoryStore());
    await controller.save("sess_1", "sent away");
    await controller.save("sess_2", "still typing");
    await controller.clear("sess_1");
    expect(await controller.load("sess_1")).toBe("");
    expect(await controller.load("sess_2")).toBe("still typing");
    // clearing an absent draft is a harmless no-op
    await controller.clear("sess_never");
    expect(await controller.load("sess_2")).toBe("still typing");
  });

  it("an empty session id is a no-op on every verb (no empty-string key can ever appear)", async () => {
    const store = memoryStore();
    const controller = new ComposerDraftsController(store);
    await controller.save("", "orphan");
    await controller.clear("");
    expect(await controller.load("")).toBe("");
    expect(store.saved).toHaveLength(0);
  });

  it("a second controller over the same store reloads the map (the remount round-trip)", async () => {
    // The owner's exact path: type in A, leave, come back — a NEW composer
    // mount reads through a FRESH controller over the same storage.
    const store = memoryStore();
    const first = new ComposerDraftsController(store);
    await first.save("sess_1", "the remembered message");
    const second = new ComposerDraftsController(store);
    expect(await second.load("sess_1")).toBe("the remembered message");
  });

  it("a save that the store REFUSES never throws — the in-memory map still answers", async () => {
    const refusing: ComposerDraftStore = {
      load: async () => null,
      save: async () => {
        throw new Error("storage full");
      },
    };
    const controller = new ComposerDraftsController(refusing);
    await expect(controller.save("sess_1", "still works in-session")).resolves.toBeUndefined();
    expect(await controller.load("sess_1")).toBe("still works in-session");
  });

  it("a store whose LOAD refuses reads as empty and still accepts saves", async () => {
    let refuseLoad = true;
    let blob: string | null = null;
    const controller = new ComposerDraftsController({
      load: async () => {
        if (refuseLoad) throw new Error("locked");
        return blob;
      },
      save: async (serialized) => {
        blob = serialized;
      },
    });
    expect(await controller.load("sess_1")).toBe("");
    await controller.save("sess_1", "typed while locked");
    refuseLoad = false;
    expect(await controller.load("sess_1")).toBe("typed while locked");
  });
});

// ── the cap: a draft is not a document ─────────────────────────────────────

describe("composer-draft — the 20,000-char cap", () => {
  it("caps the STORED text at exactly COMPOSER_DRAFT_MAX_CHARS (20,000)", async () => {
    const controller = new ComposerDraftsController(memoryStore());
    const huge = "x".repeat(COMPOSER_DRAFT_MAX_CHARS + 5_000);
    await controller.save("sess_1", huge);
    expect(await controller.load("sess_1")).toBe("x".repeat(COMPOSER_DRAFT_MAX_CHARS));
    expect(COMPOSER_DRAFT_MAX_CHARS).toBe(20_000);
  });

  it("text under the cap round-trips byte-identically", async () => {
    const controller = new ComposerDraftsController(memoryStore());
    const fine = "a".repeat(COMPOSER_DRAFT_MAX_CHARS - 1);
    await controller.save("sess_1", fine);
    expect(await controller.load("sess_1")).toBe(fine);
  });
});

// ── persistence: the pure serialize/parse + the honest fallbacks ───────────

describe("composer-draft — persistence (parse honesty)", () => {
  it("round-trips serialize → parse", () => {
    const state = { drafts: { sess_1: "one", sess_2: "two" } };
    expect(parseDrafts(serializeDrafts(state))).toEqual(state);
    // and EMPTY round-trips too
    expect(parseDrafts(serializeDrafts(EMPTY_DRAFTS))).toEqual(EMPTY_DRAFTS);
  });

  it("reads corrupt blobs as EMPTY (the honest fallback — never blocks the composer)", () => {
    expect(parseDrafts(null)).toEqual(EMPTY_DRAFTS);
    expect(parseDrafts("not json")).toEqual(EMPTY_DRAFTS);
    expect(parseDrafts("[]")).toEqual(EMPTY_DRAFTS);
    expect(parseDrafts('{"drafts": "nope"}')).toEqual(EMPTY_DRAFTS);
    expect(parseDrafts('{"other": 1}')).toEqual(EMPTY_DRAFTS);
  });

  it("drops individually-invalid rows but keeps the valid ones", () => {
    const blob = JSON.stringify({
      drafts: { sess_1: "ok", "": "orphan key", sess_2: 42, sess_3: ["no"] },
    });
    expect(parseDrafts(blob)).toEqual({ drafts: { sess_1: "ok" } });
  });

  it("owns EXACTLY one storage key, namespaced like the outbox's", () => {
    // The single-owned-key law (outbox.ts's OUTBOX_KEY pattern): every write
    // the module ever makes lands under this one name.
    expect(COMPOSER_DRAFTS_KEY).toBe("acute.composer.drafts.v1");
  });
});

// ── the module-level verbs (the composer's fire-and-forget surface) ────────

describe("composer-draft — the module verbs over the app singleton", () => {
  // The singleton wires the REAL AsyncStorage seam; the global mock from
  // jest.setup.js is reprogrammed into a working in-memory fake the
  // updater.test.ts way (jest.mocked + mockImplementation). The module-level
  // `instance` caches its loaded state across tests in this file, so every
  // test uses its OWN session ids to stay order-independent.
  const blobs = new Map<string, string>();

  beforeEach(() => {
    jest.clearAllMocks();
    blobs.clear();
    jest.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => blobs.get(key) ?? null);
    jest.mocked(AsyncStorage.setItem).mockImplementation(async (key: string, value: string) => {
      blobs.set(key, value);
    });
    jest.mocked(AsyncStorage.removeItem).mockImplementation(async (key: string) => {
      blobs.delete(key);
    });
  });

  it("persist under the ONE owned key and round-trips through the module verbs", async () => {
    await saveComposerDraft("sess_verb", "via the module verb");
    // the write lands under exactly the owned key, with the honest JSON map
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      COMPOSER_DRAFTS_KEY,
      serializeDrafts({ drafts: { sess_verb: "via the module verb" } }),
    );
    expect(blobs.get(COMPOSER_DRAFTS_KEY)).toBe(
      serializeDrafts({ drafts: { sess_verb: "via the module verb" } }),
    );
    expect(await loadComposerDraft("sess_verb")).toBe("via the module verb");
    await clearComposerDraft("sess_verb");
    expect(await loadComposerDraft("sess_verb")).toBe("");
  });

  it("the verbs NEVER throw when the store refuses (the composer rides fire-and-forget)", async () => {
    // The WRITE is refused — the verb still resolves (the controller keeps
    // its in-memory map, the documented degradation: only the cross-mount
    // memory is lost, never the composer's flow).
    jest.mocked(AsyncStorage.setItem).mockRejectedValue(new Error("storage full"));
    await expect(saveComposerDraft("sess_refuses", "never mind")).resolves.toBeUndefined();
    // a session never saved reads "" through the verb (the honest absent case)
    await expect(loadComposerDraft("sess_never_saved")).resolves.toBe("");
    // the removal write is refused too — the clear still resolves
    await expect(clearComposerDraft("sess_refuses")).resolves.toBeUndefined();
  });
});
