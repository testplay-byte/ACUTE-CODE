import { useCallback, useEffect, useRef, useState } from "react";
import { isNativeBrowserAvailable } from "../../../lib/native-browser";
import {
  hideMenuOverlay,
  // R126-3h: the shared payload-theme builder (the deep-tier/badge-tone/
  // clay legs ride the payload now — the local pre-R126 literal below is
  // retired).
  menuThemeFromStyles,
  onMenuOverlayClose,
  onMenuOverlayPick,
  showMenuOverlay,
  type MenuPayload,
  type MenuTheme,
  type OptionsItemPayload,
} from "../../../lib/menu-overlay";
import { useThemeStyles } from "../../../lib/use-theme-styles";

/**
 * ROUND-92 (R92-A) — THE COMPOSER'S NATIVE OPTION MENUS.
 *
 * The owner's v0.89.0 verdict: "When I tapped on any of the options (for
 * example, the model option selection option, the plan mode, full access
 * mode, or ask mode), the right-side browser window would apparently get
 * cleared out… I still don't feel like the browser is an embedded part of
 * the application itself." Root cause: the composer's mode / thinking /
 * add-context dropdowns are plain DOM menus — at the owner's squeezed
 * geometry (the chat column at its 240px floor, a wide right sidebar) the
 * w-64 menu anchored at the composer's left cluster GEOMETRICALLY crosses
 * into the browser panel's area, and since an OS-level child webview floats
 * above ALL app HTML, the R89-E5 overlay guard correctly hides the webview
 * behind a menu the owner can never see above the page.
 *
 * The fix mirrors the R90-C2 RightSidebar answer (its quick menu /
 * sub-agent picker flow — see RightSidebar.tsx's overlay-first ladder):
 * inside the Tauri shell these three simple menus open in the MENU OVERLAY
 * WINDOW — the owned transparent OS window that rides ABOVE the browser
 * webview (menu-overlay.html) — so the browser never pauses at all. Only
 * when that path is unusable (web dev, e2e, a rejected command) does the
 * plain DOM dropdown render exactly as before (web mode is byte-identical:
 * every existing Composer test keeps passing on the DOM leg).
 *
 * Shared by ModeSwitcher / ThinkingLevelButton / AddContextButton so the
 * ladder lives in ONE place. The hook owns both menu states:
 *  · `open` — the DOM dropdown is up (web / overlay-failed fallback).
 *  · `overlayActive` — the overlay window is the menu. While true the DOM
 *    dropdown must NOT render (a hidden duplicate would fire the overlay
 *    guard and blank the browser — the very bug this fixes).
 */

/** One selectable row (the exact shape the overlay payload carries). */
export type NativeOptionItem = Omit<OptionsItemPayload, "kind">;

/** The overlay card's outer padding (MenuOverlayApp paints padding:6 —
 * the anchor math must reserve it on top of the payload's card width). */
const OVERLAY_CARD_PADDING = 6;
/** The DOM menus' gap: `absolute bottom-9` = 36px above the anchor's bottom
 * edge (the pill fills the anchor wrapper, so this is the gap between the
 * pill's TOP and the menu's bottom edge = 36 − 28 = 8px visually). */
const DOM_MENU_BOTTOM_OFFSET = 36;
/** The overlay card's own chrome: title row (~20px) + inner padding + the
 * bottom breathing room — the same arithmetic RightSidebar.tsx uses. */
const OVERLAY_TITLE_AND_PADDING = 6 + 20 + 10;

/** The hook's configuration (stable callbacks not required — read fresh at
 * open/pick time through the ref, exactly like RightSidebar's pick handler). */
