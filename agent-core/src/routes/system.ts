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
import { rmSync, readdirSync, statSync, existsSync, unlinkSync, readFileSync, createWriteStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { errorBody } from "./helpers.js";
import { reseedFactoryData, type SqliteDatabase } from "../storage/db.js";
import { abortTurn, liveTurnIds } from "../lib/turn-registry.js";
import { terminalSessionsDisposeAll } from "../terminal-sessions.js";

const GITHUB_REPO = "testplay-byte/ACUTE-CODE";
const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases`;

// ── R91-E: the IN-APP UPDATER's download state ─────────────────────────────
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

/** The GitHub release JSON shape the updater cares about (tag + assets). */
interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
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

/** Finds the x64 setup.exe asset of a release (the NSIS installer the
 * launcher-kit job uploads — `ACUTE-CODE_<v>_x64-setup.exe`).
 *
 * R94-B: the owner's "Update now" died with "body.url must be a GitHub
 * release asset of this repository" because the pre-R94 code returned ONLY
 * `browser_download_url` (host github.com) while the download route's
 * allowlist accepted ONLY api.github.com / objects.githubusercontent.com —
 * every real download was rejected by construction. Each GitHub asset
 * carries BOTH URL forms; we now prefer the API `url` (the token-friendly
 * api.github.com surface) and fall back to `browser_download_url` (the
 * github.com /releases/download permalink, which the allowlist accepts too).
 * Both empty → null (no usable asset). */
function findInstallerAsset(release: GithubRelease): {
  url: string;
  size: number;
  digest: string | null;
} | null {
  for (const asset of release.assets ?? []) {
    const name = typeof asset.name === "string" ? asset.name : "";
    if (name.endsWith("_x64-setup.exe")) {
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
 * only. Returns null when absent/unreadable (proceed anonymously). */
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
    if (!pat.startsWith("github_pat_")) return null;
    return pat;
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
  scope.get("/system/updates", async () => {
    const current = appVersion();
    const base = { current, releasesUrl: GITHUB_RELEASES_PAGE };
    const pat = readLauncherGithubPat();
    // R94-B: PAT-optional — the repo is public, so the header is attached
    // only when a token exists; the anonymous call proceeds below either way.
    const requestHeaders: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ACUTE-CODE-update-check",
    };
    if (pat !== null) {
      requestHeaders.Authorization = `Bearer ${pat}`;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
          headers: requestHeaders,
          signal: controller.signal,
        });
        if (response.status === 404) {
          return {
            ...base,
            ok: false,
            reason: "no-release",
            // R94-B: the anonymous 404 no longer implies "your token cannot
            // see this repo" — the repo is public, so the honest framing is
            // reachability/publish state (no token needed for either).
            error:
              pat === null
                ? "no published release is visible (the repository is public — no token required; is the network reachable?)"
                : "no published release is visible to this token yet",
          };
        }
        if (!response.ok) {
          return {
            ...base,
            ok: false,
            reason: "github",
            error: `GitHub answered HTTP ${response.status}`,
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
        // R91-E: the INSTALLER ASSET — the About tab's in-app "Update now"
        // hands this URL + digest to POST /system/updates/download below.
        // (The digest is GitHub's own server-side sha256 of the uploaded
        // asset — the same value the launcher verifies against.)
        const asset = findInstallerAsset(release);
        return {
          ...base,
          ok: true,
          latest,
          updateAvailable,
          releaseUrl:
            typeof release.html_url === "string" ? release.html_url : GITHUB_RELEASES_PAGE,
          ...(asset !== null
            ? { asset: { url: asset.url, size: asset.size, digest: asset.digest } }
            : {}),
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      return {
        ...base,
        ok: false,
        reason: "network",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ── R91-E: the in-app update DOWNLOAD ──────────────────────────────────────
  // POST /system/updates/download {url, digest?} — stream the setup.exe to a
  // temp file, then sha256-verify it against the release's digest. The
  // caller polls GET /system/updates/download/progress for the live byte
  // count; status "ready" carries the absolute path that the Rust shell's
  // run_update_installer command executes. The URL must belong to THIS
  // repo's release assets (the PAT-bearing fetch would otherwise be an
  // open proxy) — enforced below.
  scope.post("/system/updates/download", async (request, reply) => {
    // R94-B: PAT-optional — the repo is public, so anonymous downloads work;
    // the launcher's token, when present, only raises the rate limit (it is
    // attached below). No 409 no-token wall anymore.
    const pat = readLauncherGithubPat();
    const body = request.body as { url?: unknown; digest?: unknown; version?: unknown } | null;
    const url = typeof body?.url === "string" ? body.url : "";
    const digest = typeof body?.digest === "string" && body.digest.startsWith("sha256:") ? body.digest : null;
    const version = typeof body?.version === "string" ? body.version.replace(/^v/, "") : "";
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
    // Fire-and-forget: the POST answers immediately; the progress route
    // carries the live state (the About tab's progress bar).
    void (async () => {
      const dest = join(tmpdir(), `ACUTE-CODE-${version || "update"}-x64-setup.exe`);
      try {
        // R94-B: the PAT is optional — anonymous downloads work on the
        // public repo; the Authorization header rides along only when a
        // launcher token exists (raising the rate limit).
        const downloadHeaders: Record<string, string> = {
          "User-Agent": "ACUTE-CODE-in-app-updater",
          Accept: "application/octet-stream",
        };
        if (pat !== null) {
          downloadHeaders.Authorization = `Bearer ${pat}`;
        }
        const response = await fetch(url, {
          headers: downloadHeaders,
          redirect: "follow",
        });
        if (!response.ok || response.body === null) {
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
        if (size < 10 * 1024 * 1024) {
          throw new Error(`the downloaded file is only ${size} bytes — not a real installer`);
        }
        updateDownload.path = dest;
        updateDownload.version = version || null;
        updateDownload.status = "ready";
      } catch (err) {
        updateDownload.status = "error";
        updateDownload.error = err instanceof Error ? err.message : String(err);
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
    }

    return {
      ok: true,
      abortedTurns: aborted.length,
      wipedTables: tables.length,
      purgedFiles: purged.length,
    };
  });
}
