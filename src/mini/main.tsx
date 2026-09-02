import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, useThemeStore } from "../lib/theme-store";
import { MiniApp } from "./MiniApp";
// The SAME stylesheet as the main entry — the design tokens (--ac-* custom
// properties), fonts and the R59-A minimal scrollbars make the floating
// monitor read as OUR chrome, not a foreign page (the popout/main.tsx rule).
import "../index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root container missing in mini.html");
}

// Paint the persisted theme before React mounts (the popout/main.tsx
// pattern — no flash of the wrong palette). The theme store persists to
// localStorage, which the main window and this window share as one origin,
// so the floating monitor follows the app's theme automatically. A fresh
// profile (no persisted state) gets the store's default — the refined dark
// palette; the owner can flip the app to light and this bar follows.
{
  const { themeId, mode } = useThemeStore.getState();
  applyTheme(themeId, mode);
}

// The window is a fixed 360×96 frameless bar (src-tauri/src/mini.rs): pin the
// body to the theme background so the card's rounded corners blend (the
// window itself is opaque — the browser.rs WebView2-robustness call).
document.body.style.margin = "0";
document.body.style.overflow = "hidden";

createRoot(container).render(
  <StrictMode>
    <MiniApp />
  </StrictMode>,
);
