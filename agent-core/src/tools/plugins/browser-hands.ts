// ─────────────────────────────────────────────────────────────────────────────
// ROUND-89 (R89-E) → ROUND-90 (R90-D1): THE AGENT HANDS v2 — the visible,
// human-like input engine.
//
// The owner's R89 directive (delivered): "give it full-fledged capabilities…
// access to control the mouse pointer. It will be given its own custom mouse
// pointer… When it tries to click on anything, then the mouse pointer will
// actually be shown moving, and there should be a little bit of smooth
// randomness in the movement of the pointer… left click or right click… The
// scroll functionality will work properly too." Typing: "one word at a time…
// about 150 words per minute… properly utilize the Enter button
// functionality by clicking Shift+Enter… so that the formatting is
// preserved."
//
// The owner's R90 verdicts (this round):
//  · "The mouse pointer should ALWAYS be visible. It should not go away" —
//    the native webview now carries the BOOT SCRIPT as its initialization
//    script (src-tauri browser_tab_create's hands_init_script ← the main
//    app's src/lib/agent-hands-boot.ts), so every page paints the resting
//    cursor from document creation; the runtime below ADOPTS it (the
//    `window.__acuteHandsRest` handoff) instead of teleporting.
//  · "The mouse movement was not natural… precise, going in straight lines…
//    there should also be a little bit of fallback behavior… it will go a
//    little bit further away and then return back" — moveCursor v2: the
//    HUMAN PATH PLANNER (overshoot-and-return, mid-flight hesitation,
//    two-segment long moves) + a REAL pointermove/mousemove TRAIL with
//    over/out on element changes (hover menus open — the dropdown fix).
//  · "It should click, then after 1 second, it should start typing, not
//    instantly" + "the Enter button… should be clicked after the typing has
//    finished and after 1 second" — the type driver: TAP the field → a
//    0.7–1.3s beat → type word-by-word → (submit) a 0.8–1.4s beat → the
//    full synthetic Enter sequence + requestSubmit.
//  · "The mouse pointer was not apparently clicking anything at all…
//    the clicks apparently were happening, but it did not look natural" —
//    realClick v2: a settle micro-move onto the point, a VISIBLE press
//    pulse (the cursor squashes + springs back), a real 60–140ms
//    mousedown→mouseup duration.
//
// ARCHITECTURE (unchanged from R89-E): the runtime installs ONCE per page
// (window.__acuteHands — a branded fixed-position SVG cursor + the
// movement/typing/scroll primitives); each action runs as an async JOB
// (window.__acuteJob) started by ONE eval that returns {started:true}
// instantly (the Rust eval stays under its 3s callback budget), and collected
// by the evalJob BRIDGE action (BrowserPanel polls the job state every 120ms
// until done, ≤25s). Every script is CSP-tolerant (element.style.cssText +
// innerHTML — no <style> elements) and ≤ the 20KB Rust eval limit.
//
// ANTI-AUTOMATION posture (the owner: "make it seem like it is being
// performed by some actual person"): bezier-curved cursor paths with
// perpendicular bow + micro-jitter + ease-in-out + post-move settle +
// overshoot/hesitation; a REAL event trail (pointermove/mousemove at cursor
// speed + hover over/out) so hover-driven menus and bot heuristics see a
// moving mouse; per-character typing cadence with variance and punctuation
// pauses + occasional think-pauses; events carry full realistic properties
// (screenX/Y, pointerId, detail, buttons). The webview itself has no
// webdriver flag (it is a normal child WebView2, not a CDP target).
// ─────────────────────────────────────────────────────────────────────────────

/** The in-page runtime source — a FUNCTION BODY (runs inside an IIFE the
 * wrapper builds). Idempotent: a page that already has the hands skips the
 * install; a page navigated away re-installs transparently. R90-D1: a page
 * that was BOOTED by the webview's initialization script (the always-visible
 * cursor) is ADOPTED — the initial position comes from
 * `window.__acuteHandsRest`, so the first move starts from where the eye
 * already saw the cursor instead of teleporting from the viewport center. */
