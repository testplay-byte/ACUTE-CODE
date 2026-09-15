/**
 * ROUND-87 (R87, owner directive): the dedicated ABOUT section — "the
 * version of the app, where the version will be shown and other About
 * settings, the update options, and all other things … In the About section
 * there will be options to reset the whole application."
 *
 * Cards:
 *  · VERSION — the app version (the same single source the release
 *    pipeline enforces), a check-for-updates button (the sidecar's
 *    server-side GET /system/updates), and the releases link.
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
 *
 * ROUND-99 (R99-C): THE ONE-CLICK UPDATE (owner: "I click the update
 * button in the application and everything else happens automatically
 * afterwards by itself without me having to make any changes"):
 *  · "Update now" runs the WHOLE sequence — download (byte-true progress,
 *    the real chunk data only, never a fake bar) → checksum verify →
 *    SILENT install (run_update_installer {path, silent:true} → NSIS "/S
 *    /R": no wizard pages, and the installer template's own post-success
 *    hook relaunches the app) → the window's terminal line
 *    "Restarting into vX…" for the 1.5s the Rust exit timer allows.
 *  · THE HONEST FALLBACK: if the silent launch invoke REJECTS, the error
 *    renders with a secondary "Run the setup wizard manually" button that
 *    re-runs the flow with silent:false — the legacy interactive wizard,
 *    kept for pathological machines. It reuses the already-verified
 *    installer when one sits ready (no redundant re-download).
 *  · RELEASE NOTES: the release body (GET /system/updates `body`, capped
 *    at 8,000 chars by the route) renders as a collapsible "What's new"
 *    block — plain text, mono 12px, collapsed to ~4 lines, max-h + scroll
 *    when expanded (the long-list discipline).
 *  · AUTO-CHECK TOGGLE: "Check for updates automatically" (default ON,
 *    persisted in the update-checker store) — the startup check this
 *    round adds (lib/update-checker.ts); the manual button also refreshes
 *    the sidebar's pending-update dot from every answer (both paths ride
 *    syncPendingVersionFromResult).
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  Info,
  PackageOpen,
  ShieldAlert,
} from "lucide-react";
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
// R99-C: the auto-check toggle + the badge sync (one store, two surfaces).
import { syncPendingVersionFromResult, useUpdateCheckerStore } from "../../lib/update-checker";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { ToggleSwitch } from "../ui/toggle-switch";
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
 * (shouldRunSetup → localStorage "acute.setupDone").
 * R99-C: `acute-code.updates` (the update-checker store — auto-check
 * toggle + cadence stamp + pending flag) joins the sweep so a reset
 * returns the auto-check to its fresh-install default. */
const LOCAL_STORAGE_KEYS = [
  "acute.setupDone",
  "acute-code.theme",
  "acute-code.config",
  "acute-code.settings",
  "acute-code.rightSidebar",
  "acute-code.projectChat",
  "acute-code.sidebar.expandedProjects",
  "acute-code.updates",
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
  | { kind: "available"; latest: string; body: string; asset?: SystemUpdateCheck["asset"] }
  | { kind: "error"; message: string };

/** R91-E + R99-C: the IN-APP UPDATE flow's UI state (on top of UpdateState's
 * check results). downloading → byte-true progress; verifying → the sha256
 * check; installing → the silent (or wizard) launch invoke is in flight
 * (the Rust pre-install kill can hold this state for seconds — honest);
 * launched → the installer took over and the Rust exit timer owns the rest.
 * error carries offerWizard when the SILENT launch leg rejected — the
 * legacy interactive wizard stays one click away (the escape hatch). */
type InstallState =
  | { kind: "idle" }
  | { kind: "downloading"; received: number; total: number }
  | { kind: "verifying" }
  | { kind: "installing"; version: string; silent: boolean }
  | { kind: "launched"; version: string; silent: boolean }
  | { kind: "error"; message: string; offerWizard: boolean };

/** R91-E: human byte count for the download readout ("35.4 MB"). */
function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** R99-C: the plain-text release-notes body — collapse runs of blank lines
 * (markdown changelogs ship 3+ newlines between sections; three in a row
 * is just vertical noise in a mono block). The route already capped the
 * length; this only normalizes whitespace. */
function normalizeReleaseBody(raw: string): string {
  return raw
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The `__TAURI__.core.invoke` handle — null outside the desktop shell. */
function tauriInvoke(): ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  if (!isTauri()) return null;
  const tauri = (window as { __TAURI__?: { core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } } })
    .__TAURI__;
  return tauri === undefined ? null : tauri.core.invoke;
}

