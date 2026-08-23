import { useEffect, type RefObject } from "react";

/**
 * Adds a `scrolling` CSS class to the target element while the user is actively
 * scrolling, and removes it 1.2s after scrolling stops. Pair with the `.auto-scroll`
 * CSS utility (defined in src/index.css) that shows the scrollbar only when the
 * `.scrolling` class is present.
 *
 * Verbatim port of design/demos/project-chat/src/lib/useScrollFade.ts (only the
 * React type import style adapted to this repo's conventions).
 */
export function useScrollFade(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timeout: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      el.classList.add("scrolling");
      clearTimeout(timeout);
      timeout = setTimeout(() => el.classList.remove("scrolling"), 1200);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      clearTimeout(timeout);
    };
  }, [ref]);
}
