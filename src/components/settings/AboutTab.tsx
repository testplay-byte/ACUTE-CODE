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
 *
 * ROUND-104 (R104): THE TWO-STAGE HAND-SHAKE (owner: "I want the ability
 * to download it then confirm to update it, or click the update button in
 * the About section to update it" — the v0.100.0 report retired the
 * one-click auto-install):
 *  · STAGE 1 — "Download update" streams the release's updater asset (the
 *    sidecar picks THIS machine's own — the setup.exe on Windows, the
 *    arch-matched AppImage on Linux, with the asset's kind + real
 *    filename riding the check) with byte-true progress + the sha256
 *    verify, then STOPS at "ready". Nothing installs after a download.
 *  · STAGE 2 — the STAGED row ("Downloaded and verified — vX is ready to
 *    install" + "Restart and update now") is the explicit confirmation:
 *    only that button launches the install (the R99-C silent flow —
 *    NSIS /S /R on Windows, the AppImage replace on Linux). A quiet
 *    "Discard download" walks the staged file back (sidecar DELETE).
 *  · MOUNT-RESUME: the sidecar's single-flight ready state outlives the
 *    About tab — on mount the card re-adopts a staged (or in-flight)
 *    download, so "come back later and click the update button" works
 *    without a fresh check. A staged version the app already moved past
 *    self-heals away (discarded silently, the pendingVersion pattern).
 *  · THE HONEST FALLBACK: if the silent launch REJECTS, the error renders
 *    with a secondary "Run the setup wizard manually" button ONLY when
 *    the staged asset is a Windows setup (there is no wizard for an
 *    AppImage) — it re-runs the flow with silent:false, the legacy
 *    interactive wizard kept for pathological Windows machines, and it
 *    REUSES the already-verified installer (no redundant re-download).
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
import { useEffect, useMemo, useState } from "react";
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
import { useConfigStore } from "../../lib/config-store";
import { retryConnection } from "../../lib/sidecar-connection";
// R99-A: the ONE sanctioned link router — the Releases link opens in the
// app's OWN browser panel by default; the external affordance beside it is
// the deliberate escape hatch to the device's browser.
import { openLink } from "../../lib/open-link";
import {
  discardUpdateDownload,
  fetchSystemUpdates,
  fetchUpdateDownloadProgress,
  resetApplication,
  startUpdateDownload,
  type SystemUpdateCheck,
} from "../../lib/api";
// R99-C: the auto-check toggle + the badge sync (one store, two surfaces).
// R104: isNewerVersion also gates the mount-resume adoption + the stale
// staged-download self-heal below.
import {
  isNewerVersion,
  syncPendingVersionFromResult,
  useUpdateCheckerStore,
} from "../../lib/update-checker";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { ToggleSwitch } from "../ui/toggle-switch";
// R100-E2: the round-100 primitives (USAGE.md §3).
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
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

/** R91-E + R99-C + R104: the IN-APP UPDATE flow's UI state (on top of
 * UpdateState's check results). R104 split the old one-click sequence at
 * the owner's directive ("the ability to download it then confirm to
 * update it"): downloading → byte-true progress; verifying → the sha256
 * check; READY → the download is verified and STAGED — the flow STOPS
 * here and waits for the owner's explicit confirmation (the "Restart and
 * update now" button, or a later visit: the mount-resume poll below
 * re-adopts a staged download); installing → the (silent or wizard)
 * launch invoke is in flight (the Rust pre-install kill can hold this
 * state for seconds — honest); launched → the installer took over and the
 * Rust exit timer owns the rest. error carries offerWizard when the
 * SILENT launch leg rejected AND the staged asset is a Windows setup
 * (R104: there is no interactive wizard for an AppImage — the Linux
 * replace leg IS the install) — the legacy interactive wizard stays one
 * click away on Windows (the escape hatch). */
type InstallState =
  | { kind: "idle" }
  | { kind: "downloading"; received: number; total: number }
  | { kind: "verifying" }
  | { kind: "ready"; path: string; version: string }
  | { kind: "installing"; version: string; silent: boolean }
  | { kind: "launched"; version: string; silent: boolean }
  | { kind: "error"; message: string; offerWizard: boolean };

/** R104: which updater asset a STAGED file is, from its extension — the
 * same thing the Rust side dispatches on (run_update_installer: .exe →
 * the Windows NSIS legs, .AppImage → the Linux replace). The frontend
 * uses it to offer the interactive-wizard escape hatch ONLY where one
 * exists. */
function stagedAssetKind(path: string): "windows-setup" | "linux-appimage" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".exe")) return "windows-setup";
  if (lower.endsWith(".appimage")) return "linux-appimage";
  return null;
}

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

