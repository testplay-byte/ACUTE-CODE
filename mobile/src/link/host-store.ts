/**
 * host-store.ts — what the phone persists about its ONE host (the ruling:
 * token + cert fingerprint + addresses — nothing more, LINKING-PROTOCOL §5).
 *
 *   SecureStore   { deviceToken }                 — the Keystore-backed secret
 *   AsyncStorage  { machineId, certFP, hostLabel,
 *                   addrs, port, relay, pairedAt } — the non-secret host facts
 *
 * v0.106.0 (R112): `relay` joins the record — the cloud relay base URL
 * (`https://<relay-host>/m/<machineId>`) or null (absent cell / "" on disk
 * = no relay, exactly the certFP convention). Records written by pre-v0.106
 * builds simply lack the cell — they read as relay-less, never as corrupt.
 *
 * NOTHING ELSE may pass through here (pinned by the key-set test): theme
 * prefs live in src/design/theme.tsx under their own acute.prefs.* keys and
 * never touch this module.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

// ── the exact key set (asserted in host-store.test.ts) ──────────────────────

const SECURE_DEVICE_TOKEN = "acute.device.token";
const HOST_PREFIX = "acute.host.";

export const HOST_STORE_KEYS = {
  secure: [SECURE_DEVICE_TOKEN] as const,
  async: [
    `${HOST_PREFIX}machineId`,
    `${HOST_PREFIX}certFP`,
    `${HOST_PREFIX}hostLabel`,
    `${HOST_PREFIX}addrs`,
    `${HOST_PREFIX}port`,
    `${HOST_PREFIX}relay`,
    `${HOST_PREFIX}pairedAt`,
  ] as const,
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
  /** The stored host, or null when unpaired/corrupt (honest null, never a throw). */
  readHost(): Promise<StoredHost | null>;
  /** The Keystore-held device token, or null. */
  readDeviceToken(): Promise<string | null>;
  /** Persist a fresh pairing (host facts + token) atomically-ish: token last. */
  savePairing(pairing: StoredPairing): Promise<void>;
  /** Wipe BOTH backends (unpair / revoked-token fallback to pairing). */
  clear(): Promise<void>;
}

/** Parse an individually-stored field, falling back honestly. */
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

/**
 * The real store. A corrupt/partial record reads as UNPAIRED (null) — the
 * honest fallback is re-pairing, never half-connected operation.
 */
export const hostStore: HostStore = {
  async readHost() {
    try {
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
      if (
        parsedMachineId === null ||
        parsedAddrs === null ||
        parsedAddrs.length === 0 ||
        parsedPort === null ||
        parsedPairedAt === null
      ) {
        return null;
      }
      return {
        machineId: parsedMachineId,
        // "" on disk MEANS null (tunnel-paired — no fingerprint was pinned).
        certFP: certFP === "" ? null : certFP,
        hostLabel: parseString(hostLabel) ?? "ACUTE host",
        addrs: parsedAddrs,
        port: parsedPort,
        // Absent cell (a pre-v0.106 record) and "" both mean "no relay" —
        // the field is optional, its absence is NOT corruption.
        relay: relay === null || relay === "" ? null : relay,
        pairedAt: parsedPairedAt,
      };
    } catch {
      return null;
    }
  },

  async readDeviceToken() {
    try {
      return await SecureStore.getItemAsync(SECURE_DEVICE_TOKEN);
    } catch {
      return null;
    }
  },

  async savePairing(pairing) {
    await AsyncStorage.multiSet([
      [`${HOST_PREFIX}machineId`, pairing.host.machineId],
      [`${HOST_PREFIX}certFP`, pairing.host.certFP ?? ""],
      [`${HOST_PREFIX}hostLabel`, pairing.host.hostLabel],
      [`${HOST_PREFIX}addrs`, JSON.stringify(pairing.host.addrs)],
      [`${HOST_PREFIX}port`, String(pairing.host.port)],
      [`${HOST_PREFIX}relay`, pairing.host.relay ?? ""],
      [`${HOST_PREFIX}pairedAt`, String(pairing.host.pairedAt)],
    ]);
    // The token is the crown jewel — write it LAST so a crash mid-save can
    // never leave a live token without its host facts (the reverse — facts
    // without a token — honestly reads as unpaired on the next launch).
    await SecureStore.setItemAsync(SECURE_DEVICE_TOKEN, pairing.deviceToken);
  },

  async clear() {
    await AsyncStorage.multiRemove(HOST_STORE_KEYS.async.map((k) => k as string));
    try {
      await SecureStore.deleteItemAsync(SECURE_DEVICE_TOKEN);
    } catch {
      // The token row being already-absent is not a failure of unpairing.
    }
  },
};