export interface NativeOptionsMenuConfig {
  /** The overlay card's title (the DOM menus' aria-label). */
  title: string;
  /** The DOM menu's CSS width — becomes the overlay card's width
   * (w-64 = 256, w-56 = 224). */
  menuWidth: number;
  /** Which anchor edge the DOM menu aligns to (left-0 vs right-0). */
  align: "left" | "right";
  /** Estimated px per row (label-only rows ~30, rows with a desc ~42). */
  rowHeight: number;
  /** The rows, built at OPEN time so the `selected` state is fresh. */
  buildItems: () => NativeOptionItem[];
  /** Apply a pick — the EXACT body of the DOM row's onClick handler. */
  onPick: (id: string) => void;
}

/** The overlay-first ladder's handle. */
export interface NativeOptionsMenu {
  /** The DOM dropdown is open (web mode / overlay-failed fallback). */
  open: boolean;
  /** The overlay WINDOW is currently the menu (the DOM one must not render). */
  overlayActive: boolean;
  /** `open || overlayActive` — what the pill's aria-expanded should read. */
  isOpen: boolean;
  /** The pill's onClick: toggles through the ladder (anchor = the wrapper
   * element that carries the DOM menu's positioning, useDismiss's ref). */
  toggle: (anchor: HTMLElement | null) => void;
  /** Close whichever leg is open (useDismiss's dismiss + unmount paths). */
  closeAll: () => void;
}

/** The MenuTheme fields the overlay page paints with (the same subset
 * RightSidebar sends — JSON-safe strings + the dark flag).
 * R126-3h: the local literal is retired — the shared menuThemeFromStyles
 * builder (lib/menu-overlay.ts) owns the fields, now including the
 * deep-tier/badge-tone/clay legs. */
function toMenuTheme(styles: ReturnType<typeof useThemeStyles>): MenuTheme {
  return menuThemeFromStyles(styles);
}

