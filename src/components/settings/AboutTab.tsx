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
 *    open), and the releases deep link.
 *  · ABOUT — what the app is + the delivery phase.
 *  · RESET (danger zone) — type RESET to arm the button, then the full
 *    journey back to first-run: purge Credential Manager (Tauri) →
 *    POST /system/reset (wipes every table + reseeds factory state +
 *    purges the ~/.acute machine files) → clear the webview's
 *    localStorage stores + react-query cache → reload to onboarding.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, ExternalLink, Info, ShieldAlert } from "lucide-react";
import { APP_NAME, APP_VERSION, PHASE } from "../../lib/version";
import { isTauri } from "../../lib/sidecar";
import { fetchSystemUpdates, resetApplication, type SystemUpdateCheck } from "../../lib/api";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { bdr, withAlpha } from "../dashboard/helpers";

const RELEASES_URL = "https://github.com/testplay-byte/ACUTE-CODE/releases";

/** R89-A3: the Releases link must reach the OS browser. Inside Tauri a
 * plain <a target="_blank"> is silently swallowed by WebView2 (wry) — the
 * R58-b Rust command `open_external_url` (tauri-plugin-shell's OS-level
 * open, http/https validated in Rust) is the sanctioned handoff; the web
 * dev server falls back to window.open. */
async function openReleasesPage(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const tauri = (window as { __TAURI__?: { core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } } })
        .__TAURI__;
      if (tauri !== undefined) {
        await tauri.core.invoke("open_external_url", { url });
        return;
      }
    } catch (err) {
      console.error("[about] open_external_url failed:", err);
    }
  }
  window.open(url, "_blank", "noreferrer");
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
  | { kind: "available"; latest: string }
  | { kind: "error"; message: string };

function VersionCard() {
  const styles = useThemeStyles();
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });

  // R89-A2: the check runs SERVER-SIDE (GET /system/updates — the sidecar
  // reads the launcher's ~/.acute/github.pat; the repo is PRIVATE so the
  // old anonymous webview fetch to api.github.com answered 404, the owner's
  // verdict). The version comparison is the same tuple walk as before.
  const checkForUpdates = async () => {
    setUpdate({ kind: "checking" });
    try {
      const result: SystemUpdateCheck = await fetchSystemUpdates();
      if (!result.ok) {
        throw new Error(result.error ?? result.reason ?? "the update check failed");
      }
      const latest = result.latest ?? "";
      if (latest === "") throw new Error("no published release found");
      setUpdate(result.updateAvailable ? { kind: "available", latest } : { kind: "current", latest });
    } catch (err) {
      setUpdate({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
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
            onClick={() => void openReleasesPage(RELEASES_URL)}
            className="h-9 px-3.5 rounded-full text-[11.5px] font-bold border-[1.5px] flex items-center gap-1.5 transition-colors hover:opacity-80"
            style={{ borderColor: bdr("1.5px", styles.border), color: styles.textSecondary }}
            aria-label="Open the releases page in your browser"
          >
            Releases
            <ExternalLink size={11} />
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
          <span
            className="text-[11.5px] font-semibold flex items-center gap-1.5"
            style={{ color: styles.accent }}
            data-testid="update-state"
          >
            <Download size={13} /> Update available — v{update.latest} is published. The launcher installs
            it on the next run (or download it from Releases).
          </span>
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
