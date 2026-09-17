import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Loader2, RotateCcw, ScrollText, Unplug } from "lucide-react";
import { useConfigStore, type UpdateInFlight } from "../../lib/config-store";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { beginSidecarConnect, retryConnection } from "../../lib/sidecar-connection";
import { getSidecarLogTail, isTauri, type SidecarLogTail } from "../../lib/sidecar";
import { AcuteLogo } from "./Sidebar";

/**
 * ROUND-53 (R53): the connection gate.
 *
 * The packaged app's webview used to fire every query the instant it booted —
 * against a PREVIOUS session's persisted port (the sidecar binds an ephemeral
 * port per launch) while the shell handshake was still running. This gate
 * delays the entire app tree until the sidecar endpoint is adopted, replacing
 * the old behavior where broken queries produced "Could not reach agent-core
 * (TypeError: Failed to fetch)" from every screen.
 *
 *   connecting → branded splash (no routes mount, no queries fire)
 *   offline    → the shell-reported sidecar error + Retry (restart_sidecar)
 *   connected  → children render
 *
 * Browser dev passes straight through (no __TAURI__): identical to pre-R53.
 *
 * ROUND-101 (R101-B): while `updateInFlight` is set, the gate renders the
 * calm RESTARTING splash instead of the app tree — an update install has
 * begun, the sidecar was killed on purpose, and the window exits seconds
 * after the installer launches. Unmounting the children also cancels every
 * in-flight query, so no error banner can flash during the hand-off (the
 * v0.98.0 report: the offline screen read as "the environment crashed").
 * The `update-installing` Tauri event (emitted by run_update_installer
 * BEFORE the pre-install kill) is the belt-and-suspenders leg — any future
 * entry point that launches the installer gets the same calm treatment even
 * if it forgot to set the flag itself.
 */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const connection = useConfigStore((s) => s.connection);
  const connectionError = useConfigStore((s) => s.connectionError);
  const updateInFlight = useConfigStore((s) => s.updateInFlight);
  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    beginSidecarConnect();
    // R101-B: the shell's own announcement that the pre-install kill is
    // about to run — sets the flag even when an entry point other than the
    // About tab drove the install. Payload-less: the version (when known)
    // arrives with the About tab's own set call.
    const shell =
      typeof window !== "undefined"
        ? (window as { __TAURI__?: { event?: { listen?: (event: string, handler: (ev: { payload: unknown }) => void) => Promise<() => void> } } })
            .__TAURI__
        : undefined;
    const shellEvent = shell?.event;
    const maybeListen = shellEvent?.listen;
    if (typeof maybeListen === "function") {
      void maybeListen
        .call(shellEvent, "update-installing", () => {
          const current = useConfigStore.getState().updateInFlight;
          if (current === null) {
            useConfigStore.getState().setUpdateInFlight({ version: null });
          }
        })
        .catch(() => {});
    }
  }, []);

  if (!isTauri() || connection === "connected") {
    return updateInFlight !== null ? <RestartingSplash update={updateInFlight} /> : <>{children}</>;
  }
  // R101-B: the update owns the exit — never show the offline/connecting
  // screens for a backend the app killed on purpose.
  if (updateInFlight !== null) {
    return <RestartingSplash update={updateInFlight} />;
  }
  if (connection === "offline") {
    return <OfflineScreen error={connectionError} />;
  }
  return <ConnectingSplash />;
}

/**
 * R101-B: the update hand-off splash — the app is closing so the installer
 * can replace it (the NSIS `/R` leg relaunches it afterwards). Calm by
 * design: logo, spinner, one honest line. No errors, no Retry — there is
 * nothing for the owner to do for the next few seconds.
 */
function RestartingSplash({ update }: { update: UpdateInFlight }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-6"
      style={{ backgroundColor: "var(--ac-bg)" }}
      role="status"
      aria-live="polite"
      data-testid="update-restarting-splash"
    >
      <AcuteLogo size={72} ariaLabel="ACUTE-CODE" />
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2.5">
          <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--ac-accent)" }} />
          <span className="text-sm font-medium" style={{ color: "var(--ac-text-secondary)" }}>
            {update.version !== null ? `Restarting into ${update.version}…` : "Restarting into the new version…"}
          </span>
        </div>
        <span className="text-xs" style={{ color: "var(--ac-text-tertiary)" }}>
          installing the update — your data is kept, the app comes back by itself
        </span>
      </div>
    </div>
  );
}

/** Branded full-viewport splash — the wizard's atmosphere, spinner + status.
 *  R58: h-full (was h-screen) — the App root's flex column sizes it. */
function ConnectingSplash() {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-6"
      style={{ backgroundColor: "var(--ac-bg)" }}
      role="status"
      aria-live="polite"
    >
      <AcuteLogo size={72} ariaLabel="ACUTE-CODE" />
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2.5">
          <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--ac-accent)" }} />
          <span
            className="text-sm font-medium"
            style={{ color: "var(--ac-text-secondary)" }}
          >
            Connecting to agent-core…
          </span>
        </div>
        <span className="text-xs" style={{ color: "var(--ac-text-tertiary)" }}>
          starting the local engine — first launch can take a little longer
        </span>
      </div>
    </div>
  );
}

