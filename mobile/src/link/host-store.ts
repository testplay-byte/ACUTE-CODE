/**
 * host-store.ts — what the phone persists about its DESKTOPS (the ruling:
 * per-host tokens + cert fingerprints + addresses — nothing more,
 * LINKING-PROTOCOL §5).
 *
 * R118-B (spec §2.5) — the MULTI-HOST rework: the single flat record grew
 * into a list + an active pointer + per-host tokens:
 *
 *   AsyncStorage  { acute.host.list }     — JSON StoredHost[]
 *   AsyncStorage  { acute.host.activeId } — the active machineId
 *   SecureStore   { acute.device.token.<machineId> } — one token PER HOST
 *
 * The LEGACY flat record (acute.host.machineId / certFP / hostLabel / addrs /
 * port / relay / pairedAt + the single acute.device.token) is migrated ON
 * FIRST READ: the record becomes list = [host], activeId = its machineId,
 * the token moves to the per-host key — then the legacy keys are removed
 * (write-then-delete, so a crash mid-migration can never lose the pairing;
 * the sweep re-runs while the list key is absent).
 *
 *   v0.106.0 (R112): `relay` joins the record — the cloud relay base URL
 *   (`https://<relay-host>/m/<machineId>`) or null (absent cell / "" on disk
 *   = no relay, exactly the certFP convention). Records written by pre-v0.106
 *   builds simply lack the cell — they read as relay-less, never as corrupt.
 *
 * NOTHING ELSE may pass through here (pinned by the key-set test): theme
 * prefs live in src/design/theme.tsx under their own acute.prefs.* keys and
 * never touch this module.
 *
 * The multi-host legs are OPTIONAL on the HostStore interface: pair-flow and
 * the frozen sibling test fakes still speak the single-host contract
 * (readHost/readDeviceToken/savePairing/clear), and the connection manager
 * falls back to exactly those when the optional legs are absent.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

// ── the exact key set (asserted in host-store.test.ts) ──────────────────────

const HOST_LIST = "acute.host.list";
const HOST_ACTIVE_ID = "acute.host.activeId";
/** The per-host token key prefix (SecureStore): acute.device.token.<machineId>. */
const SECURE_TOKEN_PREFIX = "acute.device.token.";
/** The LEGACY single-token key — dead after the migration sweep. */
const LEGACY_SECURE_DEVICE_TOKEN = "acute.device.token";
const HOST_PREFIX = "acute.host.";

export const HOST_STORE_KEYS = {
  /** The multi-host record: the host list + the active pointer. */
  async: [HOST_LIST, HOST_ACTIVE_ID] as const,
  /** The legacy flat record's cells — dead after the R118 migration sweep. */
  legacyAsync: [
    `${HOST_PREFIX}machineId`,
    `${HOST_PREFIX}certFP`,
    `${HOST_PREFIX}hostLabel`,
    `${HOST_PREFIX}addrs`,
    `${HOST_PREFIX}port`,
    `${HOST_PREFIX}relay`,
    `${HOST_PREFIX}pairedAt`,
  ] as const,
  /** The per-host token keys are `secureTokenPrefix + machineId`. */
  secureTokenPrefix: SECURE_TOKEN_PREFIX,
  /** The legacy single-token key — dead after the migration sweep. */
  legacySecure: LEGACY_SECURE_DEVICE_TOKEN,
};

// ── the stored shapes ───────────────────────────────────────────────────────

/** The host facts — the exact non-secret fields the contract allows. */
export interface StoredHost {
  /** Colon-free lowercase 64-hex — the desktop's stable machine identity. */
  machineId: string;
  /** Normalized 64-hex (no colons) or null (tunnel-paired, never pinned). */
  certFP: string | null;
  /** The host's display name (machine.name from the claim response). */
  hostLabel: string;
  /** The ordered address list — bare hosts (LAN) and/or full https URLs. */
  addrs: string[];
  /** The device listener's port (bare-host entries). */
  port: number;
  /** The cloud relay base URL (`https://<relay-host>/m/<machineId>`) or null
   *  — one more address for the SAME machineId, probed AFTER the LAN ladder
   *  (v0.106.0). Full URL: standard CA, never the TOFU pin. */
  relay: string | null;
  /** Epoch ms of the successful claim. */
  pairedAt: number;
}

