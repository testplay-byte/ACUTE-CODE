/**
 * ROUND-90 (R90-D1) — THE ALWAYS-VISIBLE CURSOR'S BOOT SCRIPT.
 *
 * The owner: "The mouse pointer should ALWAYS be visible. It should not go
 * away or anything like that." Pre-R90 the agent's cursor only EXISTED from
 * the first action to the page's next navigation — every page load wiped it,
 * and between actions the new page showed no cursor at all (the owner:
 * "the mouse disappeared").
 *
 * THE MECHANISM: the native tab webviews are created with THIS script as
 * their INITIALIZATION SCRIPT (Rust `browser_tab_create`'s hands_init_script
 * parameter — WebView2's AddScriptToExecuteOnDocumentCreatedAsync via
 * tauri's WebviewBuilder::initialization_script). Initialization scripts
 * run at DOCUMENT CREATION on EVERY navigation of the webview — before any
 * page script — so the cursor is painted from the first frame of every
 * page, parked at a natural RESTING SPOT (the lower-right quadrant a hand
 * drifts to, lightly randomized so every page doesn't restart at the same
 * pixel).
 *
 * THE HANDOFF: the boot records `window.__acuteHandsRest = {x, y}`. The
 * agent-hands runtime (agent-core's browser-hands.ts, installed by the
 * first action's eval) ADOPTS the existing cursor element and starts its
 * logical position from `__acuteHandsRest` — so the first move begins
 * from where the eye already saw the cursor resting, never a teleport.
 *
 * The element construction (id + cssText + SVG) is the EXACT twin of the
 * runtime's ensureCursor() — keep the two in sync (both marked R90-D1).
 * CSP-tolerant: element.style.cssText + innerHTML only.
 */
export function buildHandsBootScript(): string {
  return `(function () {
  if (window.__acuteHandsRest) return;
  var x = Math.round(window.innerWidth * (0.60 + Math.random() * 0.18));
  var y = Math.round(window.innerHeight * (0.66 + Math.random() * 0.20));
  window.__acuteHandsRest = { x: x, y: y };
  var c = document.getElementById("__acute-agent-cursor");
  if (c === null) {
    c = document.createElement("div");
    c.id = "__acute-agent-cursor";
    c.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;margin:0;padding:0;z-index:2147483647;pointer-events:none;will-change:transform;opacity:0;transition:opacity .25s ease;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));";
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 2.2 18.9 10.6l-6.3 1.1 3 6.6-2.7 1.2-3-6.7-4.9 4.1z" fill="#FF6B2C" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
  }
  c.style.transform = "translate(" + (x - 2) + "px," + (y - 2) + "px)";
  c.style.opacity = "1";
})();`;
}
