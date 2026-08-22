import { type ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { resetFixtureAgents } from "./lib/agent-fixtures";
import { resetFixtureSessions } from "./lib/session-fixtures";
import { useConfigStore } from "./lib/config-store";
import { useThemeStore } from "./lib/theme-store";

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
  resetFixtureSessions();
  useConfigStore.setState({ baseUrl: "http://127.0.0.1:5178", token: null, demoData: true });
  useThemeStore.setState({ themeId: "nova", mode: "dark" });
  localStorage.clear();
}