function buildHandsRuntime(): string {
  return `if (window.__acuteHands) return { installed: true, adopted: true };
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
var booted = window.__acuteHandsRest || null; // R90-D1: the boot script's resting spot
var pos = booted !== null
  ? { x: booted.x, y: booted.y }
  : { x: Math.round(window.innerWidth * 0.5), y: Math.round(window.innerHeight * 0.5) };
function paint(x, y, scale) {
  var c = ensureCursor();
  var s = scale === undefined ? 1 : scale;
  c.style.transform = "translate(" + Math.round(x - 2) + "px," + Math.round(y - 2) + "px)" + (s !== 1 ? " scale(" + s + ")" : "");
  c.style.opacity = "1";
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function describe(el) {
  return { tag: el.tagName.toLowerCase(), text: String(el.textContent || "").trim().slice(0, 80), id: el.id || undefined, href: (el.getAttribute && el.getAttribute("href")) || undefined };
}
// ── R90-D1: the REAL EVENT TRAIL — a moving mouse fires pointermove/
// mousemove + hover over/out; hover-driven menus open (the dropdown fix).
var lastTrailEl = null;
function trailEvent(type, x, y, el) {
  var ev;
  try {
    if (type.indexOf("pointer") === 0 && typeof window.PointerEvent === "function") {
      ev = new PointerEvent(type, { clientX: x, clientY: y, screenX: Math.round(x + rand(20, 120)), screenY: Math.round(y + rand(80, 220)), bubbles: true, cancelable: true, view: window, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0, pressure: 0 });
    } else {
      ev = new MouseEvent(type, { clientX: x, clientY: y, screenX: Math.round(x + rand(20, 120)), screenY: Math.round(y + rand(80, 220)), bubbles: true, cancelable: true, view: window, buttons: 0 });
    }
  } catch (e) { return; }
  el.dispatchEvent(ev);
}
function dispatchTrail(x, y) {
  var el = null;
  try { el = document.elementFromPoint(x, y); } catch (e) { el = null; }
  if (el === null) { lastTrailEl = null; return; }
  if (el !== lastTrailEl) {
    if (lastTrailEl !== null) {
      trailEvent("pointerout", x, y, lastTrailEl);
      trailEvent("mouseout", x, y, lastTrailEl);
    }
    trailEvent("pointerover", x, y, el);
    trailEvent("mouseover", x, y, el);
    lastTrailEl = el;
  }
  trailEvent("pointermove", x, y, el);
  trailEvent("mousemove", x, y, el);
}
// ── R90-D1: the HUMAN PATH PLANNER — one eased bezier leg (micro-jitter,
// trail-dispatching) per frame.
function bezierOf(from, to, opts) {
  opts = opts || {};
  var dx = to.x - from.x, dy = to.y - from.y;
  var dist = Math.sqrt(dx * dx + dy * dy);
  var dur = opts.dur !== undefined ? opts.dur : Math.max(150, Math.min(900, 170 + dist * 0.8));
  var nx = dist > 1 ? -dy / dist : 0, ny = dist > 1 ? dx / dist : 0;
  var bow = opts.bow !== undefined ? opts.bow : (dist > 60 ? rand(-0.16, 0.16) * dist : 0);
  var c1 = { x: from.x + dx * 0.3 + nx * bow, y: from.y + dy * 0.3 + ny * bow };
  var c2 = { x: from.x + dx * 0.7 + nx * bow * 0.35, y: from.y + dy * 0.7 + ny * bow * 0.35 };
  var t0 = performance.now();
  return new Promise(function (resolve) {
    function frame(now) {
      var t = Math.min(1, (now - t0) / dur);
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var u = 1 - e;
      var x = u * u * u * from.x + 3 * u * u * e * c1.x + 3 * u * e * e * c2.x + e * e * e * to.x;
      var y = u * u * u * from.y + 3 * u * u * e * c1.y + 3 * u * e * e * c2.y + e * e * e * to.y;
      if (t < 1) {
        var jx = x + rand(-1.1, 1.1), jy = y + rand(-1.1, 1.1);
        paint(jx, jy);
        dispatchTrail(jx, jy);
        requestAnimationFrame(frame);
      } else {
        paint(to.x, to.y);
        dispatchTrail(to.x, to.y);
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}
// moveCursor v2 — the owner's randomness: OVERSHOOT-AND-RETURN (~45% of
// moves > 90px: sail past, a beat, land), HESITATION (~22% of moves > 200px:
// a mid-flight re-aim), ARRIVAL SETTLE (30–90ms stillness).
function moveCursor(toX, toY, opts) {
  opts = opts || {};
  var from = { x: pos.x, y: pos.y };
  var to = { x: toX, y: toY };
  var dx = to.x - from.x, dy = to.y - from.y;
  var dist = Math.sqrt(dx * dx + dy * dy);
  pos = { x: toX, y: toY };
  var legs = [];
  if (dist > 200 && Math.random() < 0.22) {
    var mid = { x: from.x + dx * 0.62 + rand(-14, 14), y: from.y + dy * 0.62 + rand(-10, 10) };
    legs.push({ to: mid, dur: Math.max(140, Math.min(560, 150 + dist * 0.4)), pause: rand(60, 160) });
    legs.push({ to: to, dur: Math.max(120, Math.min(420, 140 + dist * 0.25)) });
  } else if (dist > 90 && Math.random() < 0.45) {
    var ux = dist > 1 ? dx / dist : 1, uy = dist > 1 ? dy / dist : 0;
    var over = dist + rand(14, 42);
    var past = { x: from.x + ux * over, y: from.y + uy * over };
    past.x = Math.max(2, Math.min(window.innerWidth - 2, past.x));
    past.y = Math.max(2, Math.min(window.innerHeight - 2, past.y));
    legs.push({ to: past, dur: Math.max(150, Math.min(760, 170 + over * 0.7)), bow: rand(-0.1, 0.1) * over, sloppy: true });
    legs.push({ to: to, dur: Math.max(90, Math.min(240, 100 + (over - dist) * 2)), pause: rand(40, 110) });
  } else {
    legs.push({ to: to });
  }
  var run = 0;
  return (async function () {
    var cur = from;
    for (var i = 0; i < legs.length; i++) {
      if (legs[i].pause !== undefined) await sleep(legs[i].pause);
      await bezierOf(cur, legs[i].to, legs[i]);
      cur = legs[i].to;
      run++;
    }
    await sleep(opts.settle !== undefined ? opts.settle : rand(30, 90));
    return { moved: { x: toX, y: toY }, legs: run };
  })();
}
function fire(el, type, init) {
  var ev;
  try {
    if (type.indexOf("pointer") === 0 && typeof window.PointerEvent === "function") ev = new PointerEvent(type, init);
    else ev = new MouseEvent(type, init);
  } catch (e) { return; }
  el.dispatchEvent(ev);
}
// realClick v2 — the owner: "the mouse pointer was not apparently clicking
// anything at all… the clicks apparently were happening, but it did not
// look natural". The click is now a LITTLE PERFORMANCE the eye can read:
// 1. a 2–3px settle micro-move onto the exact point (the hand zeroing in),
// 2. pointerover/over + a burst of pointermove/mousemove,
// 3. mousedown with a VISIBLE PRESS PULSE (the cursor squashes to 0.82 and
//    springs back — a real finger's feedback),
// 4. a genuine 60–140ms held duration before pointerup,
// 5. the click, then a 20–60ms post-click stillness.
function realClick(x, y, kind) {
  var el = document.elementFromPoint(x, y);
  if (el === null) return { error: "no element is at that point (it may be scrolled away — read_dom again and retry)" };
  return (async function () {
    var init = { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window,
      screenX: Math.round(x + rand(20, 120)), screenY: Math.round(y + rand(80, 220)),
      button: kind === "right" ? 2 : 0, buttons: 1, detail: kind === "double" ? 2 : 1, relatedTarget: null,
      pointerId: 1, pointerType: "mouse", isPrimary: true, pressure: 0.5 };
    // The settle micro-move (2–3px onto the point).
    await bezierOf({ x: pos.x, y: pos.y }, { x: x, y: y }, { dur: rand(90, 170), bow: rand(-4, 4) });
    fire(el, "pointerover", init); fire(el, "mouseover", init);
    dispatchTrail(x, y);
    fire(el, "pointerdown", init); fire(el, "mousedown", init);
    paint(x, y, 0.82); // the press pulse — the visible squash
    if (typeof el.focus === "function") { try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} } }
    await sleep(rand(60, 140)); // the held duration
    paint(x, y, 1); // the spring-back
    fire(el, "pointerup", init); fire(el, "mouseup", init);
    if (kind === "right") { fire(el, "contextmenu", init); return { clicked: describe(el), button: "right" }; }
    fire(el, "click", init);
    var out = { clicked: describe(el) };
    if (kind === "double") {
      await sleep(rand(70, 120));
      fire(el, "mousedown", init); fire(el, "mouseup", init); fire(el, "dblclick", init);
      out.double = true;
    }
    await sleep(rand(20, 60));
    return out;
  })();
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
    el.scrollIntoView({ block: "center", behavior: "instant" });
    if (typeof el.focus === "function") el.focus();
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
// rest() — park the cursor at a natural resting spot (the lower-right a
// hand drifts to). The boot script does this at page load; the runtime
// exposes it so an explicit "stop" can look human too.
function rest() {
  var x = Math.round(window.innerWidth * rand(0.60, 0.78));
  var y = Math.round(window.innerHeight * rand(0.66, 0.86));
  window.__acuteHandsRest = { x: x, y: y };
  paint(x, y);
  return { rested: { x: x, y: y } };
}
window.__acuteJob = null;
window.__acuteHands = {
  moveCursor: moveCursor,
  realClick: realClick,
  typeInto: typeInto,
  smoothScroll: smoothScroll,
  rest: rest,
  sleep: sleep, // R90-D1: the driver primitives (the human beats)

  rand: rand,
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
// R90-D1: paint the boot's resting spot so the visual matches the logical.
if (booted !== null) paint(booted.x, booted.y);
return { installed: true, adopted: booted !== null };`;
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
 * at exactly that spot (the old el.click() teleport is retired). R90-D1:
 * the move itself is the full human path (overshoot/hesitation/trail) and
 * realClick performs the visible press pulse + held duration. */
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

/**
 * The type driver v2 (R90-D1, the owner: "It taps on the input bars and
 * then types in them… It should click, then after 1 second, it should start
 * typing, not instantly after clicking. The same goes for the Enter button
 * too: it should be clicked after the typing has finished and after 1
 * second has passed after that").
 *
 * The full human sequence:
 *  1. MOVE to the field (the full human path — overshoot/hesitation/trail),
 *  2. TAP it (realClick — the visible press, and the natural focus),
 *  3. a 0.7–1.3s BEAT (a person reading the field they just tapped),
 *  4. TYPE word-by-word at ~150 WPM (per-char events, execCommand
 *     insertText — React/Vue-visible; the native setter is the fallback;
 *     newlines insert as newlines — the Shift+Enter contract, submit ONLY
 *     via the explicit flag),
 *  5. submit=true: a 0.8–1.4s beat, then the full synthetic ENTER sequence
 *     (keydown/keypress/keyup — the page's listeners + analytics see it),
 *     then requestSubmit() on the owning form ~100ms later (synthetic
 *     events cannot trigger NATIVE form submission — the A3 lesson).
 */
export function buildHandsTypeScript(selector: string, text: string, submit: boolean): string {
  return buildHandsActionScript(`window.__acuteHands.startJob(function () {
  ${buildElementFinder(selector, "", 1, false)}
  el.scrollIntoView({ block: "center", behavior: "instant" });
  var r = el.getBoundingClientRect();
  var x = Math.max(1, Math.min(window.innerWidth - 2, r.left + r.width * 0.5));
  var y = Math.max(1, Math.min(window.innerHeight - 2, r.top + r.height * 0.5));
  var hands = window.__acuteHands;
  return hands.moveCursor(x, y, { settle: hands.rand(60, 160) }).then(function () {
    // THE TAP — the owner's "it taps on the input bars" (the pre-R90 driver
    // only focused the field: the owner saw typing "without a tap").
    return hands.realClick(x, y, "left").then(function (clickOut) {
      if (clickOut !== undefined && clickOut.error !== undefined) throw new Error(clickOut.error);
      // THE BEAT between tap and typing (the owner's "after 1 second").
      return hands.sleep(hands.rand(700, 1300)).then(function () {
        return hands.typeInto(el, ${JSON.stringify(text)}, 150).then(function (typed) {
          var out = { typed: typed, tapped: true, selector: selector };
          if (${JSON.stringify(submit)} === true) {
            // THE BEAT between typing and Enter (the owner's "after the
            // typing has finished and after 1 second has passed").
            return hands.sleep(hands.rand(800, 1400)).then(function () {
              var enterInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
              el.dispatchEvent(new KeyboardEvent("keydown", enterInit));
              el.dispatchEvent(new KeyboardEvent("keypress", enterInit));
              el.dispatchEvent(new KeyboardEvent("keyup", enterInit));
              out.enterPressed = true;
              var form = el.form || (el.closest ? el.closest("form") : null);
              if (form !== null && typeof form.requestSubmit === "function") {
                return hands.sleep(hands.rand(90, 150)).then(function () {
                  form.requestSubmit();
                  out.submitted = true;
                  out.submitHow = "synthetic Enter + form.requestSubmit()";
                  return out;
                });
              }
              out.submitted = false;
              out.submitHow = "synthetic Enter (no form found — a page key listener may submit)";
              return out;
            });
          }
          return out;
        });
      });
    });
  });
});`);
}

/** The press_key driver — the visual path (focus follows the cursor) with
 * the A3 Enter→requestSubmit fix kept. R90-D1: key presses now also carry
 * a small pre-press settle so they don't land mid-animation. */
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
    return hands.moveCursor(x, y, { settle: hands.rand(80, 200) }).then(function () {
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
 * CSS pixels — exactly what read_dom's x/y/w/h report. R90-D1: every move is
 * the full human path; the trail fires real hover events along the way. */
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
