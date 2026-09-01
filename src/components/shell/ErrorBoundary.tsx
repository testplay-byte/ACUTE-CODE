import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { reportAppError } from "../../lib/error-bus";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";

/**
 * ROUND-59 (R59-E) — the app-level React error boundary (owner: "proper
 * console-like error monitoring and error handling… If there are any errors
 * along the way then you can easily detect them by yourself").
 *
 * Mounted ONCE in App.tsx inside the content card (inside ConnectionGate's
 * children, wrapping <Routes> + FirstRunCheck). Before this, a render throw
 * anywhere below the routes unmounted React to a BLANK window — the worst
 * failure mode a desktop app can have, because the owner sees nothing and
 * the error only exists in devtools. Now:
 *
 *   - the error lands in the error-bus (kind "render", componentStack
 *     included) so the right-sidebar Console shows it alongside the sidecar
 *     ring — copyable, countable, never silently swallowed;
 *   - the screen itself renders an honest fallback card ("Something broke
 *     rendering this screen") with Retry (reset the boundary — transient
 *     render state can clear on remount) and Copy diagnostics;
 *   - NEVER a white screen: the fallback is tiny and has no dependencies
 *     that can throw while rendering.
 *
 * Class component by necessity — React still exposes error boundaries only
 * through the componentDidCatch/getDerivedStateFromError lifecycle.
 */
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** The React component stack captured in componentDidCatch (for Copy diagnostics). */
  componentStack: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // The ONE capture point for render errors. The bus scrubs secret-shaped
    // text before storing; the component stack is the most valuable field
    // (which subtree broke) so it rides along and is kept in state for the
    // fallback's Copy-diagnostics button.
    const componentStack = errorInfo.componentStack ?? undefined;
    this.setState({ componentStack: componentStack ?? null });
    reportAppError({
      source: "frontend",
      kind: "render",
      message: error.message,
      detail: error.stack,
      componentStack,
    });
  }

  /** Retry = reset the boundary — children remount from scratch. */
  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error === null) return this.props.children;
    return (
      <RenderErrorFallback
        error={error}
        componentStack={componentStack ?? undefined}
        onRetry={this.reset}
      />
    );
  }
}

/**
 * The fallback card — ConnectionGate's offline-screen visual language (token
 * colors, centered card, icon + copy button), sized for the content card it
 * replaces. Deliberately dependency-free beyond icons + the clipboard.
 */
function RenderErrorFallback({
  error,
  componentStack,
  onRetry,
}: {
  error: Error;
  componentStack?: string;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const resetAfter = useTimeoutClear();

  const onCopyDiagnostics = async () => {
    const diagnostics = [
      "ACUTE-CODE — render error diagnostics",
      `error: ${error.message}`,
      "",
      error.stack ?? "(no stack)",
      componentStack ? `\nComponent stack:\n${componentStack}` : "",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(diagnostics);
      setCopied(true);
      resetAfter(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="flex h-full w-full items-center justify-center p-6"
      style={{ backgroundColor: "var(--ac-bg)" }}
      role="alert"
      data-testid="render-error-fallback"
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
          <TriangleAlert className="h-6 w-6 text-red-600" aria-hidden />
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-lg font-semibold" style={{ color: "var(--ac-text)" }}>
            Something broke rendering this screen
          </h1>
          <p className="text-sm leading-relaxed" style={{ color: "var(--ac-text-secondary)" }}>
            The error was captured — open the <strong>Console</strong> tab in the right sidebar
            to see it with the full component stack. Your projects and keys are safe on disk.
          </p>
        </div>
        <p
          className="max-h-32 w-full overflow-y-auto break-words whitespace-pre-wrap rounded-lg px-3 py-2 text-left font-mono text-xs leading-relaxed custom-scrollbar"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.04)", color: "var(--ac-text-secondary)" }}
        >
          {error.message}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: "var(--ac-accent)" }}
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => void onCopyDiagnostics()}
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-80"
            style={{ color: "var(--ac-accent)" }}
          >
            {copied ? (
              <>
                <Check className="h-4 w-4" aria-hidden /> Copied
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" aria-hidden /> Copy diagnostics
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
