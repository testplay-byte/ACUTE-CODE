/**
 * host-store.test.ts — the persistence contract: SecureStore holds EXACTLY
 * the device token, AsyncStorage holds EXACTLY the six host fields, and a
 * full lifecycle never touches any other key (pinned below by set equality).
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { HOST_STORE_KEYS, hostStore, type StoredPairing } from "../host-store";

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

function samplePairing(certFP: string | null): StoredPairing {
  return {
    deviceToken: "f".repeat(64),
    host: {
      machineId: FP,
      certFP,
      hostLabel: "OWNER-PC",
      addrs: ["192.168.1.4", "https://abc.trycloudflare.com"],
      port: 53411,
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

describe("hostStore", () => {
  it("reads as unpaired when nothing is stored", async () => {
    expect(await hostStore.readHost()).toBeNull();
    expect(await hostStore.readDeviceToken()).toBeNull();
  });

  it("round-trips a full pairing (certFP present)", async () => {
    await hostStore.savePairing(samplePairing(FP));
    const host = await hostStore.readHost();
    const token = await hostStore.readDeviceToken();
    expect(host).toEqual(samplePairing(FP).host);
    expect(token).toBe("f".repeat(64));
    // The token lives in SecureStore, NOT AsyncStorage.
    expect([...mockAsync.keys()]).not.toContain(HOST_STORE_KEYS.secure[0]);
    expect([...mockSecure.keys()]).toEqual([HOST_STORE_KEYS.secure[0]]);
  });

  it("round-trips a null certFP (the tunnel pairing) through the empty-string cell", async () => {
    await hostStore.savePairing(samplePairing(null));
    const host = await hostStore.readHost();
    expect(host).not.toBeNull();
    expect(host?.certFP).toBeNull();
    expect(host?.machineId).toBe(FP);
    expect(host?.addrs).toEqual(["192.168.1.4", "https://abc.trycloudflare.com"]);
  });

  it("reads as unpaired when the addrs cell is corrupt JSON", async () => {
    await hostStore.savePairing(samplePairing(FP));
    mockAsync.set("acute.host.addrs", "{not json");
    expect(await hostStore.readHost()).toBeNull();
  });

  it("reads as unpaired when a required numeric cell goes missing", async () => {
    await hostStore.savePairing(samplePairing(FP));
    mockAsync.delete("acute.host.port");
    expect(await hostStore.readHost()).toBeNull();
  });

  it("clear() wipes both backends completely", async () => {
    await hostStore.savePairing(samplePairing(FP));
    await hostStore.clear();
    expect(await hostStore.readHost()).toBeNull();
    expect(await hostStore.readDeviceToken()).toBeNull();
    expect(mockAsync.size).toBe(0);
    expect(mockSecure.size).toBe(0);
  });

  it("NEVER touches a key outside the contract — and touches every allowed one", async () => {
    await hostStore.savePairing(samplePairing(FP));
    await hostStore.readHost();
    await hostStore.readDeviceToken();
    await hostStore.clear();

    // Every key ever seen is an allowed key (nothing else passed through).
    const allowedAsync = new Set<string>(HOST_STORE_KEYS.async);
    for (const key of mockAsyncKeys) {
      expect(allowedAsync.has(key)).toBe(true);
    }
    // And every allowed key was genuinely used across the lifecycle.
    expect(mockAsyncKeys).toEqual(allowedAsync);
    expect(mockSecureKeys).toEqual(new Set<string>(HOST_STORE_KEYS.secure));
  });
});