/** Everything the link layer needs after a successful pairing. */
export interface StoredPairing {
  deviceToken: string;
  host: StoredHost;
}

// ── the store API (consumed via interface by connection/pair-flow) ──────────

export interface HostStore {
  /**
   * The LEGACY single-host read (pair-flow's pin-only re-pair path + the
   * frozen sibling fakes): the ACTIVE host, or null when unpaired/corrupt
   * (honest null, never a throw). Multi-host stores alias this to
   * readActiveHost().
   */
  readHost(): Promise<StoredHost | null>;
  /**
   * R118-B — the Keystore-held device token for `machineId` (default: the
   * ACTIVE host's), or null.
   */
  readDeviceToken(machineId?: string): Promise<string | null>;
  /** Persist a fresh pairing. Multi-host stores UPSERT into the list and
   *  point the active marker at the saved host. */
  savePairing(pairing: StoredPairing): Promise<void>;
  /** Wipe BOTH backends (unpair / revoked-token fallback to pairing). */
  clear(): Promise<void>;

  // ── the R118-B multi-host legs (optional so the frozen single-host
  //    fakes in the sibling suites keep compiling) ──

  /** Every stored host (the connect hub's "Desktops" switcher). */
  listHosts?(): Promise<StoredHost[]>;
  /** The ACTIVE host — the pointer's target, or null when it points at
   *  nothing (honest unpaired; removeHost keeps the pointer valid). */
  readActiveHost?(): Promise<StoredHost | null>;
  /** Point the active marker at a stored host (a plain pointer write). */
  setActiveHost?(machineId: string): Promise<void>;
  /** Remove one host (splice + its token); the active marker falls to the
   *  next stored host, or to unpaired when the list empties. */
  removeHost?(machineId: string): Promise<void>;
}

// ── parsing helpers ─────────────────────────────────────────────────────────

function parseString(raw: string | null): string | null {
  return raw === null ? null : raw;
}

function parseStringArray(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== "string")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Validate one list entry as a full StoredHost — off-shape entries read as
 *  null and are dropped (a half-corrupt list keeps its honest survivors). */
function parseStoredHost(raw: unknown): StoredHost | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.machineId !== "string" ||
    obj.machineId === "" ||
    !Array.isArray(obj.addrs) ||
    obj.addrs.length === 0 ||
    obj.addrs.some((a) => typeof a !== "string") ||
    typeof obj.port !== "number" ||
    !Number.isFinite(obj.port) ||
    typeof obj.pairedAt !== "number" ||
    !Number.isFinite(obj.pairedAt)
  ) {
    return null;
  }
  return {
    machineId: obj.machineId,
    certFP: typeof obj.certFP === "string" ? (obj.certFP === "" ? null : obj.certFP) : null,
    hostLabel: typeof obj.hostLabel === "string" && obj.hostLabel !== "" ? obj.hostLabel : "ACUTE host",
    addrs: obj.addrs as string[],
    port: obj.port,
    relay: typeof obj.relay === "string" && obj.relay !== "" ? obj.relay : null,
    pairedAt: obj.pairedAt,
  };
}

/** Parse the stored list JSON — null for off-shape payloads. */
function parseHostList(raw: string | null): StoredHost[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(parseStoredHost).filter((h): h is StoredHost => h !== null);
  } catch {
    return null;
  }
}

function tokenKey(machineId: string): string {
  return `${SECURE_TOKEN_PREFIX}${machineId}`;
}

async function removeLegacyKeys(): Promise<void> {
  await AsyncStorage.multiRemove(HOST_STORE_KEYS.legacyAsync.map((k) => k as string));
  try {
    await SecureStore.deleteItemAsync(LEGACY_SECURE_DEVICE_TOKEN);
  } catch {
    // The legacy token row being already-absent is not a failure.
  }
}

/**
 * The R118-B migration: while the list key is absent, sweep the legacy flat
 * record once — a VALID legacy host + token becomes list = [host], activeId
 * = its machineId, the token moved to the per-host key; anything less
 * settles the empty list (facts without a token honestly read as unpaired —
 * the crash-mid-save pose the old store already guarded). The legacy keys
 * are removed only after the new shape is fully written.
 */
