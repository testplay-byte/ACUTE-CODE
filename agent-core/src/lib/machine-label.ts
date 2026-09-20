/**
 * ROUND-115 (R115-E2, the pairing round): the WORD-PAIR MACHINE NAME — the
 * desktop's friendly label ("Confused Coconut", "Brave Otter", "Quiet
 * Meadow"), per the owner's round-115 verdict (docs/design-language/android/
 * README.md §"Product decisions pinned by round-115"): desktops mint a
 * word-pair friendly name at pair-window creation; it rides the pairing
 * payload as `machineLabel`, shows on the phone's home and the PC's pairing
 * dialog. The machine id/cert stay the REAL identity — the label is display
 * sugar, never a trust anchor.
 *
 * PERSISTENCE (stable across restarts, minted ONCE): the exact
 * ensureDeviceCertificate/ensureVapidKeys pattern (lib/device-cert.ts,
 * lib/web-push.ts) — a JSON file in the machine data dir
 * (`<dataDir>/machine-label.json`, next to vapid.json and
 * device-link-cert.json), read → validate → cache in-module; missing/corrupt
 * → mint + best-effort persist (an unwritable dir still yields a working
 * label for THIS process; the next boot simply mints a new one — the honest
 * degraded mode, same tolerance as a regenerated cert forcing one re-pair).
 *
 * Wire contract: `machineLabel` is STRICTLY ADDITIVE on every surface that
 * carries it (POST /mobile/pair/start payload, GET /mobile/link-info, the
 * claim response's machine.name, the cloud connector's hello frame) — v
 * stays 1, old phones ignore the unknown field (the ROUND-112 relay-field
 * precedent, routes/mobile.ts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The persisted file's name — sits NEXT TO vapid.json + the device cert. */
export const MACHINE_LABEL_FILENAME = "machine-label.json";

/** A sane ceiling (a UI list row, not a bio — the claim route's own cap). */
const MAX_LABEL_CHARS = 100;

/** ~24 clean, family-friendly adjectives (title-cased at the source — the
 * mint is pure concatenation, no runtime casing to get wrong). */
export const MACHINE_LABEL_ADJECTIVES: readonly string[] = [
  "Brave",
  "Calm",
  "Clever",
  "Curious",
  "Dapper",
  "Easy",
  "Fancy",
  "Gentle",
  "Happy",
  "Jolly",
  "Keen",
  "Light",
  "Merry",
  "Mighty",
  "Nimble",
  "Patient",
  "Quiet",
  "Rapid",
  "Sunny",
  "Swift",
  "Tidy",
  "Warm",
  "Wise",
  "Zesty",
];

/** ~24 clean, family-friendly nouns (nature + small-things — the clay
 * companion's register, never brands or tech words). */
export const MACHINE_LABEL_NOUNS: readonly string[] = [
  "Acorn",
  "Anchor",
  "Bamboo",
  "Boulder",
  "Canyon",
  "Cedar",
  "Clover",
  "Coconut",
  "Comet",
  "Coral",
  "Crane",
  "Dune",
  "Falcon",
  "Fern",
  "Harbor",
  "Heron",
  "Lagoon",
  "Lantern",
  "Maple",
  "Meadow",
  "Moss",
  "Otter",
  "Pebble",
  "River",
];

/** Mint ONE random title-cased pair ("Brave Otter") — pure, synchronous,
 * never touches the disk (persistence is getMachineLabel's job). */
export function mintMachineLabel(): string {
  const adjective =
    MACHINE_LABEL_ADJECTIVES[Math.floor(Math.random() * MACHINE_LABEL_ADJECTIVES.length)];
  const noun = MACHINE_LABEL_NOUNS[Math.floor(Math.random() * MACHINE_LABEL_NOUNS.length)];
  return `${adjective} ${noun}`;
}

/** The persisted file's shape. */
interface PersistedLabel {
  label: string;
}

let cached: string | null = null;

/** A persisted label's honest shape (non-blank string within the cap). */
function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_LABEL_CHARS;
}

/**
 * Load (or mint ONCE + persist) this machine's word-pair label. Mirrors
 * ensureVapidKeys/ensureDeviceCertificate exactly: read the JSON file next
 * to the db → validate → cache in-module; missing/corrupt → mint + write
 * (mode 0600, best-effort persist). Async only to keep the family's shape
 * (the cert's generation is async; the label's mint is not) — the fs legs
 * are the same sync reads/writes.
 */
export async function getMachineLabel(dataDir: string): Promise<string> {
  if (cached !== null) return cached;
  const labelPath = join(dataDir, MACHINE_LABEL_FILENAME);
  try {
    const parsed = JSON.parse(readFileSync(labelPath, "utf8")) as Partial<PersistedLabel>;
    if (validLabel(parsed.label)) {
      cached = parsed.label;
      return cached;
    }
  } catch {
    /* missing or corrupt — mint below (the vapid.json tolerance) */
  }
  cached = mintMachineLabel();
  try {
    writeFileSync(labelPath, `${JSON.stringify({ label: cached }, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    // Non-fatal (the vapid.json rule): this process pairs fine with a fresh
    // label; the next boot simply mints another (paired phones see a new
    // display name — never a broken link; the id/cert are the identity).
    console.error("[machine-label] could not persist the machine label:", err);
  }
  return cached;
}

/**
 * The SYNC cache read for callers that cannot await (cloud-connector's
 * constructor default): the minted label when getMachineLabel already ran
 * this process, null when it never did — the caller falls back to its own
 * default (hostname). Boot + the settings apply path warm the cache BEFORE
 * any connector starts, so the relay hello always carries the minted label
 * in production.
 */
export function cachedMachineLabel(): string | null {
  return cached;
}

/** Test hook — drop the in-module cache (a fresh dataDir re-reads). */
export function resetMachineLabelForTest(): void {
  cached = null;
}
