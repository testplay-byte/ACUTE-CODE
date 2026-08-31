import { useEffect } from "react";
import { Route, Routes, useNavigate } from "react-router";
import { AppShell } from "./components/shell/AppShell";
import { ConnectionGate } from "./components/shell/ConnectionGate";
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
 * included); only the global sessions browser was removed.
 */
export function App() {
  return (
    // R58: the custom TitleBar owns the top 40px in Tauri mode (the native
    // decorations are gone); it renders null in web mode, where the column
    // degenerates to one full-height child — visually identical to pre-R58.
    // Everything below fills the remainder, so full-bleed screens (AppShell,
    // wizard, connection gate) size with h-full instead of h-screen.
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <div className="min-h-0 flex-1">
        <ConnectionGate>
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
                    spec="—"
                    detail="This screen does not exist. Use the sidebar to navigate."
                  />
                }
              />
            </Route>
          </Routes>
        </ConnectionGate>
      </div>
    </div>
  );
}
