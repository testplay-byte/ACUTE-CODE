import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { ApiError } from "./lib/api";
import { applyTheme, useThemeSync, useThemeStore } from "./lib/theme-store";
import { setQueryClient } from "./lib/query-client";
// R59-E: the frontend error bus — every capture point below funnels here so
// the right-sidebar Console shows what broke (owner: "proper console-like
// error monitoring and error handling… If there are any errors along the way
// then you can easily detect them by yourself").
import { reportAppError } from "./lib/error-bus";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root container missing in index.html");
}

// R59-E: global error capture — installed BEFORE render, never removed. Any
// error that escapes every try/catch (a bad event handler, a floating
// promise) lands in the Console bus instead of dying silently in devtools.
// window "error" covers sync throws; "unhandledrejection" covers promise
// rejections nobody caught (fetch races, async callbacks).
window.addEventListener("error", (event: ErrorEvent) => {
  reportAppError({
    source: "frontend",
    kind: "window.onerror",
    message: event.message || "Uncaught error",
    detail: `${event.filename}:${event.lineno}:${event.colno}`,
  });
});
window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  const reason: unknown = event.reason;
  const message =
    reason instanceof Error ? reason.message : reason === undefined ? "(no reason)" : String(reason);
  reportAppError({
    source: "frontend",
    kind: "unhandledrejection",
    message,
    detail: reason instanceof Error ? reason.stack : undefined,
  });
});

// Paint the persisted theme before React mounts so there is no flash of the
// wrong palette.
{
  const { themeId, mode } = useThemeStore.getState();
  applyTheme(themeId, mode);
}

const queryClient = new QueryClient({
  // R59-E: TanStack Query global failures (kind "query") — a failing query
  // used to surface only in whichever panel bothered to render its error
  // state; now every failed query lands in the Console bus. The message and
  // status ride along; request BODIES/URLs stay out (ApiError messages carry
  // the envelope text, and the bus scrubs token-shaped material anyway).
  queryCache: new QueryCache({
    onError: (error, query) => {
      const queryName = Array.isArray(query.queryKey)
        ? query.queryKey.map((k) => String(k)).join("/")
        : String(query.queryKey);
      // ApiError carries the HTTP status + envelope code; anything else is a
      // network/runtime failure with neither.
      const apiError = error instanceof ApiError ? error : undefined;
      reportAppError({
        source: "frontend",
        kind: "query",
        message: error instanceof Error ? error.message : String(error),
        detail: [
          `query: ${queryName}`,
          apiError !== undefined ? `status: ${apiError.status}` : undefined,
          apiError !== undefined ? `code: ${apiError.code}` : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join(" · "),
      });
    },
  }),
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
