import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { applyTheme, useThemeSync, useThemeStore } from "./lib/theme-store";
import { setQueryClient } from "./lib/query-client";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root container missing in index.html");
}

// Paint the persisted theme before React mounts so there is no flash of the
// wrong palette.
{
  const { themeId, mode } = useThemeStore.getState();
  applyTheme(themeId, mode);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false },
  },
});
// ROUND-39: expose the singleton to non-component modules (the stream store
// invalidates queries from outside React's render tree — background sessions
// keep the file explorer + session list fresh even when no panel is mounted).
setQueryClient(queryClient);

function Root() {
  useThemeSync();
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>
  );
}

createRoot(container).render(<Root />);
