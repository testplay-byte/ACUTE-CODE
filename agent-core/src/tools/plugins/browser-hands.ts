// ─────────────────────────────────────────────────────────────────────────────
// ROUND-89 (R89-E): THE AGENT HANDS — the visible, human-like input engine.
//
// The owner's directive: "give it full-fledged capabilities… access to
// control the mouse pointer. It will be given its own custom mouse pointer…
// When it tries to click on anything, then the mouse pointer will actually
// be shown moving, and there should be a little bit of smooth randomness in
// the movement of the pointer, but it will move to the correct, accurate
// position… left click or right click… The scroll functionality will work
// properly too." And for typing: "it will not just outright paste the stuff
// in, but it will type in the stuff… one word at a time. The speed will be
// fast, maybe about 150 words per minute… it will properly utilize the
// Enter button functionality by clicking Shift+Enter on those stages to
// make sure that the formatting is preserved."
//
// ARCHITECTURE: the runtime installs ONCE per page (window.__acuteHands —
// a branded fixed-position SVG cursor + the movement/typing/scroll
// primitives); each action runs as an async JOB (window.__acuteJob) started
// by ONE eval that returns {started:true} instantly (the Rust eval stays
// under its 3s callback budget), and collected by the evalJob BRIDGE
// action (BrowserPanel polls the job state every 120ms until done, ≤25s).
// Every script is CSP-tolerant (element.style.cssText + innerHTML — no
// <style> elements) and ≤ the 20KB Rust eval limit.
//
// ANTI-AUTOMATION posture (the owner: "make it seem like it is being
// performed by some actual person"): bezier-curved cursor paths with
// perpendicular bow + micro-jitter + ease-in-out + post-move settle;
// per-character typing cadence with variance and punctuation pauses +
// occasional think-pauses; events carry full realistic properties
// (screenX/Y, pointerId, detail, buttons). The webview itself has no
// webdriver flag (it is a normal child WebView2, not a CDP target).
// ─────────────────────────────────────────────────────────────────────────────

/** The in-page runtime source — a FUNCTION BODY (runs inside an IIFE the
 * wrapper builds). Idempotent: a page that already has the hands skips the
 * install; a page navigated away re-installs transparently. */
