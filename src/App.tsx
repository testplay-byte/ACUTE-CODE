import { useEffect } from "react";
import { Route, Routes, useNavigate } from "react-router";
import { AppShell } from "./components/shell/AppShell";
import { ProjectView } from "./components/projects/ProjectView";
import { ProjectChatScreen } from "./components/project-chat";
import { DashboardScreen } from "./components/dashboard";
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
 * /sessions stays routed for the upcoming chat-window flow but is NOT in the
 * sidebar. /setup is the full-bye first-run wizard, outside the app shell.
 */
export function App() {
  return (
    <>
      <FirstRunCheck />
      <Routes>
        <Route path="/setup" element={<SetupWizard />} />
        <Route element={<AppShell />}>
          <Route index element={<DashboardScreen />} />
          <Route path="project/:id" element={<ProjectView />} />
          <Route path="project/:id/chat" element={<ProjectChatScreen />} />
          
          <Route
            path="usage"
            element={
              <PlaceholderPage
                title="Usage"
                spec="F7"
                detail="Cost/token aggregation by day, provider, model and agent — provider-reported vs estimated."
              />
            }
          />
          <Route path="settings" element={<SettingsPage />} />
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
    </>
  );
}
