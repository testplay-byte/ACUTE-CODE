/**
 * ROUND-87 (R87, owner directive): the dedicated ABOUT section — "the
 * version of the app, where the version will be shown and other About
 * settings, the update options, and all other things … In the About section
 * there will be options to reset the whole application."
 *
 * Cards:
 *  · VERSION — the app version (the same single source the release
 *    pipeline enforces), a check-for-updates button (GitHub's latest
 *    release API — api.github.com allows CORS, and the desktop CSP is
 *    open), and the releases link.
 *  · ABOUT — what the app is + the delivery phase.
 *  · RESET (danger zone) — type RESET to arm the button, then the full
 *    journey back to first-run: purge Credential Manager (Tauri) →
 *    POST /system/reset (wipes every table + reseeds factory state +
 *    purges the ~/.acute machine files) → clear the webview's
 *    localStorage stores + react-query cache → reload to onboarding.
 *
 * ROUND-99 (R99-A): the Releases link routes through the central link
 * router (lib/open-link) — the app's OWN embedded browser by default (the
 * owner's native-browser directive), with an explicit "open externally"
 * affordance beside it as the escape hatch to the device's browser. The
 * pre-R99 inline `__TAURI__` invoke duplication is GONE (open-link owns
 * both the Rust handoff and the web-mode window.open fallback); AboutTab
 * is a GLOBAL surface, so with no project context openLink honestly falls
 * back to the system browser (open-link's no-project leg).
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, ExternalLink, Info, PackageOpen, ShieldAlert } from "lucide-react";
import { APP_NAME, APP_VERSION, PHASE } from "../../lib/version";
import { isTauri } from "../../lib/sidecar";
// R99-A: the ONE sanctioned link router — the Releases link opens in the
// app's OWN browser panel by default; the external affordance beside it is
// the deliberate escape hatch to the device's browser.
import { openLink } from "../../lib/open-link";
import {
  fetchSystemUpdates,
  fetchUpdateDownloadProgress,
  resetApplication,
  startUpdateDownload,
  type SystemUpdateCheck,
} from "../../lib/api";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { bdr, withAlpha } from "../dashboard/helpers";

const RELEASES_URL = "https://github.com/testplay-byte/ACUTE-CODE/releases";

/** R99-A: the Releases link through the CENTRAL link router — the app's
 * own embedded browser by default (the owner's native-browser directive);
 * `forceExternal` is the deliberate escape hatch to the device's browser.
 * Replaces the R89-A3 inline `__TAURI__` invoke (open-link owns the Rust
 * open_external_url handoff AND the web-mode window.open fallback now).
 * The result is logged — never swallowed — when the system leg fails. */
async function openReleasesPage(forceExternal: boolean): Promise<void> {
  const result = await openLink(RELEASES_URL, { forceExternal });
  if (result.outcome === "error") {
    console.error("[about] opening the releases page failed:", result.message);
  }
}

/** Every localStorage store the app persists (the reset flow clears them
 * all — the keys mirror the stores' persist configs). R89-A1: the
 * first-run gate key `acute.setupDone` is in the list too — the owner's
 * verdict: after "Reset everything" the app restarted on the DASHBOARD
 * instead of the setup wizard, even across a full close+reopen, because
 * this one key survived the sweep. It gates App.tsx's /setup redirect
 * (shouldRunSetup → localStorage "acute.setupDone"). */
const LOCAL_STORAGE_KEYS = [
  "acute.setupDone",
  "acute-code.theme",
  "acute-code.config",
  "acute-code.settings",
  "acute-code.rightSidebar",
  "acute-code.projectChat",
  "acute-code.sidebar.expandedProjects",
];

/** The webview side of the Tauri key purge — the Rust command deletes every
 * ACUTE-CODE credential (builtins + noted customs + vision slugs, both the
 * canonical and legacy target forms) and clears the note files. In web dev
 * mode there is nothing OS-level to purge (the keyring is in-memory and the
 * /system/reset route clears it). */
async function purgeDesktopKeys(): Promise<void> {
  if (!isTauri()) return;
  try {
    const tauri = (window as { __TAURI__?: { core: { invoke: (command: string) => Promise<unknown> } } })
      .__TAURI__;
    if (tauri === undefined) throw new Error("Tauri shell unavailable");
    await tauri.core.invoke("purge_provider_keys");
  } catch (err) {
    // Never block the reset on a locked credential entry — the honest
    // console error is enough (the owner can clear stragglers by hand).
    console.error("[reset] purge_provider_keys failed:", err);
  }
}

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; latest: string }
  | { kind: "available"; latest: string; asset?: SystemUpdateCheck["asset"] }
  | { kind: "error"; message: string };

