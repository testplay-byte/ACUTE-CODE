/**
 * host-store.test.ts — the persistence contract: SecureStore holds EXACTLY
 * the per-host device tokens, AsyncStorage holds EXACTLY the host list +
 * the active pointer (plus the legacy cells during the one-time migration
 * sweep), and a full lifecycle never touches any other key (pinned below by
 * set/prefix equality).
 *
 * R118-B (spec §5.4) — the multi-host extension: upsert ×2 → list 2 with
 * the second active; setActiveHost flips; removeHost falls to the next
 * stored host / empties to unpaired; the LEGACY flat record migrates
 * (list + activeId + the per-host token, legacy keys dead after); the
 * key-set is the new contract.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { HOST_STORE_KEYS, hostStore, type HostStore, type StoredPairing } from "../host-store";

// The multi-host legs are OPTIONAL on the HostStore interface (so the frozen
// single-host fakes in the sibling suites keep compiling); the REAL store
// carries them all — bound once, non-optionally, for this suite's pins.
const store = hostStore as HostStore &
  Required<Pick<HostStore, "listHosts" | "readActiveHost" | "setActiveHost" | "removeHost">>;

// In-memory fakes + full call recording (the "nothing else" assertion's evidence).
const mockSecure = new Map<string, string>();
const mockAsync = new Map<string, string>();
const mockSecureKeys = new Set<string>();
const mockAsyncKeys = new Set<string>();

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => {
    mockSecureKeys.add(key);
    return mockSecure.get(key) ?? null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureKeys.add(key);
    mockSecure.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureKeys.add(key);
    mockSecure.delete(key);
  }),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async (key: string) => {
    mockAsyncKeys.add(key);
    return mockAsync.get(key) ?? null;
  }),
  setItem: jest.fn(async (key: string, value: string) => {
    mockAsyncKeys.add(key);
    mockAsync.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockAsyncKeys.add(key);
    mockAsync.delete(key);
  }),
  multiSet: jest.fn(async (pairs: [string, string][]) => {
    for (const [key, value] of pairs) {
      mockAsyncKeys.add(key);
      mockAsync.set(key, value);
    }
  }),
  multiRemove: jest.fn(async (keys: string[]) => {
    for (const key of keys) {
      mockAsyncKeys.add(key);
      mockAsync.delete(key);
    }
  }),
}));

const FP = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const FP2 = "11".repeat(32);
const RELAY = `https://acute-relay.anikuta.workers.dev/m/${FP}`;
const TOKEN = "f".repeat(64);
const TOKEN2 = "e".repeat(64);

function samplePairing(
  certFP: string | null,
  relay: string | null = null,
  machineId: string = FP,
  deviceToken: string = TOKEN,
  hostLabel: string = "OWNER-PC",
): StoredPairing {
  return {
    deviceToken,
    host: {
      machineId,
      certFP,
      hostLabel,
      addrs: ["192.168.1.4", "https://abc.trycloudflare.com"],
      port: 53411,
      relay,
      pairedAt: 1_750_000_000_000,
    },
  };
}

beforeEach(() => {
  mockSecure.clear();
  mockAsync.clear();
  mockSecureKeys.clear();
  mockAsyncKeys.clear();
});

describe("hostStore — the single-host round-trips (the legacy contract holds)", () => {
  it("reads as unpaired when nothing is stored", async () => {
    expect(await hostStore.readHost()).toBeNull();
    expect(await hostStore.readDeviceToken()).toBeNull();
    expect(await store.listHosts()).toEqual([]);
  });

  it("round-trips a full pairing (certFP present)", async () => {
    await hostStore.savePairing(samplePairing(FP));
    const host = await hostStore.readHost();
    const token = await hostStore.readDeviceToken();
    expect(host).toEqual(samplePairing(FP).host);
    expect(token).toBe(TOKEN);
    // The token lives in SecureStore under the PER-HOST key, NOT AsyncStorage.
    expect([...mockAsync.keys()]).not.toContain(`${HOST_STORE_KEYS.secureTokenPrefix}${FP}`);
    expect([...mockSecure.keys()]).toEqual([`${HOST_STORE_KEYS.secureTokenPrefix}${FP}`]);
  });

  it("round-trips a null certFP (the tunnel pairing) — read back as null", async () => {
    await hostStore.savePairing(samplePairing(null));
    const host = await hostStore.readHost();
    expect(host).not.toBeNull();
    expect(host?.certFP).toBeNull();
    expect(host?.machineId).toBe(FP);
    expect(host?.addrs).toEqual(["192.168.1.4", "https://abc.trycloudflare.com"]);
    expect(host?.relay).toBeNull(); // no relay in the pairing ⇒ null, not ""
  });

  it("round-trips the relay (v0.106.0) — stored, read back verbatim", async () => {
    await hostStore.savePairing(samplePairing(FP, RELAY));
    const host = await hostStore.readHost();
    expect(host).not.toBeNull();
    expect(host?.relay).toBe(RELAY);
    expect(host?.addrs).toEqual(["192.168.1.4", "https://abc.trycloudflare.com"]);
  });

  it("a list entry with no relay cell (a pre-v0.106 record) reads as relay-less, NOT corrupt", async () => {
    await hostStore.savePairing(samplePairing(FP, RELAY));
    // Simulate the old record: the entry simply never carried the cell.
    const list = JSON.parse(mockAsync.get("acute.host.list") ?? "[]") as Array<Record<string, unknown>>;
    delete list[0]?.relay;
    mockAsync.set("acute.host.list", JSON.stringify(list));
    const host = await hostStore.readHost();
    expect(host).not.toBeNull();
    expect(host?.relay).toBeNull();
    expect(host?.machineId).toBe(FP);
  });

  it("reads as unpaired when the list cell is corrupt JSON", async () => {
    await hostStore.savePairing(samplePairing(FP));
    mockAsync.set("acute.host.list", "{not json");
    expect(await hostStore.readHost()).toBeNull();
  });

  it("reads as unpaired when an entry loses a required numeric field", async () => {
    await hostStore.savePairing(samplePairing(FP));
    const list = JSON.parse(mockAsync.get("acute.host.list") ?? "[]") as Array<Record<string, unknown>>;
    delete list[0]?.port;
    mockAsync.set("acute.host.list", JSON.stringify(list));
    expect(await hostStore.readHost()).toBeNull();
    // The off-shape entry is dropped, but the store never throws.
    expect(await store.listHosts()).toEqual([]);
  });

  it("clear() wipes both backends completely — every stored host's token included", async () => {
    await hostStore.savePairing(samplePairing(FP, RELAY));
    await hostStore.clear();
    expect(await hostStore.readHost()).toBeNull();
    expect(await hostStore.readDeviceToken()).toBeNull();
    expect(mockAsync.size).toBe(0);
    expect(mockSecure.size).toBe(0);
    expect(mockAsync.has("acute.host.list")).toBe(false);
    expect(mockAsync.has("acute.host.activeId")).toBe(false);
  });

  it("NEVER touches a key outside the contract — and touches the whole allowed set", async () => {
    await hostStore.savePairing(samplePairing(FP));
    await hostStore.readHost();
    await store.listHosts();
    await hostStore.readDeviceToken();
    await hostStore.clear();

    // Every AsyncStorage key ever seen is an allowed key (the multi-host
    // record + the legacy cells the migration sweep reads-and-deletes).
    const allowedAsync = new Set<string>([...HOST_STORE_KEYS.async, ...HOST_STORE_KEYS.legacyAsync]);
    for (const key of mockAsyncKeys) {
      expect(allowedAsync.has(key)).toBe(true);
    }
    // And both halves of the new record were genuinely used.
    expect(mockAsyncKeys).toEqual(allowedAsync);
    // Every SecureStore key is a per-host token (or the legacy token the
    // sweep moves). Nothing else ever passes through the Keystore.
    for (const key of mockSecureKeys) {
      expect(
        key.startsWith(HOST_STORE_KEYS.secureTokenPrefix) || key === HOST_STORE_KEYS.legacySecure,
      ).toBe(true);
    }
    expect([...mockSecureKeys].some((k) => k === `${HOST_STORE_KEYS.secureTokenPrefix}${FP}`)).toBe(true);
  });
});

// ── R118-B: the multi-host surface (spec §5.4) ──────────────────────────────

describe("hostStore — the multi-host surface (R118-B)", () => {
  it("upsert ×2: the list holds both hosts and the SECOND pairing is active", async () => {
    await hostStore.savePairing(samplePairing(FP, null, FP, TOKEN, "OWNER-PC"));
    await hostStore.savePairing(samplePairing(FP2, null, FP2, TOKEN2, "STUDIO-PC"));

    const list = await store.listHosts();
    expect(list).toHaveLength(2);
    expect(list.map((h) => h.hostLabel)).toEqual(["OWNER-PC", "STUDIO-PC"]);

    const active = await store.readActiveHost();
    expect(active?.machineId).toBe(FP2); // savePairing = UPSERT + set active
    expect(await hostStore.readDeviceToken()).toBe(TOKEN2);
    // Re-pairing the FIRST host refreshes its slot in place AND reactivates it.
    await hostStore.savePairing(samplePairing(FP, null, FP, TOKEN, "OWNER-PC-2"));
    const relist = await store.listHosts();
    expect(relist).toHaveLength(2);
    expect(relist[0]?.hostLabel).toBe("OWNER-PC-2"); // in-place, order kept
    expect((await store.readActiveHost())?.machineId).toBe(FP);
    expect(await hostStore.readDeviceToken()).toBe(TOKEN);
  });

  it("setActiveHost flips the pointer — the host AND the token follow", async () => {
    await hostStore.savePairing(samplePairing(FP, null, FP, TOKEN, "OWNER-PC"));
    await hostStore.savePairing(samplePairing(FP2, null, FP2, TOKEN2, "STUDIO-PC"));

    await store.setActiveHost(FP);
    expect((await store.readActiveHost())?.machineId).toBe(FP);
    expect(await hostStore.readDeviceToken()).toBe(TOKEN);
    // readDeviceToken(machineId) reads ANY host's token, not just the active.
    expect(await hostStore.readDeviceToken(FP2)).toBe(TOKEN2);

    await store.setActiveHost(FP2);
    expect((await store.readActiveHost())?.machineId).toBe(FP2);
    expect(await hostStore.readDeviceToken()).toBe(TOKEN2);
  });

  it("removeHost: the active marker falls to the NEXT stored host, then empties to unpaired", async () => {
    await hostStore.savePairing(samplePairing(FP, null, FP, TOKEN, "OWNER-PC"));
    await hostStore.savePairing(samplePairing(FP2, null, FP2, TOKEN2, "STUDIO-PC"));

    // Remove the ACTIVE first host → the marker falls to the next one.
    await store.removeHost(FP);
    expect(await store.listHosts()).toHaveLength(1);
    expect((await store.readActiveHost())?.machineId).toBe(FP2);
    expect(await hostStore.readDeviceToken()).toBe(TOKEN2);
    // The removed host's token is gone (its Keystore row deleted).
    expect(await hostStore.readDeviceToken(FP)).toBeNull();
    expect([...mockSecure.keys()]).toEqual([`${HOST_STORE_KEYS.secureTokenPrefix}${FP2}`]);

    // Emptying the list settles unpaired — pointer AND hosts.
    await store.removeHost(FP2);
    expect(await store.listHosts()).toEqual([]);
    expect(await store.readActiveHost()).toBeNull();
    expect(await hostStore.readDeviceToken()).toBeNull();
  });

  it("removeHost of a NON-active host keeps the active marker untouched", async () => {
    await hostStore.savePairing(samplePairing(FP, null, FP, TOKEN, "OWNER-PC"));
    await hostStore.savePairing(samplePairing(FP2, null, FP2, TOKEN2, "STUDIO-PC"));
    // FP2 is active; removing FP (inactive) never moves the pointer.
    await store.removeHost(FP);
    expect((await store.readActiveHost())?.machineId).toBe(FP2);
    expect(await store.listHosts()).toHaveLength(1);
  });

  it("a stale active pointer (a host that vanished) honestly reads as unpaired", async () => {
    await hostStore.savePairing(samplePairing(FP, null, FP, TOKEN, "OWNER-PC"));
    mockAsync.set("acute.host.activeId", FP2); // the pointed host is not stored
    expect(await store.readActiveHost()).toBeNull();
    expect(await hostStore.readDeviceToken()).toBeNull();
  });

  it("the LEGACY flat record migrates on first read: list + activeId + the per-host token", async () => {
    // Seed the v0.111 single-host record exactly as the old store wrote it.
    mockAsync.set("acute.host.machineId", FP);
    mockAsync.set("acute.host.certFP", "");
    mockAsync.set("acute.host.hostLabel", "OWNER-PC");
    mockAsync.set("acute.host.addrs", JSON.stringify(["192.168.1.4"]));
    mockAsync.set("acute.host.port", "53411");
    mockAsync.set("acute.host.relay", "");
    mockAsync.set("acute.host.pairedAt", "1750000000000");
    mockSecure.set("acute.device.token", TOKEN);

    const host = await hostStore.readHost();
    expect(host).toEqual({
      machineId: FP,
      certFP: null, // "" on disk MEANT tunnel-paired
      hostLabel: "OWNER-PC",
      addrs: ["192.168.1.4"],
      port: 53411,
      relay: null,
      pairedAt: 1_750_000_000_000,
    });
    expect(await store.listHosts()).toHaveLength(1);
    expect(await hostStore.readDeviceToken()).toBe(TOKEN);
    // The token moved to the PER-HOST key; the legacy key is dead.
    expect([...mockSecure.keys()]).toEqual([`${HOST_STORE_KEYS.secureTokenPrefix}${FP}`]);
    // The legacy flat cells are gone — the list is the only record now.
    for (const key of HOST_STORE_KEYS.legacyAsync) {
      expect(mockAsync.has(key)).toBe(false);
    }
    expect(mockAsync.get("acute.host.list")).toBe(JSON.stringify([host]));
    expect(mockAsync.get("acute.host.activeId")).toBe(FP);
  });

  it("a legacy record WITHOUT its token settles the empty list (honest unpaired, nothing carried forward)", async () => {
    mockAsync.set("acute.host.machineId", FP);
    mockAsync.set("acute.host.addrs", JSON.stringify(["192.168.1.4"]));
    mockAsync.set("acute.host.port", "53411");
    mockAsync.set("acute.host.pairedAt", "1750000000000");
    // No acute.device.token — facts without a token honestly read unpaired.

    expect(await hostStore.readHost()).toBeNull();
    expect(await store.listHosts()).toEqual([]);
    // The sweep still settled the record (the legacy keys never re-read).
    expect(mockAsync.get("acute.host.list")).toBe("[]");
    for (const key of HOST_STORE_KEYS.legacyAsync) {
      expect(mockAsync.has(key)).toBe(false);
    }
  });

  it("savePairing after an empty migration writes a fresh list over the settled empty one", async () => {
    expect(await hostStore.readHost()).toBeNull(); // settles "[]"
    await hostStore.savePairing(samplePairing(FP, RELAY));
    expect((await store.readActiveHost())?.machineId).toBe(FP);
    expect(await store.listHosts()).toHaveLength(1);
  });
});
