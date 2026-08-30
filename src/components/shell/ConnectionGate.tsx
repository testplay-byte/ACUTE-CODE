import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, RotateCcw, Unplug } from "lucide-react";
import { useConfigStore } from "../../lib/config-store";
import { beginSidecarConnect, retryConnection } from "../../lib/sidecar-connection";
import { isTauri } from "../../lib/sidecar";
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
 */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const connection = useConfigStore((s) => s.connection);
  const connectionError = useConfigStore((s) => s.connectionError);
  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    beginSidecarConnect();
  }, []);

  if (!isTauri() || connection === "connected") {
    return <>{children}</>;
  }
  if (connection === "offline") {
    return <OfflineScreen error={connectionError} />;
  }
  return <ConnectingSplash />;
}

/** Branded full-viewport splash — the wizard's atmosphere, spinner + status. */
function ConnectingSplash() {
  return (
    <div
      className="flex h-screen w-full flex-col items-center justify-center gap-6"
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
 * restarts the backend through the shell, and the sidecar.log pointer so the
 * owner can paste diagnostics instead of screenshots of silent failures.
 */
function OfflineScreen({ error }: { error: string | null }) {
  const [retrying, setRetrying] = useState(false);

  const onRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await retryConnection();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      className="flex h-screen w-full items-center justify-center p-6"
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
            className="w-full break-words rounded-lg px-3 py-2 text-left font-mono text-xs leading-relaxed"
            style={{ backgroundColor: "rgba(0, 0, 0, 0.04)", color: "var(--ac-text-secondary)" }}
          >
            {error}
          </p>
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
        <p className="text-xs" style={{ color: "var(--ac-text-tertiary)" }}>
          If it keeps failing: check <span className="font-mono">sidecar.log</span> in the
          app&apos;s data folder (%APPDATA%\acute-code)
        </p>
      </div>
    </div>
  );
}
