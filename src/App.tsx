import { Route, Routes } from "react-router";
import { AppShell } from "./components/shell/AppShell";
import { AgentsScreen } from "./components/agents/AgentsScreen";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { SettingsPage } from "./pages/SettingsPage";

/** Six SPEC F9 screens; Agents is real in Wave 1, the rest are titled placeholders. */
export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route
          index
          element={
            <PlaceholderPage
              title="Dashboard"
              spec="F7"
              detail="Overview with stat cards, token chart and recent activity — lands with the usage API hookup."
            />
          }
        />
        <Route
          path="project"
          element={
            <PlaceholderPage
              title="Project"
              spec="F1"
              detail="File tree, editor hookup and git panel, executed through the approval engine."
            />
          }
        />
        <Route path="agents" element={<AgentsScreen />} />
        <Route
          path="sessions"
          element={
            <PlaceholderPage
              title="Sessions"
              spec="F3"
              detail="Session list, chat stream and the Kanban task board, fed by the sidecar REST + WS APIs."
            />
          }
        />
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
  );
}