/** R104: the STAGED-DOWNLOAD row — the second half of the update
 * hand-shake. Rendered inside the available-update card AND standalone
 * (a staged download outlives the check that announced it — the
 * mount-resume poll adopts it, so the owner can confirm the install any
 * time from the About section). The install happens ONLY through the
 * button: nothing auto-installs after a download. */
function StagedDownloadRow({
  version,
  onInstall,
  onDiscard,
}: {
  version: string;
  onInstall: () => void;
  onDiscard: () => void;
}) {
  const styles = useThemeStyles();
  return (
    <div className="flex flex-col gap-2" data-testid="update-staged">
      <span
        className="text-[11px] font-medium flex items-center gap-1.5"
        style={{ color: SEMANTIC_COLORS.success }}
      >
        <CheckCircle2 size={13} /> Downloaded and verified — v{version} is ready to install
      </span>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={onInstall}
          title="Installs the verified update and restarts the app — your data is kept; nothing happens until you click this"
          className="h-9 px-4 rounded-full text-[11px] font-semibold transition-all active:scale-95 inline-flex items-center gap-1.5 self-start"
          style={{ background: styles.accent, color: styles.accentText }}
          data-testid="update-install-button"
        >
          <PackageOpen size={13} /> Restart and update now
        </button>
        {/* The walk-back: the staged file is unlinked and the card returns
            to idle — a later Download starts clean. */}
        <button
          type="button"
          onClick={onDiscard}
          title="Deletes the downloaded update file and returns to idle — nothing is installed"
          className="h-9 px-4 rounded-full text-[11px] font-semibold border-[1.5px] transition-all active:scale-95 self-start"
          style={{ borderColor: bdr("1.5px", styles.border), color: styles.textSecondary }}
          data-testid="update-discard-button"
        >
          Discard download
        </button>
      </div>
      <span className="text-[11px]" style={{ color: styles.textTertiary }}>
        The update installs only when you confirm it — nothing happens until then. Your data is kept.
      </span>
    </div>
  );
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

  // R104: THE MOUNT-RESUME — a staged download outlives the About tab (and
  // the check that announced it): the sidecar's single-flight state keeps
  // the verified file + its version until it is installed, discarded, or
  // the engine restarts. On mount (desktop only) the card re-adopts it so
  // the owner's "click the update button in the About section to update
  // it" works days later without a fresh check:
  //  · ready + NEWER than APP_VERSION → the staged row renders (install
  //    button + discard);
  //  · ready + NOT newer (the app moved past it through any path) → the
  //    staged file is DISCARDED silently (the same self-heal the
  //    pendingVersion badge rides — a download's purpose must not outlive
  //    its release);
  //  · downloading/verifying (a download another surface started this
  //    engine session) → the card re-attaches to the live progress.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const adopt = async () => {
      try {
        for (;;) {
          const state = await fetchUpdateDownloadProgress();
          if (cancelled) return;
          if (state.status === "idle" || state.status === "error") return;
          if (state.status === "downloading") {
            setInstall({ kind: "downloading", received: state.received, total: state.total });
            await new Promise((r) => setTimeout(r, 700));
            continue;
          }
          if (state.status === "verifying") {
            setInstall({ kind: "verifying" });
            await new Promise((r) => setTimeout(r, 700));
            continue;
          }
          if (state.status === "ready" && state.path !== null && state.version !== null) {
            if (isNewerVersion(state.version, APP_VERSION)) {
              setInstall({ kind: "ready", path: state.path, version: state.version });
            } else {
              void discardUpdateDownload().catch(() => {});
            }
            return;
          }
          return;
        }
      } catch {
        // The sidecar is not reachable (yet) — the manual Check button
        // still works; adopting is a convenience, never a gate.
      }
    };
    void adopt();
    return () => {
      cancelled = true;
    };
  }, []);

  // R89-A2: the check runs SERVER-SIDE (GET /system/updates — the sidecar
  // reads the launcher's ~/.acute/github.pat; the repo is PRIVATE so the
  // old anonymous webview fetch to api.github.com answered 404, the owner's
  // verdict). The version comparison is the same tuple walk as before.
  // R99-C: every manual answer ALSO refreshes the sidebar's pending-update
  // dot (syncPendingVersionFromResult — the same sync the scheduled
  // startup check rides, so the badge can never disagree with the button).
  // R104: a STAGED download survives a re-check when it is for the same
  // version (the download-then-come-back flow); an answer that moved past
  // it retires the staged file honestly (the staleness sweep below).
  const checkForUpdates = async () => {
    setUpdate({ kind: "checking" });
    // A staged download is KEEPABLE — only the non-ready states reset here;
    // the answer below decides whether the staged version went stale.
    if (install.kind !== "ready") setInstall({ kind: "idle" });
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
      // R104: the staleness sweep — an answer that says "no update" (the
      // app is at/after the latest) or announces a DIFFERENT version than
      // the staged one retires the staged file: its release either never
      // mattered or was superseded. Discarded best-effort (a dead sidecar
      // owns no staged file anyway).
      if (install.kind === "ready") {
        const stale = result.updateAvailable !== true || result.latest !== install.version;
        if (stale) {
          setInstall({ kind: "idle" });
          void discardUpdateDownload().catch(() => {});
        }
      }
    } catch (err) {
      setUpdate({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // R99-C: the LAUNCH leg — reached ONLY through the owner's explicit
  // confirmation now (the "Restart and update now" button; the wizard
  // fallback reuses it with silent:false on Windows). The invoke reply
  // lands before the Rust exit timer closes the window, so "Restarting
  // into vX…" shows for the ~1.5s the window survives. A REJECTED launch
  // surfaces the wizard escape hatch ONLY when the staged asset is a
  // Windows setup (R104: an AppImage has no interactive wizard to fall
  // back to — the replace leg IS the install); a rejected wizard launch
  // keeps the plain error (the fallback itself failed — ACUTE.bat + the
  // Releases page remain).
  //
  // ROUND-101 (R101-B): the flag + the recovery. `updateInFlight` is set
  // BEFORE the invoke — the Rust side kills the sidecar tree inside that
  // call, and the ConnectionGate swaps the whole UI to the calm Restarting
  // splash the moment the flag flips (no watchdog offline flip, no query
  // error flash — the v0.98.0 "environment crashed" report). If the invoke
  // REJECTS, the app lives on with a DEAD engine — the recovery clears the
  // flag and auto-restarts the backend (retryConnection), so the owner is
  // never stranded on the offline screen with a manual Restart chore.
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
    useConfigStore.getState().setUpdateInFlight({ version });
    // R118-F (round-118 §1 item 50): the update-restart marker — written
    // BESIDE the in-flight flag, BEFORE the invoke. The flag deliberately
    // dies with this process (the NSIS /S install runs UI-less for 10-40s
    // while the window is gone), so the RELAUNCH had nothing to say beyond
    // the generic "Connecting…" splash. The marker bridges the dark: the
    // fresh process's ConnectionGate reads it at mount and renders
    // "Setting up v{VERSION}… — finishing the update — your data is kept"
    // until the sidecar connects, then clears it (one-shot; validated
    // against APP_VERSION + a 10-minute age there). Same key + shape as
    // ConnectionGate's reader: "acute-code.update-restart" =
    // {version, at}. A rejected launch removes it with the flag below.
    try {
      window.localStorage.setItem(
        "acute-code.update-restart",
        JSON.stringify({ version, at: Date.now() }),
      );
    } catch {
      // A refusing storage quota never blocks the install itself.
    }
    try {
      await invoke("run_update_installer", { path, silent });
      setInstall({ kind: "launched", version, silent });
    } catch (err) {
      // The engine died for nothing — bring it back before anything else.
      useConfigStore.getState().setUpdateInFlight(null);
      try {
        window.localStorage.removeItem("acute-code.update-restart");
      } catch {
        /* best-effort — a stale marker is validated away at relaunch anyway */
      }
      void retryConnection().catch(() => {});
      setInstall({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
        offerWizard: silent && stagedAssetKind(path) === "windows-setup",
      });
    }
  };

  // R104: STAGE 1 — THE DOWNLOAD. Streams the release's updater asset
  // (the sidecar picks the platform's own — setup.exe on Windows, the
  // arch-matched AppImage on Linux) with byte-true progress and the sha256
  // verify, then STOPS at "ready": the install waits for the owner's
  // explicit confirmation. The reuse check adopts an already-verified
  // download for the same version (no re-download); any settled-but-stale
  // state is discarded first so the new download starts clean.
  const downloadUpdate = async () => {
    if (update.kind !== "available") return;
    if (update.asset === undefined) {
      setInstall({
        kind: "error",
        message: "this release has no downloadable updater asset for this platform — use the Releases page",
        offerWizard: false,
      });
      return;
    }
    try {
      const existing = await fetchUpdateDownloadProgress();
      if (
        existing.status === "ready" &&
        existing.path !== null &&
        existing.version === update.latest
      ) {
        setInstall({ kind: "ready", path: existing.path, version: existing.version });
        return;
      }
      if (existing.status === "ready" || existing.status === "error") {
        // A staged download for a DIFFERENT version (or a dead error state)
        // — clear it so this download starts clean.
        await discardUpdateDownload();
      }
      await startUpdateDownload({
        url: update.asset.url,
        digest: update.asset.digest,
        version: update.latest,
        // R104: the REAL asset filename — the staged file keeps GitHub's
        // extension (setup.exe / AppImage) so the install leg dispatches
        // on what GitHub named.
        name: update.asset.name,
      });
      setInstall({ kind: "downloading", received: 0, total: update.asset.size });
      // Poll the live state until it settles. R104: "ready" STOPS the flow
      // — the confirmation button owns the install from here.
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
          setInstall({
            kind: "ready",
            path: state.path,
            version: state.version ?? update.latest,
          });
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

  // R104: STAGE 2 — THE CONFIRMED INSTALL. Requires a VERIFIED staged
  // download (from this card's state, or re-read from the sidecar when the
  // confirm outlived a remount), then hands the path to the Rust shell's
  // run_update_installer (silent:true — NSIS "/S /R" on Windows, the
  // AppImage replace on Linux; the wizard fallback reaches this same leg
  // with silent:false on Windows only).
  const installUpdate = async (silent: boolean) => {
    let path: string | null = null;
    let version: string | null = null;
    if (install.kind === "ready") {
      path = install.path;
      version = install.version;
    } else {
      // The belt: re-read the live state (the mounted staged row may have
      // come from the mount-resume adoption, whose state lives in the
      // sidecar, not this closure).
      try {
        const state = await fetchUpdateDownloadProgress();
        if (state.status === "ready" && state.path !== null && state.version !== null) {
          path = state.path;
          version = state.version;
        }
      } catch {
        // fall through to the honest error below
      }
    }
    if (path === null || version === null) {
      setInstall({
        kind: "error",
        message: "no verified download is staged — download the update first",
        offerWizard: false,
      });
      return;
    }
    await launchInstaller(path, silent, version);
  };

  // R104: the staged download's walk-back — Discard unlinks the verified
  // file (sidecar DELETE) and returns the card to idle. The button only
  // renders in the ready state, so the route's in-flight refusal (409)
  // cannot fire from here; a dead-sidecar failure still resets the card
  // truthfully (a restarted engine owns no staged file).
  const discardStagedDownload = async () => {
    try {
      await discardUpdateDownload();
    } catch {
      // honest no-op — the state reset below is the truthful UI answer
    }
    setInstall({ kind: "idle" });
  };

  // R99-C: the byte-true percent — only when the total is known (the real
  // chunk data only; no fabricated indeterminate percentage).
  const downloadPct =
    install.kind === "downloading" && install.total > 0
      ? Math.min(100, Math.floor((install.received / install.total) * 100))
      : null;

  return (
    /* R100-E2: the SectionCard primitive (rounded-2xl / 1.5px border-line /
       bg-card / softShadow — the card's pre-sweep spelling, now shared). */
    <SectionCard ariaLabel="Version" shadow>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <Kicker>Version</Kicker>
          {/* R100-E2: the version display snapped 30px/font-black → the
              ladder's VALUE tier (22px/600, tabular-nums — TOKENS.md §2). */}
          <div
            className="mt-1 text-[22px] font-semibold leading-none tabular-nums"
            style={{ color: styles.text }}
          >
            v{APP_VERSION}
          </div>
          <div className="mt-1.5 text-[11px]" style={{ color: styles.textSecondary }}>
            {APP_NAME} · local-first multi-agent workbench
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void checkForUpdates()}
            disabled={update.kind === "checking"}
            className="h-9 px-4 rounded-full text-[11px] font-semibold border-[1.5px] transition-all active:scale-95 disabled:opacity-60"
            style={{ borderColor: withAlpha(styles.accent, 0.5), color: styles.accent }}
          >
            {update.kind === "checking" ? "Checking…" : "Check for updates"}
          </button>
          <button
            type="button"
            onClick={() => void openReleasesPage(false)}
            title="The releases page — opens in ACUTE-CODE's built-in browser (your device's browser when no project is open)"
            className="h-9 px-3.5 rounded-full text-[11px] font-semibold border-[1.5px] flex items-center gap-1.5 transition-colors hover:opacity-80"
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
      <div className="mt-3 min-h-5">
        {update.kind === "current" ? (
          <span
            className="text-[11px] font-medium flex items-center gap-1.5"
            style={{ color: SEMANTIC_COLORS.success }}
            data-testid="update-state"
          >
            <CheckCircle2 size={13} /> Up to date — v{APP_VERSION} is the latest published release
          </span>
        ) : update.kind === "available" ? (
          <div className="flex flex-col gap-2.5" data-testid="update-state">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[11px] font-medium flex items-center gap-1.5" style={{ color: styles.accent }}>
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
                className="rounded-xl border-[1.5px] overflow-hidden"
                style={{ borderColor: bdr("1.5px", styles.border), background: styles.subtle }}
              >
                <button
                  type="button"
                  onClick={() => setNotesExpanded((v) => !v)}
                  aria-expanded={notesExpanded}
                  data-testid="update-notes-toggle"
                  className="w-full h-9 px-3 flex items-center justify-between gap-2 text-[11px] font-semibold transition-colors hover:opacity-80"
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
                    notesExpanded ? "max-h-72 overflow-y-auto" : "max-h-19 overflow-hidden"
                  }`}
                  data-testid="update-notes-body"
                >
                  <div
                    className="font-mono text-[12px] leading-normal whitespace-pre-wrap break-words"
                    style={{ color: styles.textSecondary }}
                  >
                    {update.body}
                  </div>
                </div>
              </div>
            )}
            {/* R91-E + R99-C + R104: the in-app action — the TWO-STAGE
                hand-shake (the desktop shell only; web dev shows the
                Releases line instead). Stage 1 downloads + verifies and
                STOPS; stage 2 (the ready row) installs ONLY on the owner's
                confirmation. The INSTALL-phase states (installing /
                launched / error) render in the SHARED block below the
                update-state line — a mount-resumed confirm has no
                available-update card to render inside. */}
            {isTauri() ? (
              install.kind === "idle" ? (
                <button
                  type="button"
                  onClick={() => void downloadUpdate()}
                  disabled={update.asset === undefined}
                  title={
                    update.asset === undefined
                      ? "This release has no updater asset for this platform — use the Releases page"
                      : "Downloads the update and verifies its checksum — installing waits for your confirmation"
                  }
                  className="h-9 px-4 rounded-full text-[11px] font-semibold transition-all active:scale-95 disabled:opacity-50 inline-flex items-center gap-1.5 self-start"
                  style={{ background: styles.accent, color: styles.accentText }}
                  data-testid="update-download-button"
                >
                  <Download size={13} /> Download update
                </button>
              ) : install.kind === "downloading" ? (
                <div className="flex items-center gap-3 max-w-[420px]" data-testid="update-progress">
                  {/* Byte-true bar — only when the total is known; the width
                      is ALWAYS the real received/total ratio (never a fake
                      indeterminate percentage). */}
                  {install.total > 0 && (
                    <div
                      className="flex-1 h-1.5 rounded-full overflow-hidden"
                      style={{ background: withAlpha(styles.text, styles.isDark ? 0.08 : 0.06) }}
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
                    className="font-mono text-[11px] shrink-0 tabular-nums"
                    style={{ color: styles.textTertiary }}
                  >
                    Downloading — {fmtMB(install.received)}
                    {install.total > 0 ? ` of ${fmtMB(install.total)} · ${downloadPct}%` : ""}
                  </span>
                </div>
              ) : install.kind === "verifying" ? (
                <span className="text-[11px] font-medium" style={{ color: styles.textSecondary }} data-testid="update-verifying">
                  Verifying the update's checksum…
                </span>
              ) : install.kind === "ready" ? (
                /* R104: STAGE 2 — the verified download sits staged and the
                   flow STOPS here: the install happens ONLY when the owner
                   clicks "Restart and update now" (the confirmation the
                   v0.100.0 report asked for). Shared with the standalone
                   staged row below. */
                <StagedDownloadRow
                  version={install.version}
                  onInstall={() => void installUpdate(true)}
                  onDiscard={() => void discardStagedDownload()}
                />
              ) : null
            ) : (
              <span className="text-[11px]" style={{ color: styles.textSecondary }}>
                Web mode — use the Releases page to install v{update.latest}.
              </span>
            )}
          </div>
        ) : update.kind === "error" ? (
          <span className="text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} data-testid="update-state">
            Could not check for updates ({update.message}) — the Releases page always has the latest.
          </span>
        ) : null}
        {/* R104: the INSTALL-PHASE states, SHARED by both entry paths — the
            available-update card's own confirm AND the mount-resumed
            standalone staged row (which has no available card to render
            inside; without this block a mount-resumed install would show
            NOTHING between the click and the Restarting splash). */}
        {isTauri() &&
        (install.kind === "installing" || install.kind === "launched" || install.kind === "error") ? (
          <div className={update.kind === "available" ? "" : "mt-2.5"}>
            {install.kind === "installing" ? (
              <span className="text-[11px] font-medium" style={{ color: styles.textSecondary }} data-testid="update-installing">
                {install.silent
                  ? "Installing — the app restarts itself when ready"
                  : "Launching the setup wizard — it closes this app and takes over"}
              </span>
            ) : install.kind === "launched" ? (
              <span
                className="text-[11px] font-semibold"
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
                  className="text-[11px]"
                  style={{ color: SEMANTIC_COLORS.danger }}
                  role="alert"
                  data-testid="update-flow-error"
                >
                  The in-app update failed ({install.message}). The
                  Releases page always has the latest.
                </span>
                {/* R99-C: THE ESCAPE HATCH — the silent launch rejected on a
                    WINDOWS setup, so the legacy INTERACTIVE wizard stays one
                    click away (R104: installUpdate re-reads the staged
                    download — it reuses the already-verified installer, no
                    redundant re-download; an AppImage rejection offers no
                    wizard because there is none). */}
                {install.offerWizard && (
                  <button
                    type="button"
                    onClick={() => void installUpdate(false)}
                    title="Runs the downloaded installer with the interactive setup wizard — the pre-R99 flow, for machines where the silent install refuses"
                    className="h-9 px-4 rounded-full text-[11px] font-semibold border-[1.5px] transition-all active:scale-95 self-start"
                    style={{ borderColor: withAlpha(styles.accent, 0.5), color: styles.accent }}
                    data-testid="update-wizard-fallback"
                  >
                    Run the setup wizard manually
                  </button>
                )}
              </div>
            )}
          </div>
        ) : null}
        {/* R104: the STAGED DOWNLOAD outlives the check that announced it —
            the mount-resume poll adopts the sidecar's verified ready state,
            so the owner can come back to the About section ANY time and
            click the update button without checking first. Rendered
            standalone whenever no available-update card owns the surface. */}
        {update.kind !== "available" && isTauri() && install.kind === "ready" ? (
          <div className="mt-2.5">
            <StagedDownloadRow
              version={install.version}
              onInstall={() => void installUpdate(true)}
              onDiscard={() => void discardStagedDownload()}
            />
          </div>
        ) : null}
      </div>
      {/* R99-C: the auto-check toggle — the startup check's persisted gate
          (default ON). The quiet-row grammar: plain label + the shared
          contrast-aware switch, one hairline separator above. */}
      <div
        className="mt-4 pt-3 border-t-[1.5px] flex items-center justify-between gap-4"
        style={{ borderColor: bdr("1.5px", styles.border) }}
      >
        <span className="text-[11px]" style={{ color: styles.textSecondary }}>
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
    </SectionCard>
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
        // R100-A: the honest engine line — the owner asked what browser the
        // panel runs; the answer is platform-explicit and de-brand-honest.
        ["Engine", "local sidecar (agent-core) + the OS webview shell — Windows: WebView2 (Chromium, ACUTE-branded UA) · Linux: WebKitGTK"],
        ["Storage", "SQLite + OS secure key store — everything stays on this PC"],
      ] as Array<[string, string]>,
    [],
  );
  return (
    /* R100-E2: the SectionCard primitive. */
    <SectionCard ariaLabel="About" shadow>
      <div className="flex items-center gap-2 mb-3">
        <Info size={13} style={{ color: styles.accent }} />
        <Kicker>About</Kicker>
      </div>
      <dl className="flex flex-col gap-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 min-w-0">
            <dt className="text-[11px] shrink-0" style={{ color: styles.textTertiary }}>
              {label}
            </dt>
            <dd className="text-[11px] font-medium text-right min-w-0 break-words" style={{ color: styles.text }}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </SectionCard>
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
    /* R100-E2: the DANGER-zone card keeps its custom danger border + wash
       (the danger-zone grammar stays; research §C2 P1) — only the radius
       snapped rounded-2xl and the type to the ladder. */
    <section
      className="rounded-2xl border-[1.5px] p-5"
      style={{
        borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.5),
        background: withAlpha(SEMANTIC_COLORS.danger, styles.isDark ? 0.06 : 0.03),
      }}
      aria-label="Reset application"
    >
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlert size={13} style={{ color: SEMANTIC_COLORS.danger }} />
        {/* R100-E2: the kicker spelling (11px/500/[0.08em]) with the danger
            ink — the Kicker tier, the one sanctioned weight. */}
        <span
          className="text-[11px] font-medium uppercase tracking-[0.08em]"
          style={{ color: SEMANTIC_COLORS.danger }}
        >
          Danger zone
        </span>
      </div>
      <h3 className="text-[13px] font-semibold mb-1" style={{ color: styles.text }}>
        Reset the entire application
      </h3>
      <p className="text-[11px] leading-relaxed mb-3" style={{ color: styles.textSecondary }}>
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
          className="h-9 w-[200px] rounded-full border-[1.5px] px-4 text-[11px] outline-none"
          style={{
            borderColor: armed ? withAlpha(SEMANTIC_COLORS.danger, 0.7) : bdr("1.5px", styles.border),
            background: withAlpha(styles.text, styles.isDark ? 0.3 : 0.03),
            color: styles.text,
          }}
          aria-label="Type RESET to confirm the application reset"
          data-testid="reset-confirm-input"
        />
        <button
          type="button"
          onClick={() => void runReset()}
          disabled={!armed || resetting}
          className="h-9 px-4 rounded-full text-[11px] font-semibold transition-all active:scale-95 disabled:opacity-40"
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
      {/* R100-E2: the tab-intro header snapped to the E1 grammar — Kicker
          (the nav group) + 13px/600 title + 12px secondary description. */}
      <div className="pb-1">
        <Kicker className="mb-1">System</Kicker>
        <h2 className="text-[13px] font-semibold text-ink">About</h2>
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