/**
 * The offline screen: the REAL shell-reported error (spawn failure, missing
 * bundle, exit code — whatever the Rust lifecycle logged), a Retry that
 * restarts the backend through the shell, and — R54 — the tail of
 * sidecar.log rendered IN-APP with a Copy-diagnostics button, so a failure
 * explains itself on screen instead of telling the owner to go find
 * %APPDATA% with a file explorer.
 */
function OfflineScreen({ error }: { error: string | null }) {
  const [retrying, setRetrying] = useState(false);
  const [logTail, setLogTail] = useState<SidecarLogTail | null>(null);
  const [copied, setCopied] = useState(false);
  const resetAfter = useTimeoutClear();

  // R54: fetch the engine log's last lines whenever the app lands offline (or
  // lands offline AGAIN after a failed Retry — the effect re-runs because the
  // error string changes between failures).
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    setLogTail(null);
    void getSidecarLogTail(60).then((tail) => {
      if (!cancelled) setLogTail(tail);
    });
    return () => {
      cancelled = true;
    };
  }, [error]);

  const onRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await retryConnection();
    } finally {
      setRetrying(false);
    }
  };

  const onCopyDiagnostics = async () => {
    const diagnostics = [
      "ACUTE-CODE — engine diagnostics",
      `error: ${error ?? "(none reported)"}`,
      logTail?.path ? `log: ${logTail.path}` : null,
      "",
      ...(logTail?.lines ?? ["(engine log unavailable)"]),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    try {
      await navigator.clipboard.writeText(diagnostics);
      setCopied(true);
      resetAfter(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    // R58: h-full (was h-screen) — sized by the App root's flex column
    // (behind the custom TitleBar in Tauri; unchanged in web).
    <div
      className="flex h-full w-full items-center justify-center p-6"
      style={{ backgroundColor: "var(--ac-bg)" }}
      role="alert"
    >
      <div
        className="flex w-full max-w-lg flex-col items-center gap-5 rounded-2xl border p-8 text-center"
        style={{
          backgroundColor: "var(--ac-card)",
          borderColor: "var(--ac-border-strong)",
          boxShadow: "0 18px 44px -18px rgba(0, 0, 0, 0.28)",
        }}
      >
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full"
          style={{ backgroundColor: "rgba(220, 38, 38, 0.08)" }}
        >
          <Unplug className="h-6 w-6 text-red-600" aria-hidden />
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-lg font-semibold" style={{ color: "var(--ac-text)" }}>
            Can&apos;t reach agent-core
          </h1>
          <p className="text-sm leading-relaxed" style={{ color: "var(--ac-text-secondary)" }}>
            The local engine that powers every screen didn&apos;t come up. Retry
            restarts it — your projects and keys are safe on disk.
          </p>
        </div>
        {error && (
          <p
            className="max-h-32 w-full overflow-y-auto break-words whitespace-pre-wrap rounded-lg px-3 py-2 text-left font-mono text-xs leading-relaxed custom-scrollbar"
            style={{ backgroundColor: "rgba(0, 0, 0, 0.04)", color: "var(--ac-text-secondary)" }}
          >
            {error}
          </p>
        )}
        {/* R54: the engine's own log tail, right in the app — no more "go find
            sidecar.log in %APPDATA%". Long tails scroll inside the box. */}
        {logTail && logTail.lines.length > 0 && (
          <div className="w-full text-left">
            <div
              className="mb-1 flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-widest"
              style={{ color: "var(--ac-text-tertiary)" }}
            >
              <span className="flex items-center gap-1.5">
                <ScrollText className="h-3 w-3" aria-hidden />
                Engine log — last {logTail.lines.length} lines
              </span>
              <button
                type="button"
                onClick={() => void onCopyDiagnostics()}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold transition-opacity hover:opacity-80"
                style={{ color: "var(--ac-accent)" }}
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3" aria-hidden /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" aria-hidden /> Copy diagnostics
                  </>
                )}
              </button>
            </div>
            <pre
              aria-label="Engine log tail"
              className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-[11px] leading-relaxed custom-scrollbar"
              style={{
                backgroundColor: "rgba(0, 0, 0, 0.04)",
                color: "var(--ac-text-secondary)",
              }}
            >
              {logTail.lines.join("\n")}
            </pre>
            {logTail.path && (
              <p className="mt-1 truncate text-[10px]" style={{ color: "var(--ac-text-tertiary)" }}>
                full log: {logTail.path}
              </p>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => void onRetry()}
          disabled={retrying}
          className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-60"
          style={{ backgroundColor: "var(--ac-accent)" }}
        >
          {retrying ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <RotateCcw className="h-4 w-4" aria-hidden />
          )}
          {retrying ? "Restarting engine…" : "Restart engine"}
        </button>
        {!logTail || logTail.lines.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--ac-text-tertiary)" }}>
            If it keeps failing: check <span className="font-mono">sidecar.log</span> in the
            app&apos;s data folder (%APPDATA%\acute-code)
          </p>
        ) : (
          <p className="text-xs" style={{ color: "var(--ac-text-tertiary)" }}>
            “Copy diagnostics” puts the error and log on your clipboard — paste
            it if you report the problem.
          </p>
        )}
      </div>
    </div>
  );
}