async function migrateLegacy(): Promise<StoredHost[]> {
  const [machineId, certFP, hostLabel, addrs, port, relay, pairedAt] = await Promise.all([
    AsyncStorage.getItem(`${HOST_PREFIX}machineId`),
    AsyncStorage.getItem(`${HOST_PREFIX}certFP`),
    AsyncStorage.getItem(`${HOST_PREFIX}hostLabel`),
    AsyncStorage.getItem(`${HOST_PREFIX}addrs`),
    AsyncStorage.getItem(`${HOST_PREFIX}port`),
    AsyncStorage.getItem(`${HOST_PREFIX}relay`),
    AsyncStorage.getItem(`${HOST_PREFIX}pairedAt`),
  ]);
  const parsedPort = parseNumber(port);
  const parsedPairedAt = parseNumber(pairedAt);
  const parsedAddrs = parseStringArray(addrs);
  const parsedMachineId = parseString(machineId);
  let host: StoredHost | null = null;
  if (parsedMachineId !== null && parsedAddrs !== null && parsedAddrs.length > 0 && parsedPort !== null && parsedPairedAt !== null) {
    host = {
      machineId: parsedMachineId,
      // "" on disk MEANS null (tunnel-paired — no fingerprint was pinned).
      certFP: certFP === "" ? null : certFP,
      hostLabel: parseString(hostLabel) ?? "ACUTE host",
      addrs: parsedAddrs,
      port: parsedPort,
      // Absent cell (a pre-v0.106 record) and "" both mean "no relay".
      relay: relay === null || relay === "" ? null : relay,
      pairedAt: parsedPairedAt,
    };
  }
  if (host === null) {
    await AsyncStorage.setItem(HOST_LIST, "[]");
    await removeLegacyKeys();
    return [];
  }
  let token: string | null = null;
  try {
    token = await SecureStore.getItemAsync(LEGACY_SECURE_DEVICE_TOKEN);
  } catch {
    token = null;
  }
  if (token === null) {
    // Facts without a token honestly read as unpaired — the host does not
    // carry forward.
    await AsyncStorage.setItem(HOST_LIST, "[]");
    await removeLegacyKeys();
    return [];
  }
  await AsyncStorage.multiSet([
    [HOST_LIST, JSON.stringify([host])],
    [HOST_ACTIVE_ID, host.machineId],
  ]);
  // The token is the crown jewel — moved LAST, then the legacy keys die.
  await SecureStore.setItemAsync(tokenKey(host.machineId), token);
  await removeLegacyKeys();
  return [host];
}

/** Whether ANY legacy cell (or the legacy token) is still on disk — the
 *  sweep's STATELESS trigger: reads all seven cells so the trigger costs one
 *  launch-time batch on a legacy device, nothing on a migrated/cleared/fresh
 *  store (the list key is present or nothing is stored), and never a
 *  module-level latch (the jest suites reset the storage between tests —
 *  the gate must derive from the bytes, not from process state). */
async function legacyRecordPresent(): Promise<boolean> {
  try {
    const cells = await Promise.all(
      HOST_STORE_KEYS.legacyAsync.map((k) => AsyncStorage.getItem(k as string)),
    );
    if (cells.some((v) => v !== null)) return true;
    const token = await SecureStore.getItemAsync(LEGACY_SECURE_DEVICE_TOKEN);
    return token !== null;
  } catch {
    return false;
  }
}

/** The stored list — sweeping the legacy flat record when the list key has
 *  never been written AND legacy bytes remain. A corrupt list reads as
 *  empty (honest re-pair); an absent list with no legacy bytes reads as the
 *  plain empty list (never a re-settle — clear() leaves the store truly
 *  empty). */
async function readList(): Promise<StoredHost[]> {
  const raw = await AsyncStorage.getItem(HOST_LIST);
  if (raw !== null) return parseHostList(raw) ?? [];
  if (await legacyRecordPresent()) return migrateLegacy();
  return [];
}

/** The active pointer — read only AFTER the list has settled (readList runs
 *  the sweep when needed): reading it concurrently would race the
 *  migration's write and honestly answer null for a legacy device's very
 *  first read (the bug the sequencing kills). */
async function readActiveId(): Promise<string | null> {
  await readList();
  try {
    return await AsyncStorage.getItem(HOST_ACTIVE_ID);
  } catch {
    return null;
  }
}

