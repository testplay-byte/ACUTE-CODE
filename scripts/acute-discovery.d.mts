// R98-K: the ambient declaration for scripts/acute-discovery.mjs (the CLI's
// pure portal-discovery resolver). The root typecheck program (tsconfig.json)
// covers agent-core/tests — whose r98-cli-discovery.test.ts imports the
// module — but scripts/ itself stays OUTSIDE the program's include list
// (pulling the plain-JS scripts in via allowJs would typecheck the whole
// 930-line CLI as JS for no benefit). This sidecar declaration gives the
// test the exact runtime shapes; the .mjs is the truth (kept in step by the
// same round's pins).
export const PORTAL_FILENAME: string;

/** The packaged app's per-user state dir (the Rust shell's state_dir()), or
 * null when the platform env lacks it (no APPDATA on Windows). */
export function portalStateDir(): string | null;

/** The parsed discovery record — the load-bearing fields are strict, the
 * metadata (pid/startedAt) tolerant-null. */
export interface PortalDiscoveryRecord {
  baseUrl: string;
  token: string;
  port: number;
  pid: number | null;
  startedAt: string | null;
}

/** A resolved discovery: the record plus the file it came from. */
export interface PortalDiscovery extends PortalDiscoveryRecord {
  file: string;
}

/** The candidate files in priority order (repo .dev/ first, then the
 * packaged state dir); `stateDir` is injectable for tests. */
export function portalDiscoveryCandidates(
  repoRoot: string,
  stateDir?: string | null,
): string[];

/** Parse ONE file → the record, or null (absent/unreadable/corrupt/invalid). */
export function readPortalDiscoveryFile(file: string): PortalDiscoveryRecord | null;

/** Resolve across the candidates: the first readable file wins, else null. */
export function resolvePortalDiscovery(
  repoRoot: string,
  stateDir?: string | null,
): PortalDiscovery | null;
