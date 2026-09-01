import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, useThemeStore } from "../lib/theme-store";
import { PopoutApp } from "./PopoutApp";
// The SAME stylesheet as the main entry — the design tokens (--ac-* custom
// properties), fonts and the R59-A minimal scrollbars make the pop-out read
// as OUR chrome, not a foreign page.
import "../index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root container missing in popout.html");
}

// Paint the persisted theme before React mounts (the main.tsx pattern — no
// flash of the wrong palette). The theme store persists to localStorage,
// which the main window and this window share as one origin, so the pop-out
// follows the app's theme automatically.
{
  const { themeId, mode } = useThemeStore.getState();
  applyTheme(themeId, mode);
}

createRoot(container).render(
  <StrictMode>
    <PopoutApp />
  </StrictMode>,
);
