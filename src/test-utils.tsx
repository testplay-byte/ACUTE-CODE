import { type ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { resetFixtureAgents } from "./lib/agent-fixtures";
import { resetFixtureProjects } from "./lib/project-fixtures";
import { resetFixtureSessions } from "./lib/session-fixtures";
import { useConfigStore } from "./lib/config-store";
import { useThemeStore } from "./lib/theme-store";
import { useProjectChatStore } from "./lib/project-chat-store";
// R99-C: the update-checker's persisted state (auto-check + cadence stamp +
// the pending flag) — reset like every other persisted store so a test's
// pending update never leaks a Settings dot into the next one.
import { useUpdateCheckerStore } from "./lib/update-checker";

/** Fresh QueryClient per render: no retry, no stale cache across tests. */
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** Render with the providers the app mounts (router + query client). */
export function renderWithProviders(ui: ReactNode, { route = "/" } = {}) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Isolated demo fixture + reset stores; call in beforeEach of UI tests. */
export function resetTestState() {
  resetFixtureAgents();
  resetFixtureProjects();
  resetFixtureSessions();
  useConfigStore.setState({
    baseUrl: "http://127.0.0.1:5178",
    token: null,
    demoData: true,
    // R101-B: never inherit a prior test's update hand-off (the splash flag).
    updateInFlight: null,
  });
  useThemeStore.setState({ themeId: "nova", mode: "dark" });
  // ROUND-62: the sidebar minimize flag is PERSISTED (the owner expects his
  // rail to survive a restart) — reset it so tests never inherit a prior
  // test's rail state (appSidebarVisible needs no reset: transient).
  useProjectChatStore.setState({ appSidebarMinimized: false });
  // R99-C: fresh update-checker state per test (auto-check ON, no pending
  // update, no cadence stamp — the fresh-install defaults).
  useUpdateCheckerStore.setState({ autoCheck: true, lastCheckTs: 0, pendingVersion: null });
  localStorage.clear();
  // Shell tests exercise the main app, not first-run onboarding — mark setup done.
  localStorage.setItem("acute.setupDone", "1");
}