function buildHandsRuntime(): string {
  return `if (window.__acuteHands) return { installed: true };
var rand = function (a, b) { return a + Math.random() * (b - a); };
var CURSOR_ID = "__acute-agent-cursor";
function ensureCursor() {
  var c = document.getElementById(CURSOR_ID);
  if (c !== null) return c;
  c = document.createElement("div");
  c.id = CURSOR_ID;
  c.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;margin:0;padding:0;z-index:2147483647;pointer-events:none;will-change:transform;opacity:0;transition:opacity .25s ease;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));";
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 2.2 18.9 10.6l-6.3 1.1 3 6.6-2.7 1.2-3-6.7-4.9 4.1z" fill="#FF6B2C" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(c);
  return c;
}
var pos = { x: Math.round(window.innerWidth * 0.5), y: Math.round(window.innerHeight * 0.5) };
function paint(x, y) {
  var c = ensureCursor();
  c.style.transform = "translate(" + Math.round(x - 2) + "px," + Math.round(y - 2) + "px)";
  c.style.opacity = "1";
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function describe(el) {
  return { tag: el.tagName.toLowerCase(), text: String(el.textContent || "").trim().slice(0, 80), id: el.id || undefined, href: (el.getAttribute && el.getAttribute("href")) || undefined };
}
function moveCursor(toX, toY, opts) {
  opts = opts || {};
  var from = { x: pos.x, y: pos.y };
  var dx = toX - from.x, dy = toY - from.y;
  var dist = Math.sqrt(dx * dx + dy * dy);
  var dur = Math.max(150, Math.min(900, 170 + dist * 0.8));
  var nx = dist > 1 ? -dy / dist : 0, ny = dist > 1 ? dx / dist : 0;
  var bow = dist > 60 ? rand(-0.16, 0.16) * dist : 0;
  var c1 = { x: from.x + dx * 0.3 + nx * bow, y: from.y + dy * 0.3 + ny * bow };
  var c2 = { x: from.x + dx * 0.7 + nx * bow * 0.35, y: from.y + dy * 0.7 + ny * bow * 0.35 };
  var t0 = performance.now();
  return new Promise(function (resolve) {
    function frame(now) {
      var t = Math.min(1, (now - t0) / dur);
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var u = 1 - e;
      var x = u * u * u * from.x + 3 * u * u * e * c1.x + 3 * u * e * e * c2.x + e * e * e * toX;
      var y = u * u * u * from.y + 3 * u * u * e * c1.y + 3 * u * e * e * c2.y + e * e * e * toY;
      if (t < 1) paint(x + rand(-1.1, 1.1), y + rand(-1.1, 1.1));
      else { pos = { x: toX, y: toY }; paint(toX, toY); }
      if (t < 1) requestAnimationFrame(frame);
      else setTimeout(resolve, opts.settle !== undefined ? opts.settle : rand(30, 90));
    }
    requestAnimationFrame(frame);
  });
}
function fire(el, type, init) {
  var ev;
  try {
    if (type.indexOf("pointer") === 0 && typeof window.PointerEvent === "function") ev = new PointerEvent(type, init);
    else ev = new MouseEvent(type, init);
  } catch (e) { return; }
  el.dispatchEvent(ev);
}
function realClick(x, y, kind) {
  var el = document.elementFromPoint(x, y);
  if (el === null) return { error: "no element is at that point (it may be scrolled away — read_dom again and retry)" };
  var init = { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window,
    screenX: Math.round(x + rand(20, 120)), screenY: Math.round(y + rand(80, 220)),
    button: kind === "right" ? 2 : 0, buttons: 1, detail: kind === "double" ? 2 : 1, relatedTarget: null,
    pointerId: 1, pointerType: "mouse", isPrimary: true, pressure: 0.5 };
  fire(el, "pointerover", init); fire(el, "mouseover", init); fire(el, "mousemove", init);
  fire(el, "pointerdown", init); fire(el, "mousedown", init);
  if (typeof el.focus === "function") { try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} } }
  fire(el, "pointerup", init); fire(el, "mouseup", init);
  if (kind === "right") { fire(el, "contextmenu", init); return { clicked: describe(el), button: "right" }; }
  fire(el, "click", init);
  var out = { clicked: describe(el) };
  if (kind === "double") { fire(el, "mousedown", init); fire(el, "mouseup", init); fire(el, "dblclick", init); out.double = true; }
  return out;
}
function setNativeValue(el, value) {
  var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : (el instanceof HTMLInputElement ? HTMLInputElement.prototype : null);
  if (proto !== null) {
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc !== undefined && desc.set !== undefined) desc.set.call(el, value);
    else el.value = value;
  } else el.textContent = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function typeInto(el, text, wpm) {
  var cps = Math.max(3, ((wpm || 150) * 5) / 60);
  var base = 1000 / cps;
  return (async function () {
    if (typeof el.focus === "function") el.focus();
    el.scrollIntoView({ block: "center", behavior: "instant" });
    try { if (typeof el.select === "function") el.select(); } catch (e) {}
    var inserted = 0, fellBack = false;
    var words = text.match(/\\S+\\s*/g) || (text.length > 0 ? [text] : []);
    for (var w = 0; w < words.length; w++) {
      var word = words[w];
      for (var i = 0; i < word.length; i++) {
        var ch = word[i];
        if (!fellBack) {
          var ok = false;
          try { ok = document.execCommand("insertText", false, ch); } catch (e) { ok = false; }
          if (!ok && inserted === 0) { fellBack = true; }
        }
        if (fellBack) {
          var cur = (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) ? el.value : (el.textContent || "");
          setNativeValue(el, cur + ch);
        }
        inserted += 1;
        var d = base * rand(0.7, 1.5);
        if (ch === " ") d += rand(18, 70);
        else if (".!?;:,".indexOf(ch) >= 0) d += rand(80, 230);
        await sleep(d);
      }
      if (Math.random() < 0.05) await sleep(rand(220, 540));
    }
    return { typed: inserted, fallback: fellBack, wpm: wpm || 150 };
  })();
}
function findScroller(el) {
  var node = el;
  while (node !== null && node !== document.body) {
    if (node.scrollHeight > node.clientHeight + 4 && (getComputedStyle(node).overflowY === "auto" || getComputedStyle(node).overflowY === "scroll")) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}
function smoothScroll(dx, dy, x, y) {
  var target = x !== undefined && x !== null ? document.elementFromPoint(x, y) : null;
  var node = target !== null ? findScroller(target) : (document.scrollingElement || document.documentElement);
  var sx = node.scrollLeft, sy = node.scrollTop;
  var total = Math.max(Math.abs(dx || 0), Math.abs(dy || 0));
  if (total < 1) return Promise.resolve({ scrolled: { dx: 0, dy: 0 }, target: describe(node) });
  var dur = Math.max(160, Math.min(900, 140 + total * 0.45));
  var t0 = performance.now();
  return new Promise(function (resolve) {
    function frame(now) {
      var t = Math.min(1, (now - t0) / dur);
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      node.scrollLeft = sx + Math.round((dx || 0) * e);
      node.scrollTop = sy + Math.round((dy || 0) * e);
      if (t < 1) requestAnimationFrame(frame);
      else resolve({ scrolled: { dx: dx || 0, dy: dy || 0 }, target: describe(node) });
    }
    requestAnimationFrame(frame);
  });
}
window.__acuteJob = null;
window.__acuteHands = {
  moveCursor: moveCursor,
  realClick: realClick,
  typeInto: typeInto,
  smoothScroll: smoothScroll,
  position: function () { return { x: pos.x, y: pos.y }; },
  startJob: function (driver) {
    var job = { done: false, result: null, error: null };
    window.__acuteJob = job;
    Promise.resolve().then(driver).then(
      function (result) { job.result = result; job.done = true; },
      function (err) { job.error = String((err && err.message) || err); job.done = true; }
    );
  }
};
return { installed: true };`;
}

