// ─────────────────────────────────────────────────────────────────────────────
// R87: the system domain — the application-wide reset.
//
// The owner's directive: "In the About section there will be options to reset
// the whole application. All the things of the application will be reset: the
// projects, the data, the storage, and all of those will be removed from the
// application. The providers and models will be removed completely too."
//
// POST /system/reset does, in order:
//   1. ABORTS every live turn (main + sub-agent children — the shared
//      turn-registry), so no in-flight agent keeps writing to rows that are
//      about to vanish.
//   2. Clears the in-memory keyring (ACUTE_PROVIDER_* — the spawn-time env
//      snapshot outlives the webview reload and would otherwise keep
//      answering tests with erased keys) and disposes every terminal
//      session (sidecar-held PTYs).
//   3. WIPES every table except schema_migrations (foreign_keys OFF for the
//      sweep — parent/child order is unknowable when everything goes) and
//      re-runs the factory seeds (the same reseedFactoryData openDatabase
//      calls — templates, built-in provider rows, built-in skills, the
//      default agent; one definition shared by both paths by construction).
//   4. VACUUMs the file back to its fresh-install size.
//   5. PURGES the app's machine-scoped files best-effort (never fails the
//      reset): the ~/.acute note files + key files + external plugins, and
//      the dataDir's vapid.json (regenerated on next boot).
//
// What it deliberately does NOT touch: the owner's REAL project directories
// (rows vanish; files on disk are the owner's), and the OS credential store —
// the webview layer owns that boundary (the Tauri purge command runs BEFORE
// this route so a reset mid-flight cannot resurrect a Credential-Manager key
// into the already-cleared keyring).
//
// The frontend then clears its localStorage stores + react-query cache and
// reloads — the full journey back to first-run.
// ─────────────────────────────────────────────────────────────────────────────
import { rmSync, readdirSync, statSync, existsSync, unlinkSync, readFileSync, writeFileSync, chmodSync, createWriteStream, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { errorBody } from "./helpers.js";
import { reseedFactoryData, type SqliteDatabase } from "../storage/db.js";
import { abortTurn, liveTurnIds } from "../lib/turn-registry.js";
import { terminalSessionsDisposeAll } from "../terminal-sessions.js";
// R120-U: the secret-shape scrubber — every error line this module can emit
// that touched the PAT's neighborhood runs through it (the routes never put
// the PAT in a message by construction; the scrubber is the belt).
import { scrubSecretShapes } from "../lib/secret-shapes.js";

const GITHUB_REPO = "testplay-byte/ACUTE-CODE";
const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_REPO_API_URL = `https://api.github.com/repos/${GITHUB_REPO}`;
const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases`;

// ── ROUND-120 (R120-U): the dead-PAT warning copy ───────────────────────────
// The owner rotated their GitHub PAT; the sidecar kept serving the now-dead
// token; GitHub answers 401 to BAD CREDENTIALS EVEN ON PUBLIC REPOS, so
// "Check for updates" died with HTTP 401 until this round's anonymous retry.
// Whenever the PAT-bearing leg is rejected but the anonymous leg carries the
// check, this warning rides the response so the About tab can hint at
// re-pairing (the quiet "Update GitHub token" row) without failing anything.
const GITHUB_TOKEN_WARNING =
  "the saved GitHub token was rejected — a new token is needed for private/rate-limited access";

// ── R99-C: the release NOTES passthrough cap ─────────────────────────────────
// The About tab's "What's new" block renders the release body as plain text;
// a full changelog entry can run far past that surface. 8,000 chars is the
// same order as the prompt-override cap (PROMPT_OVERRIDE_CHAR_CAP) — plenty
// for a real release's notes, small enough to never bloat the check response.
// The honest truncation marker keeps the cut visible (the full notes live on
// the release page the same response already links).
const RELEASE_BODY_CAP = 8_000;
const RELEASE_BODY_TRUNCATION_MARKER = "\n\n[truncated — the full notes live on the release page]";

/** R99-C: the release body, capped + honestly marked. "" when the release
 * carried no body (a tag-only release — the card then renders no notes). */
function releaseBodyForCard(raw: unknown): string {
  if (typeof raw !== "string") return "";
  if (raw.length <= RELEASE_BODY_CAP) return raw;
  return `${raw.slice(0, RELEASE_BODY_CAP)}${RELEASE_BODY_TRUNCATION_MARKER}`;
}

// ── ROUND-114 (R114-b): the FILESYSTEM BROWSE surface ──────────────────
// GET /system/fs/browse?path=<abs>&hidden=<0|1> — the phone's New Project
// folder picker. A paired phone is a view+input medium with config rights
// (the R109 ruling): browsing the machine's directory NAMES to pick a
// project root is exactly the “view + input” surface, so the route is
// deliberately NOT on the device-token blocklist (only /api/v1/system/reset
// is blocked under /system/*). Never lists file CONTENTS — names, types,
// paths only; dotfiles skipped unless hidden=1; hard-capped at 400 entries
// per response (a directory with thousands of files answers fast and the
// picker paginates by descending into subdirectories instead).

/** R114-b: the per-response entry cap (dirs+files combined, post-sort). */
const FS_BROWSE_MAX_ENTRIES = 400;

/** R114-b: one browsed entry — name, absolute path, and whether it is a
 * directory. No size, no mtime, no contents: the picker needs nothing else
 * and the response stays cheap over a phone link. */
interface FsBrowseEntry {
  name: string;
  path: string;
  dir: boolean;
}

/** The reply to a fs-browse failure — the OS's own message, never a
 * guessed one (the honest 404/400 contract the whole API follows). */
function fsError(
  reply: import("fastify").FastifyReply,
  status: number,
  code: string,
  message: string,
): unknown {
  return reply.code(status).send(errorBody(code, message));
}

// ── R91-E: the IN-APP UPDATER's download state ──────────────────────────
// The owner: "there was no inbuilt update system… I can update the application
// from within the app itself rather than going anywhere." The download
// streams HERE (the sidecar can attach the launcher's PAT to raise GitHub's
// anonymous rate limits — R94-B: the repo is PUBLIC now, so the PAT is an
// optional accelerator, never a gate), the progress is polled by the About
// tab, and the verified installer path is handed to the Rust shell's
// `run_update_installer` command at the end. Single-flight by construction:
// ONE download at a time, module state.
interface UpdateDownloadState {
  status: "idle" | "downloading" | "verifying" | "ready" | "error";
  /** Bytes received so far (0 until the stream starts). */
  received: number;
  /** The asset's advertised total (Content-Length; 0 when unknown). */
  total: number;
  /** The ABSOLUTE path of the finished, VERIFIED installer (status ready). */
  path: string | null;
  /** The version the downloaded installer installs. */
  version: string | null;
  /** Human-readable reason (status error). */
  error: string | null;
}
const updateDownload: UpdateDownloadState = {
  status: "idle",
  received: 0,
  total: 0,
  path: null,
  version: null,
  error: null,
};

/** Resets + claims the download slot. Returns false when a download is
 * already in flight (the UI keeps polling the live one). */
function claimUpdateDownload(): boolean {
  if (updateDownload.status === "downloading" || updateDownload.status === "verifying") {
    return false;
  }
  updateDownload.status = "downloading";
  updateDownload.received = 0;
  updateDownload.total = 0;
  updateDownload.path = null;
  updateDownload.version = null;
  updateDownload.error = null;
  return true;
}

/** The GitHub release JSON shape the updater cares about (tag + assets +
 * the release-notes body). */
interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  /** R99-C: the release BODY markdown (the release notes) — passed through
   * to the About tab's "What's new" block, capped at RELEASE_BODY_CAP. */
  body?: unknown;
  assets?: Array<{
    name?: unknown;
    /** R94-B: the API asset endpoint (api.github.com/…/assets/<id>) — serves
     * the bytes with a 302 to objects.githubusercontent.com when asked with
     * Accept: octet-stream. Both URL forms ship in every asset object. */
    url?: unknown;
    browser_download_url?: unknown;
    size?: unknown;
    digest?: unknown;
  }>;
}

// ── R104: the PLATFORM-AWARE updater asset ──────────────────────────────────
// The v0.100.0 report's Linux root cause, half 1: findInstallerAsset ALWAYS
// returned the `_x64-setup.exe` (the WINDOWS NSIS installer) on every
// platform — so a Linux "Update now" downloaded a Windows .exe, handed it
// to run_update_installer, and the Rust side rejected it (there is no
// silent .exe launch on Linux) leaving the app un-updated after the calm
// "Restarting into…" splash. The asset the check reports must match the
// machine it is reported TO:
//   · win32            → ACUTE-CODE_<v>_x64-setup.exe   (kind windows-setup)
//   · linux  + arm64   → ACUTE-CODE_<v>_aarch64.AppImage (kind linux-appimage —
//                        the Rust triple's arch name; the deb carries dpkg's
//                        `_arm64`, the AppImage carries `aarch64` — the R101
//                        naming asymmetry, pinned by the release pipeline)
//   · linux  + x64/…   → ACUTE-CODE_<v>_amd64.AppImage  (kind linux-appimage;
//                        tauri-bundler names BOTH x86_64 bundles `amd64`)
//   · anything else    → null (no in-app updater asset — the Releases page
//                        remains the answer; macOS is not shipped)
//
// ── ROUND-123 (R123): the LINUX .DEB LEG. The owner's standing report —
// the in-app update "not working that properly… on Linux" with the exact
// v0.100.0 symptom shape ("Restarting into vX" → "Connecting to Agent
// Core" → still the OLD version in About) — recurs VERBATIM on a .deb
// install: the AppImage replace refuses ("the app is not running from an
// AppImage"), the invoke rejects, and the R101-B recovery auto-restarts
// the sidecar — the calm "Connecting…" flash over an un-updated app. The
// pick is now INSTALL-TYPE-AWARE on Linux: the sidecar inherits the app's
// `APPIMAGE` environment variable (the AppImage runtime exports it for
// exactly this purpose), so an AppImage-launched app picks the AppImage
// (the R104 atomic-replace leg) and EVERYTHING ELSE (the .deb install —
// and any future package-managed shape) picks the arch-matched .deb (the
// new pkexec `dpkg -i` leg on the Rust side):
//   · linux + APPIMAGE set (absolute) + arm64 → _aarch64.AppImage (linux-appimage)
//   · linux + APPIMAGE set (absolute) + x64/… → _amd64.AppImage  (linux-appimage)
//   · linux + APPIMAGE absent      + arm64 → _arm64.deb         (linux-deb)
//   · linux + APPIMAGE absent      + x64/… → _amd64.deb          (linux-deb)
// The `kind` rides the response so the frontend can speak honestly (the
// interactive-wizard escape hatch is a windows-setup concern ONLY — there
// is no wizard for an AppImage or a deb) and `name` so the download route
// can derive the staged file's name from the REAL asset filename.
type UpdaterAssetKind = "windows-setup" | "linux-appimage" | "linux-deb";

interface UpdaterAsset {
  url: string;
  size: number;
  digest: string | null;
  kind: UpdaterAssetKind;
  name: string;
}

/** The asset filename suffix this machine's in-app updater needs, keyed off
 * the SIDECAR's own platform (process.platform/arch — the sidecar ships with
 * the app, so its platform IS the app's platform). R123: on Linux the
 * INSTALL TYPE decides the kind — `appimageEnv` defaults to the inherited
 * `APPIMAGE` variable (an absolute path means the app runs FROM an
 * AppImage and the atomic replace applies; anything else is a packaged
 * install and the .deb + pkexec leg applies). Exported for the route
 * tests' platform matrix. */
export function updaterAssetSuffixForPlatform(
  platform: string,
  arch: string,
  appimageEnv: string | undefined = process.env.APPIMAGE,
): {
  suffix: string;
  kind: UpdaterAssetKind;
} | null {
  if (platform === "win32") return { suffix: "_x64-setup.exe", kind: "windows-setup" };
  if (platform === "linux") {
    const fromAppImage =
      typeof appimageEnv === "string" && appimageEnv.trim() !== "" && appimageEnv.startsWith("/");
    if (fromAppImage) {
      return arch === "arm64"
        ? { suffix: "_aarch64.AppImage", kind: "linux-appimage" }
        : { suffix: "_amd64.AppImage", kind: "linux-appimage" };
    }
    // R123: the packaged-install leg — the arch-matched .deb (dpkg's own
    // `_arm64` spelling for the 64-bit ARM port, `amd64` for x86_64).
    return arch === "arm64"
      ? { suffix: "_arm64.deb", kind: "linux-deb" }
      : { suffix: "_amd64.deb", kind: "linux-deb" };
  }
  return null;
}

/** Finds THIS machine's updater asset in a release's asset list (see
 * updaterAssetSuffixForPlatform for the matrix).
 *
 * R94-B (kept): each GitHub asset carries BOTH URL forms — we prefer the
 * API `url` (the token-friendly api.github.com surface) and fall back to
 * `browser_download_url` (the github.com /releases/download permalink,
 * which the download route's allowlist accepts too). Both empty → null (no
 * usable asset). */
function findUpdaterAsset(release: GithubRelease): UpdaterAsset | null {
  const target = updaterAssetSuffixForPlatform(process.platform, process.arch);
  if (target === null) return null;
  for (const asset of release.assets ?? []) {
    const name = typeof asset.name === "string" ? asset.name : "";
    if (name.endsWith(target.suffix)) {
      const apiUrl = typeof asset.url === "string" ? asset.url : "";
      const browserUrl =
        typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
      const url = apiUrl !== "" ? apiUrl : browserUrl;
      if (url === "") {
        return null;
      }
      return {
        url,
        size: typeof asset.size === "number" ? asset.size : 0,
        digest: typeof asset.digest === "string" ? asset.digest : null,
        kind: target.kind,
        name,
      };
    }
  }
  return null;
}

/** R89-A2: the app's own version, from the package.json that ships with the
 * staged engine (dist/routes/… → ../../package.json = agent-core's manifest;
 * scripts/release/version.mjs keeps it identical to the root's). */
function appVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
    ) as { version?: string };
    return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** "0.86.0" vs "0.87.0" → [0,86,0] (tolerant of leading v and short forms). */
function versionTuple(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isNaN(part) ? 0 : part));
}

/** R89-A2 + R90-B1: the launcher's GitHub token, in two layers:
 *  (1) the ACUTE_GITHUB_PAT environment variable — set by the launcher
 *      itself on the Popen that starts the desktop app, so the token rides
 *      along no matter where the file landed (the belt);
 *  (2) ~/.acute/github.pat in the USER HOME — written by acute_launcher.py's
 *      first-run prompt (R90-B1 moved the save from the kit-relative
 *      .acute/github.pat into the home: the pre-R90 mismatch meant the app
 *      looked in the home while the launcher saved in the kit, so "Check
 *      for updates" answered no-token forever; the launcher migrates the
 *      legacy file automatically).
 * R94-B: the repo is PUBLIC now, so this token is OPTIONAL — anonymous
 * GitHub access works for both the check and the download; the PAT only
 * raises the 60 req/h anonymous rate limit. The launcher's first-run prompt
 * is an optional accelerator, never a gate. Never logged, never returned —
 * read once per /system/updates call and used in the Authorization header
 * only. Returns null when absent/unreadable (proceed anonymously).
 * ROUND-120 (R120-U): the FILE layer accepts BOTH real GitHub PAT spellings
 * — the fine-grained github_pat_… and the classic ghp_… — because PUT
 * /system/updates/token validates and persists either shape; before this a
 * re-paired classic ghp_ token sat in the file but never rode the header
 * (the layer silently dropped it), so the re-pairing path would have been a
 * no-op for half the world's tokens. The env layer keeps NO shape gate (the
 * launcher only ever exports a token it resolved itself).
 * R120-U re-pairing note: PUT /system/updates/token clears the env var after
 * a successful persist — a re-pair through the app proves the spawn-time
 * snapshot stale, and the file is the newer truth until the next launch. */
function readLauncherGithubPat(): string | null {
  // R90-B1: the env var wins FIRST — the launcher only ever exports a token
  // it has already resolved (file, env, or fresh prompt), so this path cannot
  // miss on a path/home mismatch. Whitespace-only counts as absent: a blank
  // export must fall through to the file instead of shadowing it with
  // nothing.
  const envPat = (process.env.ACUTE_GITHUB_PAT ?? "").trim();
  if (envPat !== "") return envPat;
  try {
    const pat = readFileSync(join(homedir(), ".acute", "github.pat"), "utf8").trim();
    if (pat.startsWith("github_pat_") || pat.startsWith("ghp_")) return pat;
    return null;
  } catch {
    return null;
  }
}

/** ROUND-120 (R120-U): the RAW saved token — SHAPE-FREE, for the token
 * health route's `present` field. "Something is saved" must stay honest
 * even when the saved bytes are not a usable token shape (a garbage file
 * answers present:true + valid:false, not a masquerading "no token"), so
 * the GET /system/updates/token probe reads this and validates live. Env
 * layer first (the readLauncherGithubPat order), then the home file; null
 * when nothing non-blank is saved on either layer. */
function readRawGithubPat(): string | null {
  const envPat = (process.env.ACUTE_GITHUB_PAT ?? "").trim();
  if (envPat !== "") return envPat;
  try {
    const pat = readFileSync(join(homedir(), ".acute", "github.pat"), "utf8").trim();
    return pat !== "" ? pat : null;
  } catch {
    return null;
  }
}

/** Every user-data table in the database — derived from sqlite_master at
 * reset time (never a hand-maintained list to drift), minus the migration
 * ledger (keeping it keeps the schema version honest — re-running
 * migrations on a wiped app would re-apply nothing and stay a no-op). */
function userDataTables(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** The ~/.acute machine-scoped app files the reset purges. Best-effort:
 * every miss is fine (dev machines never have most of them). */
function purgeAcuteDir(): string[] {
  const purged: string[] = [];
  const acuteDir = join(homedir(), ".acute");
  const targets = ["custom-providers.txt", "vision-providers.txt"];
  for (const name of targets) {
    const path = join(acuteDir, name);
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        purged.push(path);
      }
    } catch {
      // best-effort — a locked file never fails the reset
    }
  }
  // The launcher-era key files (openrouter.key, openrouter-slot2..4.key,
  // nvidia.key — written by distribute_key) + any other *.key drops.
  try {
    for (const entry of readdirSync(acuteDir)) {
      if (entry.endsWith(".key")) {
        const path = join(acuteDir, entry);
        try {
          unlinkSync(path);
          purged.push(path);
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // no ~/.acute dir at all — nothing to purge
  }
  // The external user plugins (ADR-0025: ~/.acute/plugins/*.mjs).
  const pluginsDir = join(acuteDir, "plugins");
  try {
    if (existsSync(pluginsDir) && statSync(pluginsDir).isDirectory()) {
      rmSync(pluginsDir, { recursive: true, force: true });
      purged.push(pluginsDir);
    }
  } catch {
    // best-effort
  }
  return purged;
}

export function registerSystemRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db, keyring } = ctx;

  // ── R89-A2: the update check ──────────────────────────────────────────────
  // The About tab's "Check for updates" used to call api.github.com from the
  // webview — the repo was PRIVATE then, so GitHub answered 404 to the
  // anonymous browser fetch (the owner's verdict). The check runs HERE,
  // server-side, so the token (when one exists) never crosses the REST
  // boundary. R94-B: the repo is PUBLIC — anonymous access works, so the
  // launcher's PAT is now OPTIONAL: it rides in the Authorization header
  // only when present (raising the 60 req/h anonymous limit); without one
  // the fetch is plain anonymous instead of dead-ending in a 409/no-token
  // wall. The fetch is short-lived (8s) so the button can answer honestly
  // fast.
  //
  // ── ROUND-120 (R120-U, kept as history): the token-FIRST order's dead-PAT
  // fallback — a rotated PAT killed the check with 401 because the header
  // was attached before anything else, and GitHub rejects bad credentials
  // even on public repos. The one-leg anonymous retry fixed the symptom.
  //
  // ── ROUND-123 (R123): ANONYMOUS-FIRST — the owner's directive: "why does
  // it even require a GitHub token? Isn't our GitHub repository public and
  // can't it easily fetch the appropriate version it needs without the
  // GitHub token and everything like that?" The inversion is structural:
  // the ANONYMOUS fetch is now the DEFAULT leg (the repo is public — the
  // normal check never touches the token at all), and the token is a pure
  // RETRY ACCELERATOR: it rides only when the anonymous leg failed in a
  // way a token can actually fix — 403 (the anonymous rate limit) or 404
  // (a private-fork shape) — AND one is saved. The R120-U dead-token 401
  // on the first leg is unreachable by construction (nothing is attached
  // to reject). Every answer carries `tokenSaved` so the About tab renders
  // the token affordance ONLY when a token exists (or the anonymous check
  // rate-limits with none); the anonymous rate-limit answer is its own
  // `rate-limited` reason so that affordance can say exactly why it would
  // help. Both legs share the ONE 8s abort budget.
  scope.get("/system/updates", async () => {
    const current = appVersion();
    const pat = readLauncherGithubPat();
    // R123: tokenSaved rides EVERY answer — the About tab's token row is
    // conditional on it (the default public-repo experience shows no token
    // UI anywhere).
    const base = { current, releasesUrl: GITHUB_RELEASES_PAGE, tokenSaved: pat !== null };
    // R123: the ANONYMOUS header set — the DEFAULT leg, provably
    // header-free (built once, never mutated).
    const anonymousHeaders: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ACUTE-CODE-update-check",
    };
    // R123: the token-bearing header set — built only for the retry leg.
    const requestHeaders: Record<string, string> = {
      ...anonymousHeaders,
      ...(pat !== null ? { Authorization: `Bearer ${pat}` } : {}),
    };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        // R123: ANONYMOUS FIRST — the public repo's default experience.
        let response = await fetch(GITHUB_LATEST_RELEASE_URL, {
          headers: anonymousHeaders,
          signal: controller.signal,
        });
        // R123: the TOKEN retry — ONLY when the anonymous leg answered 403
        // (rate limit) or 404 (private-fork shape) AND a token is saved.
        let tokenLegUsed = false;
        let anonymousStatus = 0;
        if ((response.status === 403 || response.status === 404) && pat !== null) {
          anonymousStatus = response.status;
          tokenLegUsed = true;
          response = await fetch(GITHUB_LATEST_RELEASE_URL, {
            headers: requestHeaders,
            signal: controller.signal,
          });
        }
        if (response.status === 404) {
          return {
            ...base,
            ok: false,
            reason: "no-release",
            // R123: whichever leg answered, the copy names BOTH honestly
            // (the repo is public — a token is never required to see it).
            error: tokenLegUsed
              ? `no published release is visible — the anonymous check (HTTP ${anonymousStatus}) and the saved GitHub token both answered 404`
              : "no published release is visible (the repository is public — no token required; is the network reachable?)",
          };
        }
        if (!response.ok) {
          if (tokenLegUsed) {
            // R123: the token leg itself failed — the saved token is dead.
            // The tokenWarning rides along so the About tab offers the
            // re-pairing row on exactly this answer (a token IS saved —
            // the row renders).
            return {
              ...base,
              ok: false,
              reason: "token-rejected",
              error: `the anonymous check answered HTTP ${anonymousStatus} and GitHub rejected the saved token (HTTP ${response.status}) — save a new GitHub token, or remove the saved one to keep checking anonymously`,
              tokenWarning: GITHUB_TOKEN_WARNING,
            };
          }
          // R123: anonymous failure, no token leg was possible. The rate
          // limit is its own reason — the ONE case where saving an
          // (optional) token genuinely helps, so the About tab surfaces
          // the affordance on exactly this answer.
          if (response.status === 403 && pat === null) {
            return {
              ...base,
              ok: false,
              reason: "rate-limited",
              error:
                "GitHub's anonymous rate limit answered HTTP 403 — saving an optional GitHub token raises it (60 → 5,000 checks/hour)",
            };
          }
          return {
            ...base,
            ok: false,
            reason: "github",
            error: `GitHub answered HTTP ${response.status} anonymously (no GitHub token is required for this public repository)`,
          };
        }
        const release = (await response.json()) as GithubRelease;
        const latest = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
        if (latest === "") {
          return { ...base, ok: false, reason: "bad-payload", error: "the release payload had no tag_name" };
        }
        const now = versionTuple(current);
        const newest = versionTuple(latest);
        const updateAvailable =
          newest.length > 0 && now.some((part, i) => part < (newest[i] ?? 0));
        // R91-E + R104: THIS MACHINE'S updater asset — the About tab's
        // in-app "Download update" hands this URL + digest to POST
        // /system/updates/download below. (The digest is GitHub's own
        // server-side sha256 of the uploaded asset — the same value the
        // launcher verifies against.) R104: the pick is platform-aware
        // (setup.exe on Windows, the arch-matched AppImage on Linux) and
        // carries {kind, name} for the frontend's honest copy + the staged
        // file's name.
        const asset = findUpdaterAsset(release);
        // R99-C: the release NOTES passthrough — the About tab's one-click
        // card renders the body ("What's new"); the route's own cap + honest
        // truncation marker keep a changelog-sized body from bloating the
        // response ("" for a tag-only release).
        const body = releaseBodyForCard(release.body);
        // R120-U → R123: the success path carries NO tokenWarning anymore —
        // with anonymous-first, a dead token can never degrade a successful
        // check (the anonymous leg carries it), so there is nothing to warn
        // about; the token row's own live health probe (GET
        // /system/updates/token) still reports validity when opened. When
        // the TOKEN leg carried the check (tokenLegUsed + ok — the anonymous
        // rate limit was hit and the token answered), the answer stays
        // honest and quiet: tokenSaved already tells the tab a token exists.
        return {
          ...base,
          ok: true,
          latest,
          updateAvailable,
          body,
          releaseUrl:
            typeof release.html_url === "string" ? release.html_url : GITHUB_RELEASES_PAGE,
          ...(asset !== null
            ? {
                asset: {
                  url: asset.url,
                  size: asset.size,
                  digest: asset.digest,
                  // R104: the platform truth + the real asset filename — the
                  // frontend gates its wizard escape hatch on the kind and
                  // the download route derives the staged file's name.
                  kind: asset.kind,
                  name: asset.name,
                },
              }
            : {}),
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      // R120-U: network-failure — the honest distinction's third leg (no
      // token verdict is possible when the wire never answered). The
      // message is secret-shape scrubbed as a belt: a thrown transport
      // error never embeds the PAT by construction, but the scrubber is
      // cheap and the route touches credentials.
      return {
        ...base,
        ok: false,
        reason: "network",
        error: scrubSecretShapes(err instanceof Error ? err.message : String(err)),
      };
    }
  });

  // ── R91-E: the in-app update DOWNLOAD ──────────────────────────────────────
  // POST /system/updates/download {url, digest?, version?, name?} — stream the
  // platform's updater asset (setup.exe on Windows, the arch-matched AppImage
  // on Linux — R104) to a temp file, then sha256-verify it against the
  // release's digest. The caller polls GET /system/updates/download/progress
  // for the live byte count; status "ready" carries the absolute path that
  // the Rust shell's run_update_installer command executes. The URL must
  // belong to THIS repo's release assets (the PAT-bearing fetch would
  // otherwise be an open proxy) — enforced below.
  scope.post("/system/updates/download", async (request, reply) => {
    // R94-B: PAT-optional — the repo is public, so anonymous downloads work;
    // the launcher's token, when present, only raises the rate limit (it is
    // attached below). No 409 no-token wall anymore.
    const pat = readLauncherGithubPat();
    const body = request.body as { url?: unknown; digest?: unknown; version?: unknown; name?: unknown } | null;
    const url = typeof body?.url === "string" ? body.url : "";
    const digest = typeof body?.digest === "string" && body.digest.startsWith("sha256:") ? body.digest : null;
    const version = typeof body?.version === "string" ? body.version.replace(/^v/, "") : "";
    const assetName = typeof body?.name === "string" ? body.name : "";
    if (url === "") {
      return reply.code(400).send(errorBody("VALIDATION", "body.url must be the release asset URL", { field: "body.url" }));
    }
    // The URL must be THIS repo's release asset download. R94-B: the
    // allowlist now covers BOTH real GitHub asset URL shapes —
    //   · api.github.com /repos/testplay-byte/ACUTE-CODE/releases… (the API
    //     asset endpoint — the form findInstallerAsset prefers),
    //   · github.com /testplay-byte/ACUTE-CODE/releases/download/… (the
    //     browser_download_url permalink — the R94-B fix: the pre-R94 gate
    //     rejected exactly this host, so every real "Update now" died with
    //     the VALIDATION error the owner reported),
    //   · objects.githubusercontent.com / release-assets.githubusercontent.com
    //     (where GitHub's 302 lands the actual bytes).
    // The repo is PUBLIC, so none of these need a token — the PAT, when
    // present, only raises the rate limit — but the gate still stands: this
    // must never be an open proxy for arbitrary URLs with the PAT attached.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send(errorBody("VALIDATION", "body.url is not a valid URL", { field: "body.url" }));
    }
    const hostOk =
      (parsed.host === "api.github.com" && parsed.pathname.startsWith("/repos/testplay-byte/ACUTE-CODE/releases")) ||
      (parsed.host === "github.com" &&
        parsed.pathname.startsWith("/testplay-byte/ACUTE-CODE/releases/download/")) ||
      parsed.host === "objects.githubusercontent.com" ||
      parsed.host === "release-assets.githubusercontent.com";
    if (!hostOk || parsed.protocol !== "https:") {
      return reply.code(400).send(
        errorBody("VALIDATION", "body.url must be a GitHub release asset of this repository", { field: "body.url" }),
      );
    }
    if (!claimUpdateDownload()) {
      // Already in flight — not an error; the UI keeps polling the live one.
      return reply.code(200).send({ ok: true, status: updateDownload.status, alreadyRunning: true });
    }
    // R104 + R123: the staged file's name derives from the REAL asset
    // filename the check reported (ACUTE-CODE_<v>_x64-setup.exe /
    // …_aarch64.AppImage / …_amd64.deb) so the extension the Rust side
    // dispatches on is the extension GitHub named. Sanitized hard: basename
    // only (no separators, no '..'), and the extension must be one of the
    // updater's three real kinds — anything else falls back to the
    // platform's own conventional name (the pre-R104 spelling on Windows,
    // the install-type-matched Linux name).
    const stagedDownloadName = (rawName: string): string => {
      const base = rawName.split(/[\\/]/).pop() ?? "";
      if (
        base !== "" &&
        !base.startsWith(".") &&
        (base.toLowerCase().endsWith(".exe") ||
          base.toLowerCase().endsWith(".appimage") ||
          base.toLowerCase().endsWith(".deb"))
      ) {
        return base;
      }
      const target = updaterAssetSuffixForPlatform(process.platform, process.arch);
      const suffix = target?.suffix ?? "-update.bin";
      return `ACUTE-CODE-${version || "update"}${suffix}`;
    };
    // Fire-and-forget: the POST answers immediately; the progress route
    // carries the live state (the About tab's progress bar).
    void (async () => {
      const dest = join(tmpdir(), stagedDownloadName(assetName));
      try {
        // ── ROUND-123 (R123): ANONYMOUS-FIRST — the download mirrors the
        // check's inversion. The public repo's assets download anonymously;
        // the Authorization header rides ONLY the retry leg (a 403 rate
        // limit on the anonymous attempt, with a token saved). The R120-U
        // dead-PAT 401 (the rotated token killed "Download update" exactly
        // as it killed the check) is unreachable on the first leg by
        // construction — nothing is attached to reject.
        const anonymousDownloadHeaders: Record<string, string> = {
          "User-Agent": "ACUTE-CODE-in-app-updater",
          Accept: "application/octet-stream",
        };
        const tokenDownloadHeaders: Record<string, string> = {
          ...anonymousDownloadHeaders,
          ...(pat !== null ? { Authorization: `Bearer ${pat}` } : {}),
        };
        let response = await fetch(url, {
          headers: anonymousDownloadHeaders,
          redirect: "follow",
        });
        if ((response.status === 401 || response.status === 403) && pat !== null) {
          const anonymousStatus = response.status;
          response = await fetch(url, {
            headers: tokenDownloadHeaders,
            redirect: "follow",
          });
          if (!response.ok || response.body === null) {
            throw new Error(
              `the asset download failed: the anonymous download answered HTTP ${anonymousStatus} and the saved token's download also failed (HTTP ${response.status}) — remove the saved GitHub token (Settings → About) to keep downloading anonymously, or use the Releases page`,
            );
          }
        } else if (!response.ok || response.body === null) {
          throw new Error(`the asset download answered HTTP ${response.status}`);
        }
        const total = Number(response.headers.get("content-length") ?? "0") || 0;
        updateDownload.total = total;
        const hasher = createHash("sha256");
        let received = 0;
        // Node's fetch body is a web stream; count + hash as it flows through
        // the pipeline into the file.
        const counted = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              received += chunk.byteLength;
              hasher.update(chunk);
              updateDownload.received = received;
              controller.enqueue(chunk);
            },
          }),
        );
        await pipeline(counted as unknown as NodeJS.ReadableStream, createWriteStream(dest));
        updateDownload.status = "verifying";
        if (total > 0 && received !== total) {
          throw new Error(`the download was truncated (${received} of ${total} bytes)`);
        }
        if (digest !== null) {
          const actual = `sha256:${hasher.digest("hex")}`;
          if (actual !== digest.toLowerCase()) {
            throw new Error("the installer failed its sha256 integrity check");
          }
        }
        const size = statSync(dest).size;
        // R104 + R123: the plausibility floor is EXTENSION-AWARE — the real
        // setup.exe is ~37 MB (floor 10 MB as since R91-E), the real AppImage
        // is ~130 MB (floor 50 MB), the real .deb is ~68 MB (floor 20 MB —
        // the R123 deb leg). All floors exist to refuse a saved error page /
        // JSON body; the sha256 digest check above is the real integrity gate.
        const lowerDest = dest.toLowerCase();
        const isAppImage = lowerDest.endsWith(".appimage");
        const isDeb = lowerDest.endsWith(".deb");
        const floorBytes = isAppImage
          ? 50 * 1024 * 1024
          : isDeb
            ? 20 * 1024 * 1024
            : 10 * 1024 * 1024;
        const kindName = isAppImage ? "AppImage" : isDeb ? "deb package" : "installer";
        if (size < floorBytes) {
          throw new Error(`the downloaded file is only ${size} bytes — not a real ${kindName}`);
        }
        updateDownload.path = dest;
        updateDownload.version = version || null;
        updateDownload.status = "ready";
      } catch (err) {
        updateDownload.status = "error";
        // R120-U: the secret-shape scrub belt — the download errors are
        // built from HTTP statuses by construction, but the catch also sees
        // transport throws, and this route attaches a credential header.
        updateDownload.error = scrubSecretShapes(err instanceof Error ? err.message : String(err));
        try {
          if (existsSync(dest)) unlinkSync(dest);
        } catch {
          // best-effort cleanup
        }
      }
    })();
    return reply.code(200).send({ ok: true, status: "downloading" });
  });

  // ── R91-E: the in-app update download PROGRESS ───────────────────────────
  // GET /system/updates/download/progress — the live single-flight state the
  // About tab polls while the bar fills. Read-only, no body needed.
  scope.get("/system/updates/download/progress", async () => ({
    ...updateDownload,
  }));

  // ── R104: the staged-download DISCARD ──────────────────────────────────────
  // DELETE /system/updates/download — the other half of the two-stage update
  // hand-shake: a verified download may sit "ready" (the owner confirmed the
  // DOWNLOAD but not the INSTALL — the v0.100.0 report's core ask). This route
  // lets them walk it back: the staged file is unlinked and the single-flight
  // state returns to idle (a later Download starts clean). A download IN
  // FLIGHT is refused honestly (409) — the single-flight state is the live
  // download's, not the caller's, to cancel out from under.
  scope.delete("/system/updates/download", async (_request, reply) => {
    if (updateDownload.status === "downloading" || updateDownload.status === "verifying") {
      return reply.code(409).send(
        errorBody("CONFLICT", "a download is in flight — wait for it to finish before discarding", {
          status: updateDownload.status,
        }),
      );
    }
    if (updateDownload.status === "ready" && updateDownload.path !== null) {
      try {
        if (existsSync(updateDownload.path)) unlinkSync(updateDownload.path);
      } catch {
        // best-effort: a locked/already-gone staged file never blocks the
        // state reset (the OS temp sweeper owns orphans either way)
      }
    }
    updateDownload.status = "idle";
    updateDownload.received = 0;
    updateDownload.total = 0;
    updateDownload.path = null;
    updateDownload.version = null;
    updateDownload.error = null;
    return reply.code(200).send({ ok: true, status: "idle" });
  });

  // ── ROUND-120 (R120-U): the TOKEN RE-PAIRING PATH ──────────────────────────
  // The owner rotated his GitHub PAT and "Check for updates" answered HTTP
  // 401 (item 1 above); the R120 report's ask is that the NEXT rotation be
  // self-service instead of another support round. Two routes:
  //   · PUT /system/updates/token {pat} — validate the token LIVE against
  //     GET /repos/testplay-byte/ACUTE-CODE (HTTP 200 AND full_name === the
  //     repo — not just "some 200", the token must see THIS repo), then
  //     persist it to ~/.acute/github.pat (the R90-B1 home location the
  //     launcher reads + migrates; mkdir -p; trimmed; newline-terminated).
  //   · GET /system/updates/token — the lightweight health check: present
  //     (something non-blank is saved, env-or-file, SHAPE-FREE so a garbage
  //     file stays honest) + valid (the same live validation, never the
  //     token's value — the PAT never crosses this REST boundary, matching
  //     the R89-A2 ruling that moved the check server-side in the first
  //     place).
  // TRUST MODEL: a paired phone is a view+input medium with CONFIG rights
  // (the R109 ruling — the same standing that lets a phone set provider
  // keys), so neither route joins the device-token blocklist; only
  // /api/v1/system/reset is blocked under /system/*.
  // SECRECY: the PAT is validated and persisted, never logged, never
  // returned — every message this route can emit runs through
  // scrubSecretShapes as the belt (the R82 scrubber gained the classic
  // ghp_… shape this round for exactly this route).
  scope.put("/system/updates/token", async (request, reply) => {
    const body = (request.body ?? null) as { pat?: unknown } | null;
    const pat = typeof body?.pat === "string" ? body.pat.trim() : "";
    // (a) The SHAPE gate — both real GitHub PAT spellings (fine-grained
    //     github_pat_… and classic ghp_…). 400 with the field named.
    if (pat === "" || !(pat.startsWith("github_pat_") || pat.startsWith("ghp_"))) {
      return reply.code(400).send(
        errorBody("VALIDATION", "body.pat must be a GitHub token (it starts with github_pat_ or ghp_)", {
          field: "body.pat",
        }),
      );
    }
    // (b) The LIVE validation — HTTP 200 AND full_name === THIS repo (a
    //     token that answers 200 for some redirect target or a renamed
    //     repo is not "valid for the updater"). 401 for a rejected token,
    //     503 for an unreachable/upstream-weird GitHub, both messages
    //     scrubbed so the PAT can never ride an error line.
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      let repo: { full_name?: unknown };
      try {
        const response = await fetch(GITHUB_REPO_API_URL, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "ACUTE-CODE-token-check",
            Authorization: `Bearer ${pat}`,
          },
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          return reply.code(401).send(
            errorBody(
              "UNAUTHORIZED",
              `GitHub rejected this token (HTTP ${response.status}) — check that it is a valid, unexpired token`,
              { field: "body.pat" },
            ),
          );
        }
        if (!response.ok) {
          return reply.code(503).send(
            errorBody(
              "UNAVAILABLE",
              `GitHub answered HTTP ${response.status} while validating the token — try again`,
              { field: "body.pat" },
            ),
          );
        }
        repo = (await response.json()) as { full_name?: unknown };
      } finally {
        clearTimeout(timeout);
      }
      if (repo.full_name !== GITHUB_REPO) {
        return reply.code(503).send(
          errorBody(
            "UNAVAILABLE",
            `GitHub answered for the wrong repository — expected ${GITHUB_REPO}`,
            { field: "body.pat" },
          ),
        );
      }
    } catch (err) {
      // Network/abort — the honest upstream-unavailable answer, scrubbed.
      const message = scrubSecretShapes(err instanceof Error ? err.message : String(err));
      return reply.code(503).send(
        errorBody("UNAVAILABLE", `cannot reach GitHub to validate the token: ${message}`),
      );
    }
    // (c) The PERSIST — the R90-B1 home location, mkdir -p, trimmed (the
    //     shape gate ran on the trimmed value), newline-terminated (the
    //     launcher's own file grammar), owner-only perms best-effort (a
    //     near-no-op on Windows, right on Linux).
    const patPath = join(homedir(), ".acute", "github.pat");
    try {
      mkdirSync(join(homedir(), ".acute"), { recursive: true });
      writeFileSync(patPath, `${pat}\n`, "utf8");
      try {
        chmodSync(patPath, 0o600);
      } catch {
        // best-effort — a filesystem that refuses chmod keeps the token
        // saved (the ~/.acute directory is the launcher's own trust zone)
      }
    } catch (err) {
      const message = scrubSecretShapes(err instanceof Error ? err.message : String(err));
      return reply.code(500).send(
        errorBody("INTERNAL", `cannot save the token to ~/.acute/github.pat: ${message}`),
      );
    }
    // (d) The env snapshot is now PROVABLY STALE — R90-B1's "env wins"
    //     invariant holds only while the env var mirrors the file; a
    //     re-pair through this route just made the file the newer truth, so
    //     the running sidecar drops the dead export and the very next
    //     /system/updates call rides the FRESH token (the next launcher
    //     start re-exports from the file, restoring the invariant).
    delete process.env.ACUTE_GITHUB_PAT;
    return reply.code(200).send({ ok: true, valid: true });
  });

  // ── ROUND-123 (R123): DELETE /system/updates/token — the REMOVE affordance.
  // The owner's directive made the token's role explicit ("why does it even
  // require a GitHub token? Isn't our GitHub repository public?") — with
  // anonymous-first checks/downloads the token is a pure optional
  // accelerator, and an OPTIONAL credential must be removable in-app: a
  // launcher-era ~/.acute/github.pat (or a rotated dead one) otherwise sits
  // on the machine forever with no UI to retire it. The removal is
  // IDEMPOTENT and honest: {removed: true} when either layer held a token,
  // {removed: false} when none was saved (never a 404 — "already gone" is a
  // success here, not a miss). Both layers are cleared (the file unlinked,
  // the env snapshot dropped) so the very next check runs anonymous by
  // construction; the launcher's next start re-exports from the file only
  // if the file still exists — it does not, so the removal SURVIVES the
  // next launcher start. A refusing filesystem answers 500 with the OS's
  // own scrubbed message (the token stays saved — never silently lost).
  scope.delete("/system/updates/token", async (_request, reply) => {
    const patPath = join(homedir(), ".acute", "github.pat");
    let removed = false;
    if (existsSync(patPath)) {
      try {
        unlinkSync(patPath);
        removed = true;
      } catch (err) {
        const message = scrubSecretShapes(err instanceof Error ? err.message : String(err));
        return reply.code(500).send(
          errorBody("INTERNAL", `cannot remove ~/.acute/github.pat: ${message}`),
        );
      }
    }
    // The env layer — dropped whenever it was set (removed tells the truth
    // about the FILE; the env var's presence alone also counts as "a token
    // was saved on this machine" for the response's honesty).
    if (typeof process.env.ACUTE_GITHUB_PAT === "string" && process.env.ACUTE_GITHUB_PAT !== "") {
      removed = true;
      delete process.env.ACUTE_GITHUB_PAT;
    }
    return reply.code(200).send({ ok: true, removed });
  });

  // ── ROUND-120 (R120-U): the token HEALTH check — present + valid, never
  // the value. present is SHAPE-FREE (readRawGithubPat: something non-blank
  // is saved on either layer); valid is the same live validation the PUT
  // runs, answered as a plain boolean (null when nothing is saved to
  // validate, or when the wire to GitHub never answered — present but
  // unverifiable is honest, not "invalid").
  scope.get("/system/updates/token", async () => {
    const pat = readRawGithubPat();
    if (pat === null) return { present: false, valid: null };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetch(GITHUB_REPO_API_URL, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "ACUTE-CODE-token-check",
            Authorization: `Bearer ${pat}`,
          },
          signal: controller.signal,
        });
        if (!response.ok) return { present: true, valid: false };
        const repo = (await response.json()) as { full_name?: unknown };
        return { present: true, valid: repo.full_name === GITHUB_REPO };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Network — the token is present but unverifiable this call.
      return { present: true, valid: null };
    }
  });

  // ── ROUND-114 (R114-b): the FILESYSTEM BROWSE route (see the module-level
  // comment for the trust-model reasoning — reachable with a DEVICE token;
  // never lists file contents). GET /system/fs/browse?path=<abs>&hidden=<0|1>
  //   → 200 { path, parent, entries: [{name, path, dir}], truncated }
  //     · path omitted/blank → the user's HOME directory (os.homedir());
  //     · entries: DIRECTORIES first, then files, each alphabetical;
  //     · dotfiles skipped unless hidden=1;
  //     · hard cap 400 entries per response — beyond it the response is
  //       truncated and carries truncated: true (always present as a
  //       boolean so the picker can branch without "in" checks);
  //     · parent = the browsed directory's parent — null at a filesystem
  //       root (dirname(path) === path) AND when the browsed directory IS
  //       the user's home (R115-h: navigation caps at home — the picker's
  //       Up never climbs past it; the manual path field stays the
  //       power-user escape hatch). One level below home still answers
  //       the home dir as its parent — Up climbs TO home, never past.
  //   → 404 non-existent path (the OS's ENOENT message rides along);
  //   → 400 unreadable/not-a-directory (the OS's message rides along).
  scope.get("/system/fs/browse", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const rawPath = typeof query.path === "string" ? query.path.trim() : "";
    const target = rawPath === "" ? homedir() : rawPath;
    const includeHidden = query.hidden === "1" || query.hidden === "true";

    // (a) The directory must EXIST and be a directory — statSync's own
    // message rides the honest error (ENOENT → 404; everything else,
    // EACCES included → 400).
    let statResult;
    try {
      statResult = statSync(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return fsError(
        reply,
        isMissing ? 404 : 400,
        isMissing ? "NOT_FOUND" : "VALIDATION",
        `cannot browse '${target}': ${message}`,
      );
    }
    if (!statResult.isDirectory()) {
      return fsError(reply, 400, "VALIDATION", `'${target}' is not a directory`);
    }

    // (b) Read the entries (names + dir flags only — withFileTypes spares
    // one stat per entry). An unreadable directory is the honest 400 with
    // the OS's message, never a 500.
    let dirents;
    try {
      dirents = readdirSync(target, { withFileTypes: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fsError(reply, 400, "VALIDATION", `cannot read '${target}': ${message}`);
    }

    // (c) Filter → shape → sort: dotfiles skipped unless hidden=1; then
    // directories first, files after, each alphabetical (the plain string
    // comparison — deterministic across machines, unlike locale collation).
    const entries: FsBrowseEntry[] = dirents
      .filter((d) => includeHidden || !d.name.startsWith("."))
      .map((d) => ({ name: d.name, path: join(target, d.name), dir: d.isDirectory() }))
      .sort((a, b) =>
        a.dir === b.dir ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.dir ? -1 : 1,
      );

    // (d) The hard cap — 400 entries max, honestly flagged.
    const truncated = entries.length > FS_BROWSE_MAX_ENTRIES;
    const capped = truncated ? entries.slice(0, FS_BROWSE_MAX_ENTRIES) : entries;

    // (e) The parent for the picker's Up affordance — R115-h: navigation
    // caps AT the user's home directory (components.md's folder-browser
    // rule — "no 'up' affordance past it"): null at a filesystem root
    // (dirname("/") === "/", dirname("C:\\") === "C:\\") AND when the
    // browsed directory IS the home directory itself (the sheet starts
    // there). A direct child of home keeps home as its parent — Up
    // arrives at home and stops, never past it.
    const parentDir = dirname(target);
    const parent = parentDir === target || target === homedir() ? null : parentDir;
    return reply.code(200).send({
      path: target,
      parent,
      entries: capped,
      truncated,
    });
  });

  // ── ROUND-118 (R118-E): the CREATE-FOLDER route — the browse's write
  // twin, so a NEW folder can become a project the moment it exists (before
  // this, POST /projects statSync-validates the root and 404s on a fresh
  // folder — a brand-new directory genuinely could not be registered).
  // POST /system/fs/mkdir {parentPath, name}
  //   → 201 {path, name, dir: true}   (the browse entry's shape verbatim)
  //   → 400 VALIDATION (field-named)  a relative parentPath, a parent that
  //                                    is not a directory, or a name the
  //                                    phone's folderNameValid would have
  //                                    refused ("" · >60 · separators ·
  //                                    "."/".." · leading dot · control)
  //   → 404 NOT_FOUND                  a missing parent (the browse route's
  //                                    ENOENT spelling; also the stat→mkdir
  //                                    race where it vanished mid-flight)
  //   → 409 CONFLICT                   EEXIST — the folder is already there
  // TRUST MODEL (the R114-b ruling, unchanged): a paired phone is a
  // view+input medium with CONFIG rights — mkdir is phone-reachable by
  // construction (the device-token blocklist blocks only /system/reset,
  // cloud-connector, internal/, computer-use/, keys/reveal, terminal);
  // no blocklist change ships with this route. DIRECTORIES only, ONE level
  // (recursive:false — the route never silently materializes a missing
  // parent chain), and the name is separator-free so join() cannot climb.
  scope.post("/system/fs/mkdir", async (request, reply) => {
    const body = (request.body ?? null) as { parentPath?: unknown; name?: unknown } | null;
    const rawParent = typeof body?.parentPath === "string" ? body.parentPath.trim() : "";
    const rawName = typeof body?.name === "string" ? body.name : "";

    // (a) parentPath — absolute (the route resolves nothing against cwd),
    // then existing + a directory, with the browse route's exact error
    // spelling (ENOENT → 404; EACCES & friends → 400; the OS's own message
    // rides along).
    if (!isAbsolute(rawParent)) {
      return reply.code(400).send(
        errorBody("VALIDATION", "body.parentPath must be an absolute directory path", {
          field: "body.parentPath",
        }),
      );
    }
    let parentStat;
    try {
      parentStat = statSync(rawParent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return fsError(
        reply,
        isMissing ? 404 : 400,
        isMissing ? "NOT_FOUND" : "VALIDATION",
        `cannot create in '${rawParent}': ${message}`,
      );
    }
    if (!parentStat.isDirectory()) {
      return fsError(reply, 400, "VALIDATION", `'${rawParent}' is not a directory`);
    }

    // (b) name — the SAME rules the phone's folderNameValid enforces
    // client-side (fs-browse.ts); the client pre-refuses, the route is the
    // wall. Every 400 names its field.
    const trimmedName = rawName.trim();
    const nameRejection =
      trimmedName === ""
        ? "body.name must be a folder name"
        : trimmedName.length > 60
          ? "body.name is capped at 60 characters"
          : trimmedName.includes("/") || trimmedName.includes("\\")
            ? "body.name cannot contain separators"
            : trimmedName === "." || trimmedName === ".."
              ? "body.name must be a real folder name"
              : trimmedName.startsWith(".")
                ? "body.name cannot start with a dot"
                : /[\u0000-\u001f\u007f]/.test(trimmedName)
                  ? "body.name cannot contain control characters"
                  : null;
    if (nameRejection !== null) {
      return reply.code(400).send(errorBody("VALIDATION", nameRejection, { field: "body.name" }));
    }

    // (c) Create — one level, never recursive; EEXIST is the honest 409
    // (the phone's inline namer renders "a folder with that name already
    // exists"); a parent that vanished mid-flight answers the same 404 the
    // browse gives it.
    const abs = join(rawParent, trimmedName);
    try {
      mkdirSync(abs, { recursive: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return fsError(reply, 409, "CONFLICT", `'${abs}' already exists`);
      }
      if (code === "ENOENT") {
        return fsError(reply, 404, "NOT_FOUND", `cannot create in '${rawParent}': ${message}`);
      }
      return fsError(reply, 400, "VALIDATION", `cannot create '${abs}': ${message}`);
    }
    return reply.code(201).send({ path: abs, name: trimmedName, dir: true });
  });

  scope.post("/system/reset", async () => {
    // 1. Abort every live turn (main sessions + sub-agent children) so no
    // in-flight agent writes to rows mid-wipe. The SSE streams unwind on
    // their own abort paths — the webview is reloading anyway.
    const aborted = liveTurnIds();
    for (const sessionId of aborted) {
      abortTurn(sessionId, "owner");
    }

    // 2. In-memory state: the keyring env snapshot + the sidecar-held
    // terminal PTYs.
    keyring.clear();
    terminalSessionsDisposeAll();

    // 3. The wipe + reseed, one transaction with FKs off (the sweep's
    // parent/child order is unknowable when everything goes).
    const tables = userDataTables(db);
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        for (const table of tables) {
          db.prepare(`DELETE FROM "${table}"`).run();
        }
        reseedFactoryData(db);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }

    // 4. Shrink the file back to fresh-install size (must run OUTSIDE a
    // transaction — better-sqlite3 throws inside one).
    db.exec("VACUUM");

    // 5. Machine-scoped files, best-effort.
    const purged = purgeAcuteDir();
    if (ctx.dataDir !== undefined) {
      const vapidPath = join(ctx.dataDir, "vapid.json");
      try {
        if (existsSync(vapidPath)) {
          unlinkSync(vapidPath);
          purged.push(vapidPath);
        }
      } catch {
        // best-effort — regenerated on next boot
      }
      // R122: the self-feedback LEDGER file goes with the rest of the
      // machine's state — a full reset is the journey back to first-run,
      // and a stale ledger surviving it would attribute fresh sessions to
      // a wiped world. Best-effort, exactly like vapid.json.
      const feedbackPath = join(ctx.dataDir, "feedback.md");
      try {
        if (existsSync(feedbackPath)) {
          unlinkSync(feedbackPath);
          purged.push(feedbackPath);
        }
      } catch {
        // best-effort — regenerated on the first post-reset turn
      }
    }

    return {
      ok: true,
      abortedTurns: aborted.length,
      wipedTables: tables.length,
      purgedFiles: purged.length,
    };
  });
}