/**
 * The real store. A corrupt/partial record reads as UNPAIRED (null) — the
 * honest fallback is re-pairing, never half-connected operation.
 */
export const hostStore: HostStore = {
  async readHost() {
    return this.readActiveHost?.() ?? null;
  },

  async readActiveHost() {
    try {
      // SEQUENCED (not Promise.all): the list read settles the migration
      // BEFORE the pointer is read — a concurrent pointer read would race
      // the sweep's write and honestly answer null on a legacy device's
      // first read.
      const list = await readList();
      const activeId = await readActiveId();
      if (activeId === null) return null;
      return list.find((h) => h.machineId === activeId) ?? null;
    } catch {
      return null;
    }
  },

  async listHosts() {
    try {
      return await readList();
    } catch {
      return [];
    }
  },

  async readDeviceToken(machineId) {
    try {
      const id = machineId ?? (await readActiveId());
      if (id === null) return null;
      return await SecureStore.getItemAsync(tokenKey(id));
    } catch {
      return null;
    }
  },

  async setActiveHost(machineId) {
    // A plain pointer write (spec §2.5) — the caller lists real hosts.
    await AsyncStorage.setItem(HOST_ACTIVE_ID, machineId);
  },

  async savePairing(pairing) {
    const list = await readList();
    const exists = list.some((h) => h.machineId === pairing.host.machineId);
    // UPSERT: an existing host keeps its slot (re-pairing refreshes it in
    // place), a new one is appended.
    const next = exists
      ? list.map((h) => (h.machineId === pairing.host.machineId ? pairing.host : h))
      : [...list, pairing.host];
    await AsyncStorage.multiSet([
      [HOST_LIST, JSON.stringify(next)],
      [HOST_ACTIVE_ID, pairing.host.machineId],
    ]);
    // The token is the crown jewel — written LAST so a crash mid-save can
    // never leave a live token without its host facts (the reverse — facts
    // without a token — honestly reads as unpaired on the next launch).
    await SecureStore.setItemAsync(tokenKey(pairing.host.machineId), pairing.deviceToken);
  },

  async removeHost(machineId) {
    // Sequenced like readActiveHost: the list read settles any pending
    // migration before the pointer is read.
    const list = await readList();
    const activeId = await readActiveId();
    const idx = list.findIndex((h) => h.machineId === machineId);
    if (idx === -1) {
      // Not stored — still clear any orphan token (hygiene, never a throw).
      try {
        await SecureStore.deleteItemAsync(tokenKey(machineId));
      } catch {
        // absent is fine
      }
      return;
    }
    const next = list.filter((h) => h.machineId !== machineId);
    let active = activeId;
    if (activeId === machineId) {
      // The active marker falls to the host that takes the removed slot's
      // place (the "next" one), else the last remaining, else unpaired.
      active = next.length > 0 ? (next[Math.min(idx, next.length - 1)]?.machineId ?? null) : null;
    }
    const writes: [string, string][] = [[HOST_LIST, JSON.stringify(next)]];
    if (active !== null) writes.push([HOST_ACTIVE_ID, active]);
    await AsyncStorage.multiSet(writes);
    if (active === null) await AsyncStorage.removeItem(HOST_ACTIVE_ID);
    try {
      await SecureStore.deleteItemAsync(tokenKey(machineId));
    } catch {
      // The token row being already-absent is not a failure of removal.
    }
  },

  async clear() {
    // Wipe every backend row this contract owns: the list + the pointer +
    // every stored host's token + the legacy keys.
    let list: StoredHost[] = [];
    try {
      list = await readList();
    } catch {
      list = [];
    }
    await AsyncStorage.multiRemove([
      ...HOST_STORE_KEYS.async.map((k) => k as string),
      ...HOST_STORE_KEYS.legacyAsync.map((k) => k as string),
    ]);
    for (const host of list) {
      try {
        await SecureStore.deleteItemAsync(tokenKey(host.machineId));
      } catch {
        // absent is fine
      }
    }
    try {
      await SecureStore.deleteItemAsync(LEGACY_SECURE_DEVICE_TOKEN);
    } catch {
      // The token row being already-absent is not a failure of unpairing.
    }
  },
};