/** Wrap a driver body so the ONE eval installs the runtime (if the page
 * navigated it away), starts the async job, and returns instantly — the
 * evalJob bridge action then collects window.__acuteJob. */
function buildHandsActionScript(driverBody: string): string {
  return `(function () {
  try {
    var installer = (function () { ${buildHandsRuntime()} })();
    var _installed = installer && installer.installed;
    ${driverBody}
    return { started: true };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
})()`;
}

/** The element-finder shared by the click/type drivers — by CSS selector
 * first, then the label/aria/name/placeholder fallbacks (the same matching
 * the pre-R89 scripts used, kept behavior-compatible). */
function buildElementFinder(selector: string, text: string, nth: number, clickable: boolean): string {
  return `var selector = ${JSON.stringify(selector)};
var text = ${JSON.stringify(text)};
var nth = ${JSON.stringify(nth)};
var el = null;
if (selector !== "") {
  el = document.querySelector(selector);
  if (el === null) {
    var needle = selector.toLowerCase();
    var fields = document.querySelectorAll(${clickable ? "'a, button, input[type=submit], input[type=button], [role=button], input, textarea, select'" : "'input, textarea, select, [contenteditable=true], [contenteditable=\"\"]'"});
    for (var f = 0; f < fields.length; f++) {
      var node = fields[f];
      var label = (
        (node.getAttribute("aria-label") || "") + " " +
        (node.getAttribute("name") || "") + " " +
        (node.getAttribute("placeholder") || "") + " " +
        (node.getAttribute("id") || "") + " " +
        (node.getAttribute("title") || "") + " " +
        (node.value !== undefined ? String(node.value || "") : "")
      ).toLowerCase();
      if (label.includes(needle)) { el = node; break; }
    }
  }
} else if (text !== "") {
  var needle2 = text.toLowerCase();
  var nodes = document.querySelectorAll('a, button, input[type=submit], input[type=button], [role="button"], [onclick]');
  var found = [];
  for (var n = 0; n < nodes.length; n++) {
    var node2 = nodes[n];
    var label2 = (
      (node2.textContent || "") + " " +
      (node2.getAttribute("aria-label") || "") + " " +
      (node2.getAttribute("name") || "") + " " +
      (node2.getAttribute("title") || "") + " " +
      (node2.value !== undefined ? String(node2.value || "") : "")
    ).toLowerCase();
    if (label2.includes(needle2)) found.push(node2);
  }
  el = found[nth - 1] || null;
}
if (el === null) throw new Error(selector !== "" ? "no element matches the CSS selector" : "no clickable element's label contains the text");`;
}

