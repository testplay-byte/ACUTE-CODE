import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, useThemeStore } from "../lib/theme-store";
import { MenuOverlayApp } from "./MenuOverlayApp";
// The SAME stylesheet as the main entry (the popout/mini rule): the fonts
// and design tokens make the overlay read as OUR chrome. The window must
// stay TRANSPARENT outside the menu card, so the inline overrides below
// beat index.css's opaque `body { background-color: var(--bg) }` (inline
// styles outrank stylesheet rules).
import "../index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root container missing in menu-overlay.html");
}

// Paint the persisted theme before React mounts (the popout/mini pattern —
// no flash of the wrong palette; the theme store's localStorage is shared
// with the main window as one origin, so the menu follows the app's theme).
{
  const { themeId, mode } = useThemeStore.getState();
  applyTheme(themeId, mode);
}

// The overlay window is transparent outside the menu card (see
// menu-overlay.html's <style>): assert that against index.css inline.
document.documentElement.style.background = "transparent";
document.body.style.margin = "0";
document.body.style.background = "transparent";
document.body.style.overflow = "hidden";

createRoot(container).render(
  <StrictMode>
    <MenuOverlayApp />
  </StrictMode>,
);
