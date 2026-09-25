import { useEffect } from "react";
import { Route, Routes, useNavigate } from "react-router";
import { AppShell } from "./components/shell/AppShell";
import { ConnectionGate } from "./components/shell/ConnectionGate";
// R59-E: the app-level render error boundary — a throwing screen shows an
// honest fallback card instead of a blank window, and lands in the Console.
import { ErrorBoundary } from "./components/shell/ErrorBoundary";
import { TitleBar } from "./components/shell/TitleBar";
import { ProjectView } from "./components/projects/ProjectView";
import { DemoViewerScreen } from "./components/demos/DemoViewerScreen";
import { ProjectChatScreen } from "./components/project-chat";
import { DashboardScreen } from "./components/dashboard";
import { UsageScreen } from "./components/usage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupWizard } from "./components/onboarding/SetupWizard";
import { shouldRunSetup } from "./components/onboarding/providers-api";
import { isTauri } from "./lib/sidecar";

/**
 * First-run gate (plan-ui-fidelity.md Wave 1): with no `acute.setupDone`
 * flag and a live provider list that shows zero configured keys, route to
 * /setup before anything else. Checked once per boot, with a short retry
 * window because the sidecar endpoint is adopted asynchronously. An
 * inconclusive check (sidecar unreachable — browser dev, tests) never
 * hijacks routing.
 */
function FirstRunCheck() {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const DELAY_MS = 1200;
    const MAX_ATTEMPTS = 6; // ~7s window for the shell handoff to land

    const attempt = async (n: number) => {
      const answer = await shouldRunSetup();
      if (cancelled) return;
      if (answer === true) {
        navigate("/setup", { replace: true });
        return;
      }
      // false → flag set or a provider has a key → stop.
      // null → sidecar not reachable yet → retry within the boot window.
      if (answer === false || n >= MAX_ATTEMPTS) return;
      timer = setTimeout(() => void attempt(n + 1), DELAY_MS);
    };
    void attempt(1);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [navigate]);

  return null;
}

/**
 * Route map (owner round-8): / (dashboard) · /project/:id (sidebar projects) ·
 * /usage · /settings (agents management + API keys + appearance live there) ·
 * /setup is the full-bye first-run wizard, outside the app shell.
 *
 * ROUND-49 (owner directive: "completely remove the sessions navigation. It
 * should not be available anywhere in our project at all"): the standalone
 * /sessions screen is GONE — route, component, everything. Sessions still
 * exist per-project (the project's chat conversations, fork/revert/rename
 * included); only the global sessions browser was removed. R113-d finally
 * deleted the orphaned ChatView/NewSessionDialog source files too.
 */
export function App() {
  // R59-A (owner: "make that top navigation bar rounded and give it padding
  // on all four sides"): in Tauri mode the window paints a soft inset FRAME —
  // 8px of breathing room on every side + an 8px gap — and the TitleBar and
  // the content area each become a rounded card on the ambient background
  // (the rounded-corner, padded look the owner asked for; the frame reads as
  // one continuous window, never a floating toolbar). Web mode keeps the
  // pre-R58 full-bleed column — the TitleBar renders null there, so the
  // column degenerates to one full-height child, visually unchanged.
  const shell = isTauri();
  return (
    <div
      className={
        shell
          ? "flex h-screen flex-col gap-2 p-2 overflow-hidden"
          : "flex h-screen flex-col overflow-hidden"
      }
      style={shell ? { background: "var(--ac-frame-bg, var(--ac-bg))" } : undefined}
    >
      <TitleBar />
      <div
        // R126 (the Clay Companion redesign): the content card is the app's
        // CANVAS — the warm clay rim hairline (the 1.5px bento border
        // retired; TOKENS §5/§10's ladder: the frame strip is ambient, this
        // canvas is the bg tier, the raised clay cards live inside it).
        className={
          shell
            ? "min-h-0 flex-1 overflow-hidden rounded-[14px] border"
            : "min-h-0 flex-1"
        }
        style={shell ? { borderColor: "var(--ac-clay-rim)" } : undefined}
      >
        <ConnectionGate>
          {/* R59-E: ONE boundary around the route content (inside the content
              card, inside ConnectionGate's children — the R59-A frame layout
              classes above are untouched). A render throw anywhere below the
              routes becomes a fallback card + a Console row, never a blank
              window; the boundary is INSIDE the gate so the connection/offline
              chrome never gets replaced by the fallback. */}
          <ErrorBoundary>
            <FirstRunCheck />
            <Routes>
              <Route path="/setup" element={<SetupWizard />} />
              <Route element={<AppShell />}>
                <Route index element={<DashboardScreen />} />
                <Route path="project/:id" element={<ProjectView />} />
                <Route path="project/:id/chat" element={<ProjectChatScreen />} />

                {/* ROUND-52 (R52-b): the real Usage screen — was PlaceholderPage
                    (owner: "Usage screen section 2 … you apparently did not
                    implement the usage properly"). */}
                <Route path="usage" element={<UsageScreen />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="demos" element={<DemoViewerScreen />} />
                <Route
                  path="*"
                  element={
                    <PlaceholderPage
                      title="Not found"
                      detail="This screen does not exist. Use the sidebar to navigate."
                    />
                  }
                />
              </Route>
            </Routes>
          </ErrorBoundary>
        </ConnectionGate>
      </div>
    </div>
  );
}