export function useNativeOptionsMenu(config: NativeOptionsMenuConfig): NativeOptionsMenu {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const [overlayActive, setOverlayActive] = useState(false);

  // The latest config + theme (the pick/close subscriptions are mounted
  // ONCE; they must always run the latest callbacks without resubscribing —
  // the RightSidebar overlayPickRef pattern).
  const cfgRef = useRef(config);
  useEffect(() => {
    cfgRef.current = config;
  });
  const themeRef = useRef(styles);
  useEffect(() => {
    themeRef.current = styles;
  });

  // Whether THIS hook's overlay is the one currently up (the shared
  // menu-overlay window is a singleton — the pick event reaches every
  // mounted subscriber, so only the one holding the overlay may act).
  const overlayActiveRef = useRef(false);
  useEffect(() => {
    overlayActiveRef.current = overlayActive;
  }, [overlayActive]);
  // The anchor wrapper (the element the outside-click handler must treat as
  // "inside" — a mousedown on the pill itself is a TOGGLE, not a dismiss,
  // exactly like useDismiss's contains() check).
  const anchorRef = useRef<HTMLElement | null>(null);
  // R92-A: the open-request token. showMenuOverlay is async — a close (or a
  // component unmount) can land between the invoke and its resolution; a
  // stale resolution must NOT flip `overlayActive` back on (the window was
  // already taken down). Bumping the token invalidates the in-flight show.
  const requestSeqRef = useRef(0);
  /** True while THIS hook's showMenuOverlay invoke is unresolved (the
   * unmount cleanup must take the window down in that window of time too). */
  const showInFlightRef = useRef(false);

  const closeOverlay = useCallback((): void => {
    requestSeqRef.current += 1;
    hideMenuOverlay();
    setOverlayActive(false);
  }, []);

  const closeAll = useCallback((): void => {
    closeOverlay();
    setOpen(false);
  }, [closeOverlay]);

  // The pill's onClick — the ladder itself.
  const toggle = useCallback(
    (anchor: HTMLElement | null): void => {
      if (open || overlayActive) {
        closeAll();
        return;
      }
      // Web dev / e2e / the plain browser: the DOM dropdown, exactly the
      // pre-R92 behavior (every web-mode test lives on this leg).
      if (!isNativeBrowserAvailable() || anchor === null) {
        setOpen(true);
        return;
      }
      const c = cfgRef.current;
      const items = c.buildItems();
      anchorRef.current = anchor;
      const rect = anchor.getBoundingClientRect();
      // The overlay window's size: the payload card's width + the 6px×2
      // window padding; the height from the row estimate + the card chrome
      // (the same arithmetic RightSidebar.tsx's ladder uses).
      const windowWidth = c.menuWidth + 2 * OVERLAY_CARD_PADDING;
      const menuHeight = OVERLAY_TITLE_AND_PADDING + items.length * c.rowHeight;
      // The DOM menu's geometry, mirrored: anchored above the pill
      // (bottom-9), aligned to the pill's left (left-0) or right (right-0)
      // edge, clamped inside the viewport so the OS window never leaves it.
      let left =
        c.align === "left" ? rect.left : rect.right - c.menuWidth;
      left = Math.max(0, Math.min(left, window.innerWidth - windowWidth));
      const top = Math.max(0, rect.bottom - DOM_MENU_BOTTOM_OFFSET - menuHeight);
      const payload: MenuPayload = {
        kind: "options",
        title: c.title,
        width: c.menuWidth,
        items: items.map((item): OptionsItemPayload => ({ ...item, kind: "options" })),
        theme: toMenuTheme(themeRef.current),
      };
      requestSeqRef.current += 1;
      const seq = requestSeqRef.current;
      showInFlightRef.current = true;
      void showMenuOverlay({ left, top, width: windowWidth, height: menuHeight }, payload).then((ok) => {
        showInFlightRef.current = false;
        if (seq !== requestSeqRef.current) {
          // The hook closed/unmounted while the command was in flight —
          // take the window back down immediately if it did come up.
          if (ok) hideMenuOverlay();
          return;
        }
        if (ok) {
          setOverlayActive(true);
        } else {
          // The command failed (the R91 deadlock class): the DOM dropdown
          // is the honest fallback, exactly as before R92.
          setOpen(true);
        }
      });
    },
    [open, overlayActive, closeAll],
  );

  // The pick report — applies the choice with the SAME body the DOM row's
  // onClick runs, then closes. Gated on THIS hook's overlay being up (the
  // mode / thinking / add-context menus all share the "options" kind, so
  // the mounted-but-closed siblings must not act on each other's picks).
  useEffect(
    () =>
      onMenuOverlayPick((pick) => {
        if (pick.kind !== "options" || !overlayActiveRef.current) return;
        const id = pick.item.kind === "options" ? pick.item.id : null;
        closeAll();
        if (id !== null) cfgRef.current.onPick(id);
      }),
    [closeAll],
  );

  // The overlay page's own close request (Escape while it somehow holds
  // focus — it is built focusable(false); the belt to the braces below).
  useEffect(
    () =>
      onMenuOverlayClose(() => {
        if (overlayActiveRef.current) closeAll();
      }),
    [closeAll],
  );

  // While the OVERLAY window is the menu, THIS window owns the dismissal
  // gestures the DOM menu's useDismiss usually provides: any mousedown in
  // the main window is by definition outside the menu's own OS window, and
  // Escape here closes it too. A mousedown on the anchor wrapper (the pill)
  // is exempt — that is the toggle, not a dismiss (useDismiss semantics).
  useEffect(() => {
    if (!overlayActive) return;
    const onDown = (e: MouseEvent): void => {
      if (anchorRef.current !== null && anchorRef.current.contains(e.target as Node)) return;
      closeAll();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeAll();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [overlayActive, closeAll]);

  // Unmount while the overlay is up (chat/session switch) or while its show
  // is still in flight: take the window down and invalidate the request —
  // nothing would ever be left to close it otherwise.
  useEffect(() => {
    return () => {
      requestSeqRef.current += 1;
      if (overlayActiveRef.current || showInFlightRef.current) hideMenuOverlay();
    };
  }, []);

  return { open, overlayActive, isOpen: open || overlayActive, toggle, closeAll };
}