/** The click driver: find the element, then the VISIBLE cursor moves to a
 * human-jittered point inside its rect and REAL pointer/click events fire
 * at exactly that spot (the old el.click() teleport is retired). */
export function buildHandsClickScript(selector: string, text: string, nth: number): string {
  return buildHandsActionScript(`window.__acuteHands.startJob(function () {
  ${buildElementFinder(selector, text, nth, true)}
  el.scrollIntoView({ block: "center", behavior: "instant" });
  var r = el.getBoundingClientRect();
  var x = r.left + r.width * (0.28 + Math.random() * 0.44);
  var y = r.top + r.height * (0.28 + Math.random() * 0.44);
  x = Math.max(1, Math.min(window.innerWidth - 2, x));
  y = Math.max(1, Math.min(window.innerHeight - 2, y));
  return window.__acuteHands.moveCursor(x, y).then(function () {
    return window.__acuteHands.realClick(x, y, "left");
  });
});`);
}

/** The type driver: the cursor moves to the field FIRST, then the text is
 * typed WORD BY WORD at ~150 WPM (per-char events, execCommand insertText —
 * React/Vue-visible; the native setter is the fallback). Newlines insert as
 * newlines (the Shift+Enter contract) — submit ONLY via the explicit flag. */
export function buildHandsTypeScript(selector: string, text: string, submit: boolean): string {
  return buildHandsActionScript(`window.__acuteHands.startJob(function () {
  ${buildElementFinder(selector, "", 1, false)}
  el.scrollIntoView({ block: "center", behavior: "instant" });
  var r = el.getBoundingClientRect();
  var x = Math.max(1, Math.min(window.innerWidth - 2, r.left + r.width * 0.5));
  var y = Math.max(1, Math.min(window.innerHeight - 2, r.top + r.height * 0.5));
  var hands = window.__acuteHands;
  return hands.moveCursor(x, y, { settle: 60 }).then(function () {
    try { if (typeof el.focus === "function") el.focus({ preventScroll: true }); } catch (e) {}
    return hands.typeInto(el, ${JSON.stringify(text)}, 150).then(function (typed) {
      var out = { typed: typed, selector: selector };
      if (${JSON.stringify(submit)} === true) {
        var form = el.form || (el.closest ? el.closest("form") : null);
        if (form !== null && typeof form.requestSubmit === "function") {
          form.requestSubmit();
          out.submitted = true;
          out.submitHow = "form.requestSubmit()";
        } else {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          out.submitted = false;
          out.submitHow = "synthetic Enter (no form found — a page key listener may submit)";
        }
      }
      return out;
    });
  });
});`);
}

/** The press_key driver — the visual path (focus follows the cursor) with
 * the A3 Enter→requestSubmit fix kept. */
export function buildHandsPressKeyScript(key: string, selector: string): string {
  return buildHandsActionScript(`window.__acuteHands.startJob(function () {
  var key = ${JSON.stringify(key)};
  var selector = ${JSON.stringify(selector)};
  var keyMap = { enter: 13, tab: 9, escape: 27, esc: 27, backspace: 8, delete: 46, arrowleft: 37, arrowup: 38, arrowright: 39, arrowdown: 40, space: 32 };
  var lower = key.toLowerCase();
  var keyCode = keyMap[lower] !== undefined ? keyMap[lower] : (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  function dispatchKeys(target) {
    var code = key.length === 1 ? (lower === " " ? "Space" : "Key" + key.toUpperCase()) : key;
    var init = { key: key, code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keypress", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    var out = { pressed: key };
    if (key === "Enter" && target.form && typeof target.form.requestSubmit === "function") {
      target.form.requestSubmit();
      out.submitted = true;
    }
    return out;
  }
  var el = null;
  if (selector !== "") {
    el = document.querySelector(selector);
    if (el === null) throw new Error("no element matches the selector");
    el.scrollIntoView({ block: "center", behavior: "instant" });
    var r = el.getBoundingClientRect();
    var x = Math.max(1, Math.min(window.innerWidth - 2, r.left + r.width * 0.5));
    var y = Math.max(1, Math.min(window.innerHeight - 2, r.top + r.height * 0.5));
    var hands = window.__acuteHands;
    return hands.moveCursor(x, y, { settle: 40 }).then(function () {
      try { if (typeof el.focus === "function") el.focus({ preventScroll: true }); } catch (e) {}
      return dispatchKeys(el);
    });
  }
  el = document.activeElement || document.body;
  return dispatchKeys(el);
});`);
}