/** R91-E: the IN-APP UPDATE flow's UI state (on top of UpdateState's check
 * results). Downloading → the progress bar; ready → the "run it" step;
 * launched → the installer took over (the app exits on its own). */
type InstallState =
  | { kind: "idle" }
  | { kind: "downloading"; received: number; total: number }
  | { kind: "verifying" }
  | { kind: "ready"; path: string }
  | { kind: "launched"; version: string }
  | { kind: "error"; message: string };

/** R91-E: human byte count for the download readout ("35.4 MB of 35.4 MB"). */
function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function VersionCard() {
  const styles = useThemeStyles();
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  // R91-E: the in-app update flow's state (null until the owner clicks
  // "Update now" on an available release).
  const [install, setInstall] = useState<InstallState>({ kind: "idle" });

  // R89-A2: the check runs SERVER-SIDE (GET /system/updates — the sidecar
  // reads the launcher's ~/.acute/github.pat; the repo is PRIVATE so the
  // old anonymous webview fetch to api.github.com answered 404, the owner's
  // verdict). The version comparison is the same tuple walk as before.
  const checkForUpdates = async () => {
    setUpdate({ kind: "checking" });
    setInstall({ kind: "idle" });
    try {
      const result: SystemUpdateCheck = await fetchSystemUpdates();
      if (!result.ok) {
        throw new Error(result.error ?? result.reason ?? "the update check failed");
      }
      const latest = result.latest ?? "";
      if (latest === "") throw new Error("no published release found");
      setUpdate(
        result.updateAvailable
          ? { kind: "available", latest, asset: result.asset }
          : { kind: "current", latest },
      );
    } catch (err) {
      setUpdate({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // R91-E: THE IN-APP UPDATE — "Update now" downloads the verified installer
  // (the sidecar streams it + sha256-checks it), then hands the path to the
  // Rust shell's run_update_installer, which launches the NSIS setup and
  // closes the app. Only offered inside the desktop shell (a browser has no
  // installer to run) and only when the release carried a setup.exe asset.
  const updateNow = async () => {
    if (update.kind !== "available") return;
    if (update.asset === undefined) {
      setInstall({
        kind: "error",
        message: "this release has no downloadable installer asset — use the Releases page",
      });
      return;
    }
    try {
      await startUpdateDownload({
        url: update.asset.url,
        digest: update.asset.digest,
        version: update.latest,
      });
      setInstall({ kind: "downloading", received: 0, total: update.asset.size });
      // Poll the live state until it settles (ready | error).
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const state = await fetchUpdateDownloadProgress();
        if (state.status === "downloading") {
          setInstall({ kind: "downloading", received: state.received, total: state.total });
          continue;
        }
        if (state.status === "verifying") {
          setInstall({ kind: "verifying" });
          continue;
        }
        if (state.status === "ready" && state.path !== null) {
          setInstall({ kind: "ready", path: state.path });
          // The shell half: validate + launch the installer (it closes the
          // app 1.5s later — the reply lands first so this message shows).
          const tauri = (window as { __TAURI__?: { core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } } })
            .__TAURI__;
          if (tauri === undefined) {
            setInstall({
              kind: "error",
              message: "the desktop shell is unavailable — the installer is downloaded but must be run by hand",
            });
            return;
          }
          try {
            await tauri.core.invoke("run_update_installer", { path: state.path });
            setInstall({ kind: "launched", version: update.latest });
          } catch (err) {
            setInstall({
              kind: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }
        if (state.status === "error") {
          setInstall({ kind: "error", message: state.error ?? "the download failed" });
          return;
        }
        // idle (a fresh sidecar restarted mid-download): restart the loop's
        // expectation honestly.
        setInstall({ kind: "error", message: "the download stopped — the engine restarted; try again" });
        return;
      }
    } catch (err) {
      setInstall({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <section
      className="rounded-[16px] border-[1.5px] p-5"
      style={{ borderColor: bdr("1.5px", styles.border), background: styles.card, boxShadow: styles.softShadow }}
      aria-label="Version"
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
            Version
          </div>
          <div
            className="mt-1 text-[30px] font-black leading-none tracking-[-0.02em]"
            style={{ color: styles.text }}
          >
            v{APP_VERSION}
          </div>
          <div className="mt-1.5 text-[11.5px]" style={{ color: styles.textSecondary }}>
            {APP_NAME} · local-first multi-agent workbench
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void checkForUpdates()}
            disabled={update.kind === "checking"}
            className="h-9 px-4 rounded-full text-[11.5px] font-bold border-[1.5px] transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
            style={{ borderColor: withAlpha(styles.accent, 0.5), color: styles.accent }}
          >
            {update.kind === "checking" ? "Checking…" : "Check for updates"}
          </button>
          <button
            type="button"
            onClick={() => void openReleasesPage(false)}
            title="The releases page — opens in ACUTE-CODE's built-in browser (your device's browser when no project is open)"
            className="h-9 px-3.5 rounded-full text-[11.5px] font-bold border-[1.5px] flex items-center gap-1.5 transition-colors hover:opacity-80"
            style={{ borderColor: bdr("1.5px", styles.border), color: styles.textSecondary }}
            aria-label="Open the releases page"
            data-testid="about-releases-button"
          >
            Releases
          </button>
          {/* R99-A: the explicit escape hatch — the user can ALWAYS reach the
              device's browser deliberately (forceExternal beats every
              preference; the BrowserPanel's own Open-externally control is
              the same gesture inside the browser). */}
          <button
            type="button"
            onClick={() => void openReleasesPage(true)}
            aria-label="Open the releases page in your device's browser"
            title="Open the releases page in your device's browser (explicit action)"
            data-testid="about-releases-external"
            className="h-9 w-9 grid place-items-center rounded-full border-[1.5px] transition-colors hover:opacity-80"
            style={{ borderColor: bdr("1.5px", styles.border), color: styles.textSecondary }}
          >
            <ExternalLink size={12} />
          </button>
        </div>
      </div>
      <div className="mt-3 min-h-[18px]">
        {update.kind === "current" ? (
          <span
            className="text-[11.5px] font-semibold flex items-center gap-1.5"
            style={{ color: "#22c55e" }}
            data-testid="update-state"
          >
            <CheckCircle2 size={13} /> Up to date — v{APP_VERSION} is the latest published release
          </span>
        ) : update.kind === "available" ? (
          <div className="flex flex-col gap-2" data-testid="update-state">
            <span className="text-[11.5px] font-semibold flex items-center gap-1.5" style={{ color: styles.accent }}>
              <Download size={13} /> Update available — v{update.latest} is published.
            </span>
            {/* R91-E: the in-app action — download + run the installer without
                leaving the app (the desktop shell only; web dev shows the
                Releases link instead). */}
            {isTauri() ? (
              install.kind === "idle" ? (
                <button
                  type="button"
                  onClick={() => void updateNow()}
                  disabled={update.asset === undefined}
                  title={
                    update.asset === undefined
                      ? "This release has no installer asset — use the Releases page"
                      : "Downloads the verified installer and runs it — the app closes and the setup wizard takes over"
                  }
                  className="h-9 px-4 rounded-full text-[11.5px] font-bold transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100 inline-flex items-center gap-1.5 self-start"
                  style={{ background: styles.accent, color: styles.accentText }}
                  data-testid="update-now-button"
                >
                  <PackageOpen size={13} /> Update now
                </button>
              ) : install.kind === "downloading" ? (
                <div className="flex items-center gap-3 max-w-[420px]" data-testid="update-progress">
                  <div
                    className="flex-1 h-2 rounded-full overflow-hidden"
                    style={{ background: styles.isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)" }}
                  >
                    <div
                      className="h-full rounded-full transition-[width] duration-300"
                      style={{
                        width: install.total > 0 ? `${Math.min(100, (install.received / install.total) * 100)}%` : "30%",
                        background: styles.accent,
                      }}
                    />
                  </div>
                  <span className="font-mono text-[10.5px] shrink-0" style={{ color: styles.textTertiary }}>
                    {fmtMB(install.received)}
                    {install.total > 0 ? ` / ${fmtMB(install.total)}` : ""}
                  </span>
                </div>
              ) : install.kind === "verifying" ? (
                <span className="text-[11.5px] font-semibold" style={{ color: styles.textSecondary }} data-testid="update-verifying">
                  Verifying the installer's checksum…
                </span>
              ) : install.kind === "ready" ? (
                <span className="text-[11.5px] font-semibold" style={{ color: styles.textSecondary }}>
                  Installer verified — launching…
                </span>
              ) : install.kind === "launched" ? (
                <span className="text-[11.5px] font-semibold" style={{ color: "#22c55e" }} data-testid="update-launched">
                  Installer launched — the setup wizard will close this app and install v{install.version}. Your data
                  is kept.
                </span>
              ) : (
                <span className="text-[11.5px]" style={{ color: SEMANTIC_DANGER }} role="alert">
                  The in-app update failed ({install.message}). The launcher's ACUTE.bat update still works, and the
                  Releases page always has the latest.
                </span>
              )
            ) : (
              <span className="text-[11.5px]" style={{ color: styles.textSecondary }}>
                Web mode — use ACUTE.bat or the Releases page to install v{update.latest}.
              </span>
            )}
          </div>
        ) : update.kind === "error" ? (
          <span className="text-[11.5px]" style={{ color: SEMANTIC_DANGER }} data-testid="update-state">
            Could not check for updates ({update.message}) — the Releases page always has the latest.
          </span>
        ) : null}
      </div>
    </section>
  );
}

function AboutCard() {
  const styles = useThemeStyles();
  const rows = useMemo(
    () =>
      [
        ["Application", APP_NAME],
        ["Version", `v${APP_VERSION}`],
        ["Delivery phase", String(PHASE)],
        ["Engine", "local sidecar (agent-core) + embedded webview shell"],
        ["Storage", "SQLite + OS secure key store — everything stays on this PC"],
      ] as Array<[string, string]>,
    [],
  );
  return (
    <section
      className="rounded-[16px] border-[1.5px] p-5"
      style={{ borderColor: bdr("1.5px", styles.border), background: styles.card, boxShadow: styles.softShadow }}
      aria-label="About"
    >
      <div className="flex items-center gap-2 mb-3">
        <Info size={13} style={{ color: styles.accent }} />
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
          About
        </span>
      </div>
      <dl className="flex flex-col gap-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 min-w-0">
            <dt className="text-[11.5px] shrink-0" style={{ color: styles.textTertiary }}>
              {label}
            </dt>
            <dd className="text-[11.5px] font-semibold text-right min-w-0 break-words" style={{ color: styles.text }}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ResetCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [confirmText, setConfirmText] = useState("");
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = confirmText.trim() === "RESET";

  const runReset = async () => {
    if (!armed || resetting) return;
    setResetting(true);
    setError(null);
    try {
      // 1. The OS credential store FIRST (the Rust command reads the note
      //    files to know which custom targets to erase — the sidecar's purge
      //    below deletes those files themselves).
      await purgeDesktopKeys();
      // 2. The server-side wipe (turns abort, keyring clear, every table
      //    wiped + factory reseed, ~/.acute machine files purged, VACUUM).
      await resetApplication();
      // 3. The webview's own state: every persisted store + the query cache.
      for (const key of LOCAL_STORAGE_KEYS) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // a locked entry never blocks the reload
        }
      }
      queryClient.clear();
      // 4. The full journey back to first-run.
      window.location.href = "/";
    } catch (err) {
      setResetting(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section
      className="rounded-[16px] border-[1.5px] p-5"
      style={{
        borderColor: withAlpha(SEMANTIC_DANGER, 0.5),
        background: withAlpha(SEMANTIC_DANGER, styles.isDark ? 0.06 : 0.03),
      }}
      aria-label="Reset application"
    >
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlert size={13} style={{ color: SEMANTIC_DANGER }} />
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: SEMANTIC_DANGER }}>
          Danger zone
        </span>
      </div>
      <h3 className="text-[14px] font-bold mb-1" style={{ color: styles.text }}>
        Reset the entire application
      </h3>
      <p className="text-[11.5px] leading-relaxed mb-3" style={{ color: styles.textSecondary }}>
        Removes <strong>everything</strong> and returns the app to its first-run state: all projects, sessions,
        agents, usage history, memory, and settings are deleted; every provider and model is removed (including
        their keys — the OS secure store is purged); the onboarding setup runs again on reload. Files on your
        disk are never touched.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          disabled={resetting}
          placeholder='Type "RESET" to confirm'
          className="h-9 w-[200px] rounded-full border-[1.5px] px-4 text-[11.5px] outline-none"
          style={{
            borderColor: armed ? withAlpha(SEMANTIC_DANGER, 0.7) : bdr("1.5px", styles.border),
            background: styles.isDark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.03)",
            color: styles.text,
          }}
          aria-label="Type RESET to confirm the application reset"
          data-testid="reset-confirm-input"
        />
        <button
          type="button"
          onClick={() => void runReset()}
          disabled={!armed || resetting}
          className="h-9 px-4 rounded-full text-[11.5px] font-bold transition-all hover:scale-[1.02] active:scale-95 disabled:hover:scale-100 disabled:opacity-40"
          style={{ background: SEMANTIC_DANGER, color: "#fff" }}
          data-testid="reset-confirm-button"
        >
          {resetting ? "Resetting…" : "Reset everything"}
        </button>
      </div>
      {error !== null ? (
        <p className="mt-2 text-[11px]" style={{ color: SEMANTIC_DANGER }} role="alert">
          Reset failed: {error}
        </p>
      ) : null}
    </section>
  );
}

export function AboutTab() {
  const styles = useThemeStyles();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4" data-testid="about-tab">
      <div className="pb-1">
        <h2 className="text-[16px] font-black" style={{ color: styles.text }}>
          About
        </h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          Version, updates, and the application reset.
        </p>
      </div>
      <VersionCard />
      <AboutCard />
      <ResetCard />
    </div>
  );
}

const SEMANTIC_DANGER = "#ef4444";