function VersionCard() {
  const styles = useThemeStyles();
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  // R91-E: the in-app update flow's state (idle until the owner clicks
  // "Update now" on an available release).
  const [install, setInstall] = useState<InstallState>({ kind: "idle" });
  // R99-C: the release-notes block starts collapsed (~4 lines) — the body
  // is a reference surface, not the decision.
  const [notesExpanded, setNotesExpanded] = useState(false);
  // R99-C: the auto-check toggle (persisted in the update-checker store —
  // the same store the startup check + the sidebar dot read).
  const autoCheck = useUpdateCheckerStore((s) => s.autoCheck);
  const setAutoCheck = useUpdateCheckerStore((s) => s.setAutoCheck);

  // R89-A2: the check runs SERVER-SIDE (GET /system/updates — the sidecar
  // reads the launcher's ~/.acute/github.pat; the repo is PRIVATE so the
  // old anonymous webview fetch to api.github.com answered 404, the owner's
  // verdict). The version comparison is the same tuple walk as before.
  // R99-C: every manual answer ALSO refreshes the sidebar's pending-update
  // dot (syncPendingVersionFromResult — the same sync the scheduled
  // startup check rides, so the badge can never disagree with the button).
  const checkForUpdates = async () => {
    setUpdate({ kind: "checking" });
    setInstall({ kind: "idle" });
    try {
      const result: SystemUpdateCheck = await fetchSystemUpdates();
      syncPendingVersionFromResult(result);
      if (!result.ok) {
        throw new Error(result.error ?? result.reason ?? "the update check failed");
      }
      const latest = result.latest ?? "";
      if (latest === "") throw new Error("no published release found");
      setUpdate(
        result.updateAvailable
          ? {
              kind: "available",
              latest,
              body: normalizeReleaseBody(result.body ?? ""),
              asset: result.asset,
            }
          : { kind: "current", latest },
      );
    } catch (err) {
      setUpdate({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // R99-C: the LAUNCH leg — shared by the one-click silent flow and the
  // wizard fallback. The invoke reply lands before the Rust exit timer
  // closes the window, so "Restarting into vX…" shows for the ~1.5s the
  // window survives. A REJECTED silent launch surfaces the wizard escape
  // hatch (offerWizard); a rejected wizard launch keeps the plain error
  // (the fallback itself failed — ACUTE.bat + the Releases page remain).
  const launchInstaller = async (path: string, silent: boolean, version: string) => {
    setInstall({ kind: "installing", version, silent });
    const invoke = tauriInvoke();
    if (invoke === null) {
      setInstall({
        kind: "error",
        message: "the desktop shell is unavailable — the installer is downloaded but must be run by hand",
        offerWizard: false,
      });
      return;
    }
    try {
      await invoke("run_update_installer", { path, silent });
      setInstall({ kind: "launched", version, silent });
    } catch (err) {
      setInstall({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
        offerWizard: silent,
      });
    }
  };

  // R91-E + R99-C: THE ONE-CLICK UPDATE — "Update now" downloads the
  // verified installer (the sidecar streams it + sha256-checks it), then
  // hands the path to the Rust shell's run_update_installer with
  // silent:true (NSIS "/S /R": the install runs with no wizard and the
  // installer template relaunches the app when it lands). Only offered
  // inside the desktop shell (a browser has no installer to run) and only
  // when the release carried a setup.exe asset. `silent:false` is the
  // legacy interactive-wizard leg the fallback button reaches — and it
  // REUSES an already-verified installer when one sits ready (the retry
  // never re-downloads 38 MB to show the same wizard).
  const updateNow = async (silent: boolean) => {
    if (update.kind !== "available") return;
    if (update.asset === undefined) {
      setInstall({
        kind: "error",
        message: "this release has no downloadable installer asset — use the Releases page",
        offerWizard: false,
      });
      return;
    }
    try {
      // The fallback-leg reuse check: a verified installer from the failed
      // silent attempt still sits at its temp path (single-flight state
      // "ready") — launch it directly instead of re-streaming it.
      const existing = await fetchUpdateDownloadProgress();
      if (
        existing.status === "ready" &&
        existing.path !== null &&
        existing.version === update.latest
      ) {
        await launchInstaller(existing.path, silent, update.latest);
        return;
      }
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
          // The shell half: validate + kill the sidecar tree + launch —
          // the app closes 1.5s later (the reply lands first so the
          // terminal line below shows).
          await launchInstaller(state.path, silent, update.latest);
          return;
        }
        if (state.status === "error") {
          setInstall({ kind: "error", message: state.error ?? "the download failed", offerWizard: false });
          return;
        }
        // idle (a fresh sidecar restarted mid-download): restart the loop's
        // expectation honestly.
        setInstall({ kind: "error", message: "the download stopped — the engine restarted; try again", offerWizard: false });
        return;
      }
    } catch (err) {
      setInstall({ kind: "error", message: err instanceof Error ? err.message : String(err), offerWizard: false });
    }
  };

  // R99-C: the byte-true percent — only when the total is known (the real
  // chunk data only; no fabricated indeterminate percentage).
  const downloadPct =
    install.kind === "downloading" && install.total > 0
      ? Math.min(100, Math.floor((install.received / install.total) * 100))
      : null;

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
            className="mt-1 text-[30px] font-black leading-none tracking-[-0.02em] tabular-nums"
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
            style={{ color: SEMANTIC_COLORS.success }}
            data-testid="update-state"
          >
            <CheckCircle2 size={13} /> Up to date — v{APP_VERSION} is the latest published release
          </span>
        ) : update.kind === "available" ? (
          <div className="flex flex-col gap-2.5" data-testid="update-state">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[11.5px] font-semibold flex items-center gap-1.5" style={{ color: styles.accent }}>
                <Download size={13} /> Update available — v{update.latest}
              </span>
              <span className="font-mono text-[11px] tabular-nums" style={{ color: styles.textTertiary }}>
                v{APP_VERSION} → v{update.latest}
              </span>
            </div>
            {/* R99-C: the RELEASE NOTES — the release body as plain text in
                the mono ladder step, collapsed to ~4 lines with an expand
                chevron; the route already capped + honestly marked it. */}
            {update.body !== "" && (
              <div
                className="rounded-[12px] border-[1.5px] overflow-hidden"
                style={{ borderColor: bdr("1.5px", styles.border), background: styles.subtle }}
              >
                <button
                  type="button"
                  onClick={() => setNotesExpanded((v) => !v)}
                  aria-expanded={notesExpanded}
                  data-testid="update-notes-toggle"
                  className="w-full h-9 px-3 flex items-center justify-between gap-2 text-[11.5px] font-bold transition-colors hover:opacity-80"
                  style={{ color: styles.textSecondary }}
                >
                  What's new
                  <ChevronDown
                    size={13}
                    className={`transition-transform duration-200 ${notesExpanded ? "rotate-180" : ""}`}
                  />
                </button>
                {/* Collapsed = ~4 lines clipped (max-h, overflow hidden —
                    no invented content); expanded = the long-list
                    discipline (max-h + scroll). */}
                <div
                  className={`px-3 pb-3 ${
                    notesExpanded ? "max-h-72 overflow-y-auto" : "max-h-[76px] overflow-hidden"
                  }`}
                  data-testid="update-notes-body"
                >
                  <div
                    className="font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words"
                    style={{ color: styles.textSecondary }}
                  >
                    {update.body}
                  </div>
                </div>
              </div>
            )}
            {/* R91-E + R99-C: the in-app action — the ONE-CLICK silent flow
                (the desktop shell only; web dev shows the Releases line
                instead). */}
            {isTauri() ? (
              install.kind === "idle" ? (
                <button
                  type="button"
                  onClick={() => void updateNow(true)}
                  disabled={update.asset === undefined}
                  title={
                    update.asset === undefined
                      ? "This release has no installer asset — use the Releases page"
                      : "Downloads the verified installer and installs it silently — the app restarts itself when it's ready"
                  }
                  className="h-9 px-4 rounded-full text-[11.5px] font-bold transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100 inline-flex items-center gap-1.5 self-start"
                  style={{ background: styles.accent, color: styles.accentText }}
                  data-testid="update-now-button"
                >
                  <PackageOpen size={13} /> Update now
                </button>
              ) : install.kind === "downloading" ? (
                <div className="flex items-center gap-3 max-w-[420px]" data-testid="update-progress">
                  {/* Byte-true bar — only when the total is known; the width
                      is ALWAYS the real received/total ratio (never a fake
                      indeterminate percentage). */}
                  {install.total > 0 && (
                    <div
                      className="flex-1 h-1.5 rounded-full overflow-hidden"
                      style={{ background: styles.isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)" }}
                    >
                      <div
                        className="h-full rounded-full transition-[width] duration-300"
                        style={{
                          width: `${Math.min(100, (install.received / install.total) * 100)}%`,
                          background: styles.accent,
                        }}
                      />
                    </div>
                  )}
                  <span
                    className="font-mono text-[10.5px] shrink-0 tabular-nums"
                    style={{ color: styles.textTertiary }}
                  >
                    Downloading — {fmtMB(install.received)}
                    {install.total > 0 ? ` of ${fmtMB(install.total)} · ${downloadPct}%` : ""}
                  </span>
                </div>
              ) : install.kind === "verifying" ? (
                <span className="text-[11.5px] font-semibold" style={{ color: styles.textSecondary }} data-testid="update-verifying">
                  Verifying the installer's checksum…
                </span>
              ) : install.kind === "installing" ? (
                <span className="text-[11.5px] font-semibold" style={{ color: styles.textSecondary }} data-testid="update-installing">
                  {install.silent
                    ? "Installing — the app restarts itself when ready"
                    : "Launching the setup wizard — it closes this app and takes over"}
                </span>
              ) : install.kind === "launched" ? (
                <span
                  className="text-[11.5px] font-semibold"
                  style={{ color: SEMANTIC_COLORS.success }}
                  data-testid="update-launched"
                >
                  {install.silent
                    ? `Restarting into v${install.version} — your data is kept.`
                    : `Installer launched — the setup wizard will close this app and install v${install.version}. Your data is kept.`}
                </span>
              ) : (
                <div className="flex flex-col gap-2">
                  <span
                    className="text-[11.5px]"
                    style={{ color: SEMANTIC_COLORS.danger }}
                    role="alert"
                    data-testid="update-flow-error"
                  >
                    The in-app update failed ({install.message}). The launcher's ACUTE.bat update still works, and the
                    Releases page always has the latest.
                  </span>
                  {/* R99-C: THE ESCAPE HATCH — the silent launch rejected, so
                      the legacy INTERACTIVE wizard stays one click away
                      (it reuses the already-verified installer when one
                      sits ready — no redundant re-download). */}
                  {install.offerWizard && (
                    <button
                      type="button"
                      onClick={() => void updateNow(false)}
                      title="Runs the downloaded installer with the interactive setup wizard — the pre-R99 flow, for machines where the silent install refuses"
                      className="h-9 px-4 rounded-full text-[11.5px] font-bold border-[1.5px] transition-all hover:scale-[1.02] active:scale-95 self-start"
                      style={{ borderColor: withAlpha(styles.accent, 0.5), color: styles.accent }}
                      data-testid="update-wizard-fallback"
                    >
                      Run the setup wizard manually
                    </button>
                  )}
                </div>
              )
            ) : (
              <span className="text-[11.5px]" style={{ color: styles.textSecondary }}>
                Web mode — use ACUTE.bat or the Releases page to install v{update.latest}.
              </span>
            )}
          </div>
        ) : update.kind === "error" ? (
          <span className="text-[11.5px]" style={{ color: SEMANTIC_COLORS.danger }} data-testid="update-state">
            Could not check for updates ({update.message}) — the Releases page always has the latest.
          </span>
        ) : null}
      </div>
      {/* R99-C: the auto-check toggle — the startup check's persisted gate
          (default ON). The quiet-row grammar: plain label + the shared
          contrast-aware switch, one hairline separator above. */}
      <div
        className="mt-4 pt-3 border-t-[1.5px] flex items-center justify-between gap-4"
        style={{ borderColor: bdr("1.5px", styles.border) }}
      >
        <span className="text-[11.5px]" style={{ color: styles.textSecondary }}>
          Check for updates automatically
        </span>
        <ToggleSwitch
          checked={autoCheck}
          onToggle={() => setAutoCheck(!autoCheck)}
          label="Check for updates automatically"
          title="A silent check once a day at app start — a pending update shows as a dot on Settings and one toast; failures are never surfaced"
          testId="update-auto-check"
        />
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
        borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.5),
        background: withAlpha(SEMANTIC_COLORS.danger, styles.isDark ? 0.06 : 0.03),
      }}
      aria-label="Reset application"
    >
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlert size={13} style={{ color: SEMANTIC_COLORS.danger }} />
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: SEMANTIC_COLORS.danger }}>
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
            borderColor: armed ? withAlpha(SEMANTIC_COLORS.danger, 0.7) : bdr("1.5px", styles.border),
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
          style={{ background: SEMANTIC_COLORS.danger, color: "#fff" }}
          data-testid="reset-confirm-button"
        >
          {resetting ? "Resetting…" : "Reset everything"}
        </button>
      </div>
      {error !== null ? (
        <p className="mt-2 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
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