/** The mouse driver — the explicit pointer-control ops the owner asked for:
 * move (hover), click / double / right, drag, scroll. Coordinates are PAGE
 * CSS pixels — exactly what read_dom's x/y/w/h report. */
export function buildHandsMouseScript(
  op: "move" | "click" | "double" | "right" | "drag" | "scroll",
  x: number | null,
  y: number | null,
  toX: number | null,
  toY: number | null,
  dx: number | null,
  dy: number | null,
): string {
  return buildHandsActionScript(`window.__acuteHands.startJob(function () {
  var hands = window.__acuteHands;
  var op = ${JSON.stringify(op)};
  var x = ${x === null ? "null" : String(x)};
  var y = ${y === null ? "null" : String(y)};
  var toX = ${toX === null ? "null" : String(toX)};
  var toY = ${toY === null ? "null" : String(toY)};
  var dx = ${dx === null ? "null" : String(dx)};
  var dy = ${dy === null ? "null" : String(dy)};
  var clampX = function (v) { return Math.max(1, Math.min(window.innerWidth - 2, v)); };
  var clampY = function (v) { return Math.max(1, Math.min(window.innerHeight - 2, v)); };
  if (op === "move" || op === "click" || op === "double" || op === "right") {
    if (typeof x !== "number" || typeof y !== "number") throw new Error("mouse " + op + " requires x and y (page CSS px — use read_dom's positions)");
    var tx = clampX(x), ty = clampY(y);
    return hands.moveCursor(tx, ty).then(function () {
      if (op === "move") return { moved: { x: tx, y: ty } };
      return hands.realClick(tx, ty, op === "double" ? "double" : op === "right" ? "right" : "left");
    });
  }
  if (op === "drag") {
    if (typeof x !== "number" || typeof y !== "number" || typeof toX !== "number" || typeof toY !== "number") throw new Error("mouse drag requires x, y (start) and toX, toY (end)");
    var fx = clampX(x), fy = clampY(y), ex = clampX(toX), ey = clampY(toY);
    return hands.moveCursor(fx, fy).then(function () {
      var el = document.elementFromPoint(fx, fy);
      if (el === null) throw new Error("no element at the drag start point");
      var init = { clientX: fx, clientY: fy, bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, detail: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
      var dispatch = function (target, type, over) {
        var e = (type.indexOf("pointer") === 0 && typeof window.PointerEvent === "function")
          ? new PointerEvent(type, over) : new MouseEvent(type, over);
        target.dispatchEvent(e);
      };
      dispatch(el, "pointerdown", init);
      dispatch(el, "mousedown", init);
      var t0 = performance.now();
      var dur = Math.max(180, Math.min(900, 200 + Math.sqrt((ex - fx) * (ex - fx) + (ey - fy) * (ey - fy)) * 0.8));
      return new Promise(function (resolve) {
        function frame(now) {
          var t = Math.min(1, (now - t0) / dur);
          var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          var cx = fx + (ex - fx) * e, cy = fy + (ey - fy) * e;
          var over = document.elementFromPoint(cx, cy) || el;
          var mover = { clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, detail: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
          dispatch(over, "pointermove", mover);
          dispatch(over, "mousemove", mover);
          if (t < 1) requestAnimationFrame(frame);
          else {
            dispatch(over, "pointerup", mover);
            dispatch(over, "mouseup", mover);
            resolve({ dragged: { from: { x: fx, y: fy }, to: { x: ex, y: ey } } });
          }
        }
        requestAnimationFrame(frame);
      });
    });
  }
  if (op === "scroll") {
    var sdx = typeof dx === "number" ? dx : 0;
    var sdy = typeof dy === "number" ? dy : 0;
    if (sdx === 0 && sdy === 0) throw new Error("mouse scroll requires dx and/or dy (pixels — positive scrolls down/right)");
    return hands.smoothScroll(sdx, sdy, typeof x === "number" ? clampX(x) : null, typeof y === "number" ? clampY(y) : null);
  }
  throw new Error("unknown mouse op: " + op);
});`);
}
