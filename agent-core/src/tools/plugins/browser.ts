/**
 * ROUND-52 (R52-f): the BROWSER plugin — browser_control, moved VERBATIM from
 * tools/index.ts buildProjectTools (the embedded-browser panel driver with
 * host-gated navigation).
 *
 * ROUND-62 (D8, owner: "the ai agent can interact with the right sidebar
 * browser — navigate it, screenshot it, use it and such… change the view,
 * the dimensions, the scale… get the status"): the tool grew from a
 * navigation/viewport driver into a full agent-browser surface:
 *   · read       — the current page's text, fetched server-side (any mode);
 *   · eval       — run JavaScript INSIDE the live page (native WebView2 only,
 *                  via the SSE→UI→Rust browser-command bridge) — click links,
 *                  fill forms, read the DOM the user is watching;
 *   · screenshot — capture the browser panel's on-screen region through the
 *                  computer-use backends + describe it with the (separate or
 *                  main) vision model; needs Computer Use enabled;
 *   · get_state  — now with the session list (every open tab) + active tab.
 * The pre-R62 actions (navigate/back/forward/reload/set_viewport) are
 * byte-identical in behavior.
 *
 * ROUND-66 (R66, the owner's 0.65.0 live-fire report):
 *   · A3 — "the agent typed a Google query but never submitted": the new
 *     click / type(submit:true) / press_key(Enter → form.requestSubmit())
 *     actions drive REAL page elements through the eval bridge, with the
 *     native value setter + input/change events so React/Vue pages notice;
 *   · A4 — bot-wall detection (captcha/Cloudflare/age): navigate/read probe
 *     the page and append a ⚠ note; wait_for_verification opens a
 *     human-solvable checkpoint (browser-checkpoint.ts) — a countdown card
 *     in the owner's chat while the tool waits;
 *   · A6 — full page content WITHOUT screenshots: read_dom (a structured
 *     page outline) + source (html | css | scripts);
 *   · A5 — set_viewport now ALSO emits the instant-apply "browser-viewport"
 *     frame (the frontend applies it live; the 4s poll is the backfill);
 *   · A1 — the screenshot action NO LONGER records into the computer-use
 *     session ring (browser work must never show "agent is using your
 *     computer" — that monitor is computer-use-only).
 */
import { jsonSchema } from "ai";
import {
  VIEWPORT_PRESETS,
  browserActiveTabSessionId,
  browserGetStateCommand,
  browserListSessionsCommand,
  browserNavigateCommand,
  browserViewportCommand,
} from "../../browser-proxy.js";
import { sendBrowserCommand } from "../../browser-command.js";
import { detectVerificationWall, openBrowserCheckpoint } from "../../browser-checkpoint.js";
import type { VerificationWallHit } from "../../browser-checkpoint.js";
import { requestWebFetchApproval } from "../../approvals.js";
import { buildApprovalDeps } from "../approval-deps.js";
import { getActiveComputerRelay } from "./computer-relay.js";
import { relayVision } from "./computer-use.js";
import { webFetch } from "../web.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

// ─────────────────── R66 (A3/A6): the page-script builders ─────────────────
//
// click / type / press_key / source / read_dom each compile to ONE eval
// script (sent through the browser-command bridge exactly like the raw eval
// action; the Rust command wraps it in a function body, hence the `return`).
// USER INPUT is embedded ONLY via JSON.stringify — never string-concatenated
// into the script (injection safety; a selector or text containing quotes
// becomes a safely-escaped JS string literal).

/** click: one element by CSS selector, or by a text-substring label match. */
function buildClickScript(selector: string, text: string, nth: number): string {
  return `const selector = ${JSON.stringify(selector)};
const text = ${JSON.stringify(text)};
const nth = ${JSON.stringify(nth)};
let el = null;
let matched = 0;
if (selector !== "") {
  el = document.querySelector(selector);
} else {
  const needle = text.toLowerCase();
  const nodes = document.querySelectorAll('a, button, input[type=submit], input[type=button], [role="button"], [onclick]');
  const found = [];
  for (const node of nodes) {
    const label = (
      (node.textContent || "") + " " +
      (node.getAttribute("aria-label") || "") + " " +
      (node.getAttribute("name") || "") + " " +
      (node.getAttribute("title") || "") + " " +
      (node.value !== undefined ? String(node.value || "") : "")
    ).toLowerCase();
    if (label.includes(needle)) found.push(node);
  }
  matched = found.length;
  el = found[nth - 1] || null;
}
if (el === null) {
  return { error: selector !== "" ? "no element matches the CSS selector" : "no clickable element's label contains the text (" + matched + " matched)" };
}
el.scrollIntoView({ block: "center", behavior: "instant" });
el.click();
return { clicked: {
  tag: el.tagName.toLowerCase(),
  text: String(el.textContent || "").trim().slice(0, 80),
  href: el.getAttribute("href") || undefined,
  id: el.id || undefined,
}};`;
}

/**
 * type: set an input's value the way FRAMEWORKS notice — the NATIVE value
 * setter (HTMLInputElement/HTMLTextAreaElement prototype descriptor) plus
 * dispatched input/change events (React/Vue override the value property, so
 * `el.value = x` alone is invisible to them). submit:true → the form's
 * requestSubmit() (native submission incl. handlers) or, without a form, a
 * synthetic Enter keydown (best effort — a JS key listener may submit).
 */
function buildTypeScript(selector: string, text: string, submit: boolean): string {
  return `const selector = ${JSON.stringify(selector)};
const text = ${JSON.stringify(text)};
const submit = ${JSON.stringify(submit)};
let el = document.querySelector(selector);
if (el === null) {
  const needle = selector.toLowerCase();
  const fields = document.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
  for (const node of fields) {
    const label = (
      (node.getAttribute("aria-label") || "") + " " +
      (node.getAttribute("name") || "") + " " +
      (node.getAttribute("placeholder") || "") + " " +
      (node.getAttribute("id") || "") + " " +
      (node.getAttribute("title") || "")
    ).toLowerCase();
    if (label.includes(needle)) { el = node; break; }
  }
}
if (el === null) return { error: "no element matches the selector (CSS, or an input matching it by aria-label/name/placeholder/id substring)" };
el.focus();
const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : (el instanceof HTMLInputElement ? HTMLInputElement.prototype : null);
if (proto !== null) {
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc !== undefined && desc.set !== undefined) desc.set.call(el, text);
  else el.value = text;
} else if (el.isContentEditable === true) {
  el.textContent = text;
} else {
  el.value = text;
}
el.dispatchEvent(new Event("input", { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));
let submitted = false;
let submitHow = "";
if (submit === true) {
  const form = el.form || null;
  if (form !== null && typeof form.requestSubmit === "function") {
    form.requestSubmit();
    submitted = true;
    submitHow = "form.requestSubmit()";
  } else {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    submitHow = "synthetic Enter keydown (no form found — a page key listener may still submit)";
  }
}
return { typed: selector, submitted, submitHow };`;
}

/**
 * press_key: dispatch keydown/keypress/keyup to the selector's element (or
 * the focused one). SPECIAL RULE — key "Enter" on an element inside a form
 * ALSO calls form.requestSubmit(): synthetic KeyboardEvents NEVER trigger
 * native form submission (the browser only submits on REAL trusted keys), so
 * without this the Enter key would be a no-op on a search box — THE Google
 * search bug (A3).
 */
function buildPressKeyScript(key: string, selector: string): string {
  return `const key = ${JSON.stringify(key)};
const selector = ${JSON.stringify(selector)};
const keyMap = { enter: 13, tab: 9, escape: 27, esc: 27, backspace: 8, delete: 46, arrowleft: 37, arrowup: 38, arrowright: 39, arrowdown: 40, space: 32 };
const lower = key.toLowerCase();
const keyCode = keyMap[lower] !== undefined ? keyMap[lower] : (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
if (selector !== "") {
  const target = document.querySelector(selector);
  if (target === null) return { error: "no element matches the selector" };
  if (typeof target.focus === "function") target.focus();
}
const el = document.activeElement || document.body;
const code = key.length === 1 ? (lower === " " ? "Space" : "Key" + key.toUpperCase()) : key;
const init = { key: key, code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true };
el.dispatchEvent(new KeyboardEvent("keydown", init));
el.dispatchEvent(new KeyboardEvent("keypress", init));
el.dispatchEvent(new KeyboardEvent("keyup", init));
let submitted = false;
if (key === "Enter" && el.form && typeof el.form.requestSubmit === "function") {
  el.form.requestSubmit();
  submitted = true;
}
return { pressed: key, submitted };`;
}

/** source: the page's html (outerHTML), css (stylesheets + computed style),
 * or scripts (src list + inline bodies). The total is capped INSIDE the
 * script at maxChars (slice + honest truncation marker). */
function buildSourceScript(part: string, selector: string, maxChars: number): string {
  return `const part = ${JSON.stringify(part)};
const selector = ${JSON.stringify(selector)};
const maxChars = ${JSON.stringify(maxChars)};
const cap = (s) => (s.length > maxChars ? s.slice(0, maxChars) + "\\n…(truncated " + (s.length - maxChars) + " chars — raise maxChars up to 20000)" : s);
if (part === "html") {
  const el = selector !== "" ? document.querySelector(selector) : document.body;
  if (el === null) return { error: "no element matches the selector" };
  return { part: part, selector: selector, chars: el.outerHTML.length, content: cap(el.outerHTML) };
}
if (part === "css") {
  const chunks = [];
  const walk = (rules, depth) => {
    if (depth > 3) return;
    for (const rule of rules) {
      try {
        if (rule.selectorText !== undefined && rule.style !== undefined) {
          chunks.push(rule.selectorText + " { " + rule.style.cssText + " }");
        } else if (rule.cssRules !== undefined && rule.cssRules !== null) {
          chunks.push("/* " + (rule.conditionText !== undefined ? rule.conditionText : "nested rules") + " */");
          walk(rule.cssRules, depth + 1);
        } else if (rule.cssText !== undefined) {
          chunks.push(rule.cssText);
        }
      } catch (e) { /* one bad rule never kills the dump */ }
    }
  };
  let skipped = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules, 0);
    } catch (e) {
      skipped += 1;
    }
  }
  if (selector !== "") {
    const el = document.querySelector(selector);
    if (el === null) return { error: "no element matches the selector" };
    const cs = getComputedStyle(el);
    const lines = [];
    for (let i = 0; i < cs.length; i++) {
      const prop = cs.item(i);
      lines.push(prop + ": " + cs.getPropertyValue(prop) + ";");
    }
    chunks.push("/* computed style of " + selector + " */\\n" + lines.join(" "));
  }
  const text = chunks.join("\\n") + (skipped > 0 ? "\\n/* " + skipped + " stylesheet(s) skipped: cross-origin or inaccessible */" : "");
  return { part: part, selector: selector, chars: text.length, content: cap(text) };
}
if (part === "scripts") {
  const items = [];
  for (const s of Array.from(document.scripts)) {
    if (s.src) items.push({ src: s.src });
    else items.push({ inline: String(s.textContent || "").slice(0, 2000) });
  }
  const text = JSON.stringify(items);
  return { part: part, scripts: items.length, chars: text.length, content: cap(text) };
}
return { error: "part must be html, css or scripts" };`;
}

/**
 * read_dom: a STRUCTURED page outline as tight, model-readable JSON — title,
 * url, headings, every VISIBLE interactive element (with a short
 * tag:nth-of-type selector path anchored at the closest id-bearing ancestor,
 * ≤6 hops) and the forms with their field names. include "all" adds the
 * first 80 text blocks (the page's paragraphs). This is the owner's "know
 * the page content without screenshots" capability (A6).
 */
function buildReadDomScript(include: "interactive" | "all"): string {
  return `const include = ${JSON.stringify(include)};
const clip = (s, n) => { const t = String(s || "").replace(/\\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) : t; };
const seg = (node) => {
  let n = 1;
  let sib = node.previousElementSibling;
  while (sib !== null) { if (sib.tagName === node.tagName) n += 1; sib = sib.previousElementSibling; }
  return node.tagName.toLowerCase() + ":nth-of-type(" + n + ")";
};
const shortPath = (el) => {
  const parts = [];
  let node = el;
  while (node !== null && node.nodeType === 1 && parts.length < 6) {
    if (node.id !== "") { parts.unshift("#" + node.id); break; }
    parts.unshift(seg(node));
    if (node === document.body) break;
    node = node.parentElement;
  }
  return parts.join(" > ");
};
const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const headings = [];
for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
  const text = clip(h.textContent, 80);
  if (text !== "") headings.push({ tag: h.tagName.toLowerCase(), text: text });
  if (headings.length >= 40) break;
}
const interactive = [];
const nodes = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="combobox"], [role="option"], [onclick], [contenteditable="true"]');
for (const el of nodes) {
  if (!visible(el)) continue;
  const r = el.getBoundingClientRect();
  interactive.push({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || undefined,
    text: clip(el.textContent, 60) || undefined,
    ariaLabel: clip(el.getAttribute("aria-label"), 60) || undefined,
    value: (el.value !== undefined ? clip(el.value, 60) : undefined) || undefined,
    placeholder: clip(el.getAttribute("placeholder"), 60) || undefined,
    selector: shortPath(el),
    rect: { w: Math.round(r.width), h: Math.round(r.height) },
  });
  if (interactive.length >= 120) break;
}
const forms = [];
for (const form of Array.from(document.forms)) {
  const fields = [];
  for (const field of form.querySelectorAll("input, select, textarea, button")) {
    const name = field.getAttribute("name") || field.id;
    if (name) fields.push(name);
  }
  forms.push({ action: form.getAttribute("action") || form.action || "", method: (form.getAttribute("method") || "get").toLowerCase(), fields: fields });
}
let paragraphs = undefined;
if (include === "all") {
  paragraphs = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const seen = new Set();
  let node = walker.nextNode();
  while (node !== null && paragraphs.length < 80) {
    const parent = node.parentElement;
    if (parent !== null && !seen.has(parent)) {
      seen.add(parent);
      const text = clip(parent.textContent, 160);
      if (text !== "") paragraphs.push(text);
    }
    node = walker.nextNode();
  }
}
return { title: clip(document.title, 120), url: location.href, headings: headings, interactive: interactive, forms: forms, paragraphs: paragraphs };`;
}

/**
 * R66 (A4): the WALL PROBE — a tiny read-only eval script the navigate /
 * wait_for_verification actions run in the LIVE page: the title, the first
 * 4000 chars of visible text, and which bot-wall WIDGETS are present (their
 * marker names are detectVerificationWall markers, so the detector below
 * trips on them). No user input — a constant script.
 */
const WALL_PROBE_SCRIPT = `const title = document.title || "";
const text = (document.body ? document.body.innerText || "" : "").slice(0, 4000);
const markers = [];
const probe = (sel) => { try { return document.querySelector(sel) !== null; } catch (e) { return false; } };
if (probe('iframe[src*="recaptcha"]') || probe(".g-recaptcha") || probe("#g-recaptcha") || probe('script[src*="recaptcha"]')) markers.push("recaptcha");
if (probe(".cf-turnstile") || probe('iframe[src*="challenges.cloudflare.com"]') || probe('script[src*="challenges.cloudflare.com"]')) markers.push("cf-turnstile");
if (probe(".h-captcha") || probe('iframe[src*="hcaptcha"]') || probe('script[src*="hcaptcha"]')) markers.push("hcaptcha");
if (probe('script[src*="/cdn-cgi/challenge-platform"]') || probe('script[src*="cdn-cgi"]') || probe("#challenge-error-text") || probe("#cf-challenge-running")) markers.push("challenge-platform");
return { title: title, text: text, markers: markers };`;

/** R66 (A4): the ⚠ note navigate/read append when the probe/detect finds a
 * wall — the exact contract the tool description teaches the model to act
 * on ("when a tool result warns '⚠ A verification wall' …"). */
function wallWarningNote(hit: VerificationWallHit): string {
  return `\n⚠ A verification wall (${hit.kind}) is showing on this page — call browser_control with action wait_for_verification so the owner can solve it while the agent waits.`;
}

export const browserPlugin: PluginDefinition = {
  id: "core-browser",
  name: "Embedded Browser",
  version: "1.2.0",
  description:
    "Drives the user's embedded browser panel (navigate/history/viewport/read_dom/source/click/type/press_key/eval/wait_for_verification/screenshot/state).",
  category: "browser",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    return [
      {
        name: "browser_control",
        description:
          "Control the user's EMBEDDED BROWSER PANEL — a real in-app web browser the user watches live. Actions: navigate (open/change the page; absolute http(s) URL — documentation/source hosts like github.com navigate freely, other hosts ask the owner for permission first), back | forward | reload (walk that tab's history), set_viewport (change the display size the user sees — test responsive layouts; presets mobile-sm 375×667, mobile-md 390×844, tablet 768×1024, laptop 1280×800, desktop 1440×900, full-hd 1920×1080, or custom width 200-3840 × height 200-4320, zoom 0.25-3, rotate swaps w/h), read (the CURRENT page's text content, fetched fresh server-side — works in every mode), read_dom (a STRUCTURED outline of the live page as JSON — title, headings, every visible interactive element with a short CSS selector + its text/label/value, forms with field names; include 'all' adds the text paragraphs — THE way to know the page content without screenshots; native desktop mode only), source (the live page's raw material: html (outerHTML of the page or one selector), css (stylesheets, plus the computed style of a selector), or scripts (src list + inline bodies); native desktop mode only), click (click an element — by CSS selector, or by a case-insensitive substring of a clickable's visible text/aria-label/name/value/title, e.g. a button's label; native desktop mode only), type (set an input's value with the native value setter + input/change events so React/Vue pages register it, then optionally submit), press_key (dispatch a key to an element or the focused element — Enter inside a form triggers REAL native form submission), eval (run JavaScript INSIDE the live page and get the value back — click links with `return document.querySelector('a').click()`, fill inputs, read the DOM; the page's own state (logins, JS) is live; native desktop mode only), screenshot (capture what the panel shows + a vision-model description — requires Computer Use enabled in Settings), get_state (currentUrl, title, viewport, canBack/canForward + EVERY open tab), wait_for_verification (the page is blocked by a bot wall — captcha/Cloudflare/age gate: opens a countdown card in the OWNER's chat and waits — default 15s, up to 60s — while the owner solves it, then re-checks the page and reports honestly). To submit a search box / form: type with submit:true, or press_key key Enter (it triggers native form submission), or click the submit button. When a tool result warns '⚠ A verification wall', call wait_for_verification — the owner gets a live countdown card in chat to solve it. sessionId optional — defaults to the tab the user is currently viewing. Viewport/page changes appear LIVE in the user's panel; announce them in one line. The page the panel shows may differ from a fresh fetch (logins, JS) — read for text, eval for the live DOM, screenshot for what the user actually sees.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            action: {
              type: "string",
              description:
                "navigate | back | forward | reload | set_viewport | read | read_dom | source | click | type | press_key | eval | screenshot | get_state | wait_for_verification",
              enum: [
                "navigate",
                "back",
                "forward",
                "reload",
                "set_viewport",
                "read",
                "read_dom",
                "source",
                "click",
                "type",
                "press_key",
                "eval",
                "screenshot",
                "get_state",
                "wait_for_verification",
              ],
            },
            url: { type: "string", description: "Absolute http(s) URL to open (action=navigate)" },
            preset: {
              type: "string",
              description: "Display-size preset (action=set_viewport)",
              enum: [...Object.keys(VIEWPORT_PRESETS), "custom"],
            },
            width: { type: "number", description: "Viewport width 200-3840 (action=set_viewport, custom size)" },
            height: { type: "number", description: "Viewport height 200-4320 (action=set_viewport, custom size)" },
            zoom: { type: "number", description: "Panel render zoom 0.25-3 (action=set_viewport)" },
            rotate: { type: "boolean", description: "Swap width/height, e.g. landscape phone (action=set_viewport)" },
            selector: {
              type: "string",
              description:
                "CSS selector of the target element (actions click/press_key/source; type also falls back to matching an input by aria-label/name/placeholder/id substring when the selector matches nothing)",
            },
            text: {
              type: "string",
              description:
                "action=type: the value to set in the input; action=click: a case-insensitive substring of the clickable element's visible text/aria-label/name/value/title",
            },
            nth: {
              type: "number",
              description: "action=click with text: which match to click when several elements match (1-based, default 1)",
            },
            submit: {
              type: "boolean",
              description:
                "action=type: submit the element's form after typing (native form.requestSubmit() — real submission, handlers included)",
            },
            key: {
              type: "string",
              description:
                "action=press_key: the key — Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Space, or a single character",
            },
            part: {
              type: "string",
              description: "action=source: which part of the page to dump",
              enum: ["html", "css", "scripts"],
            },
            include: {
              type: "string",
              description: "action=read_dom: 'interactive' (default — outline + interactive elements) or 'all' (also the first 80 text paragraphs)",
              enum: ["interactive", "all"],
            },
            script: {
              type: "string",
              description:
                "JavaScript to run inside the live page (action=eval). Runs as a function BODY — end with `return value` to get data back (JSON-serialized). Examples: `return document.title`, `return [...document.querySelectorAll('a')].slice(0,20).map(a=>a.href)`, `document.querySelector('#login').click(); return 'clicked'`. Max 20000 chars.",
            },
            instruction: {
              type: "string",
              description:
                "What to focus on in the vision description (action=screenshot, optional) — e.g. 'describe the checkout form's fields and any validation errors'",
            },
            maxChars: {
              type: "number",
              description: "Text cap: action=read (default 8000, max 16000); actions source/read_dom (default 12000, max 20000)",
            },
            waitMs: {
              type: "number",
              description:
                "action=wait_for_verification: how long the owner may take to solve the wall, in ms (default 15000, clamped to 3000-60000)",
            },
            sessionId: {
              type: "string",
              description: "Browser tab session id — omit to target the tab the user is viewing",
            },
          },
          required: ["action"],
        }),
        execute: async (input) => {
          const action = typeof input.action === "string" ? input.action : "";
          // Mirror of the backend's SESSION_ID_RE (browser-proxy.ts) — the
          // command entry points trust their caller, so validate here.
          const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
          const explicit = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
          if (explicit !== "" && !SESSION_ID_RE.test(explicit)) {
            return { ok: false, output: "browser_control: sessionId must be alphanumeric/-/./_ (max 64 chars)" };
          }
          // Default target: the tab the user is looking at (LRU tail of the
          // sidecar's browser-session store); falls back to the shared
          // "agent" session when no browser tab has been opened yet.
          const activeTab = browserActiveTabSessionId();
          const sessionId = explicit !== "" ? explicit : (activeTab ?? "agent");
          const noTabHint =
            activeTab === null && explicit === ""
              ? " (note: no embedded browser tab is open — this state is not visible to the user yet)"
              : "";

          // ── R66 (A3/A6): run ONE eval script through the bridge ────────
          // Shared by click/type/press_key/source/read_dom. Fails closed
          // exactly like the raw eval action (no toolDeps/emit → honest
          // refusal); page-level {ok:false} + thrown errors + the script's
          // own {error} return all surface as honest tool failures.
          const runPageScript = async (
            actionName: string,
            script: string,
          ): Promise<{ ok: true; value: unknown } | { ok: false; output: string }> => {
            if (toolDeps === undefined || typeof toolDeps.emit !== "function") {
              return {
                ok: false,
                output: `browser_control: ${actionName} unavailable — no live stream channel in this context (${actionName} needs the app UI to run a script in the page)`,
              };
            }
            let data: unknown;
            try {
              data = await sendBrowserCommand(toolDeps.emit, sessionId, "eval", { script }, 12_000);
            } catch (error) {
              return {
                ok: false,
                output: `browser_control: ${actionName} failed — ${error instanceof Error ? error.message : String(error)}`,
              };
            }
            const result = (data ?? {}) as { ok?: unknown; value?: unknown; error?: unknown };
            if (result.ok !== true) {
              const message = typeof result.error === "string" ? result.error : "the page rejected the script";
              return { ok: false, output: `browser_control: ${actionName} — page error: ${message}` };
            }
            return { ok: true, value: result.value ?? null };
          };
          /** The script's in-page honest miss ({error: "…"}). */
          const pageError = (actionName: string, value: unknown): string | null => {
            const err = (value ?? {}) as { error?: unknown };
            return typeof err.error === "string" && err.error !== "" ? `browser_control: ${actionName} — ${err.error}` : null;
          };

          // ── R66 (A4): the wall probe ───────────────────────────────────
          // Bridge first (the LIVE page the user sees), server-side fetch
          // fallback (web dev mode / no native webview). Callers decide what
          // a probe failure means (navigate swallows it; wait_for_verification
          // reports it).
          const probeWallOnce = async (
            url: string,
            fallbackTitle: string | null,
          ): Promise<{ ok: true; title: string; text: string; via: "bridge" | "fetch" } | { ok: false; error: string }> => {
            if (toolDeps !== undefined && typeof toolDeps.emit === "function") {
              try {
                const data = await sendBrowserCommand(toolDeps.emit, sessionId, "eval", { script: WALL_PROBE_SCRIPT }, 5_000);
                const result = (data ?? {}) as { ok?: unknown; value?: unknown };
                if (result.ok === true) {
                  const value = (result.value ?? {}) as { title?: unknown; text?: unknown; markers?: unknown };
                  const title = typeof value.title === "string" ? value.title : "";
                  const text = typeof value.text === "string" ? value.text : "";
                  const markers = Array.isArray(value.markers)
                    ? value.markers.filter((m): m is string => typeof m === "string")
                    : [];
                  return { ok: true, title, text: markers.length > 0 ? `${text}\n${markers.join("\n")}` : text, via: "bridge" };
                }
                // Page-level probe error → the fetch fallback below.
              } catch {
                // Timeout / no panel mounted → the fetch fallback below.
              }
            }
            const fetched = await webFetch(url);
            if (!fetched.ok) {
              return { ok: false, error: `fetching the page failed: ${fetched.output}` };
            }
            return { ok: true, title: fallbackTitle ?? "", text: fetched.output, via: "fetch" };
          };

          if (action === "navigate") {
            const url = typeof input.url === "string" ? input.url.trim() : "";
            if (url === "") return { ok: false, output: "browser_control: action navigate requires url" };
            // ROUND-45 (audit P0-5): agent-driven navigation is host-gated
            // exactly like web_fetch (the panel then renders through the
            // server-side proxy). Malformed/non-http URLs fall through to the
            // shape validation below (its error is the better one); no approval
            // channel at all = fail-closed for http(s) too.
            if (/^https?:\/\//i.test(url)) {
              if (toolDeps === undefined) {
                return { ok: false, output: "browser_control: navigate unavailable — no approval channel in this context" };
              }
              const approvalDeps = buildApprovalDeps(toolDeps);
              const gate = await requestWebFetchApproval(approvalDeps, url, "browser_control");
              if (!gate.allowed) {
                return { ok: false, output: `browser_control: navigate blocked — ${gate.note}` };
              }
            }
            const result = browserNavigateCommand(sessionId, { url });
            if (!result.ok) return { ok: false, output: `browser_control: ${result.error}` };
            // R66 (A4): ONE short wall probe on the live page — the panel
            // follows within seconds, and bot walls (Cloudflare interstitials,
            // captcha gates) are exactly what the owner needs to know about
            // IMMEDIATELY. Bridge-only, single try, 5s, failures swallowed
            // (a probe error must NEVER fail a successful navigation).
            let note = "";
            if (toolDeps !== undefined && typeof toolDeps.emit === "function") {
              try {
                const data = await sendBrowserCommand(toolDeps.emit, sessionId, "eval", { script: WALL_PROBE_SCRIPT }, 5_000);
                const bridgeReply = (data ?? {}) as { ok?: unknown; value?: unknown };
                if (bridgeReply.ok === true) {
                  const value = (bridgeReply.value ?? {}) as { title?: unknown; text?: unknown; markers?: unknown };
                  const title = typeof value.title === "string" ? value.title : "";
                  const text = typeof value.text === "string" ? value.text : "";
                  const markers = Array.isArray(value.markers)
                    ? value.markers.filter((m): m is string => typeof m === "string")
                    : [];
                  const hit = detectVerificationWall({
                    title,
                    text: markers.length > 0 ? `${text}\n${markers.join("\n")}` : text,
                  });
                  if (hit !== null) note = wallWarningNote(hit);
                }
              } catch {
                // No answer in 5s (page still loading / no panel) — no note.
              }
            }
            return {
              ok: true,
              output: `navigated the embedded browser to ${result.entry?.url ?? url} (history index ${result.index}, canBack ${result.canBack}, canForward ${result.canForward}). The panel follows within a few seconds.${noTabHint}${note}`,
            };
          }
          if (action === "back" || action === "forward" || action === "reload") {
            const result = browserNavigateCommand(sessionId, { direction: action });
            if (!result.ok) return { ok: false, output: `browser_control: ${result.error}` };
            if (result.action === "noop" || result.entry === null) {
              return { ok: true, output: `browser_control: ${action} did nothing (history boundary; index ${result.index})` };
            }
            return {
              ok: true,
              output: `${action} → ${result.entry.url} (history index ${result.index}, canBack ${result.canBack}, canForward ${result.canForward}). The panel follows within a few seconds.`,
            };
          }
          if (action === "set_viewport") {
            const patch: { preset?: unknown; width?: unknown; height?: unknown; zoom?: unknown; rotate?: unknown } = {};
            if (input.preset !== undefined) patch.preset = input.preset;
            if (input.width !== undefined) patch.width = input.width;
            if (input.height !== undefined) patch.height = input.height;
            if (input.zoom !== undefined) patch.zoom = input.zoom;
            if (input.rotate !== undefined) patch.rotate = input.rotate;
            if (Object.keys(patch).length === 0) {
              return {
                ok: false,
                output: "browser_control: set_viewport requires preset and/or width/height/zoom/rotate",
              };
            }
            const result = browserViewportCommand(sessionId, patch);
            if (!result.ok) return { ok: false, output: `browser_control: ${result.error}` };
            const v = result.viewport;
            // R66 (A5): the INSTANT-APPLY frame — the mounted BrowserPanel
            // applies the change live (exits natural mode) instead of
            // waiting for the 4s poll (the owner's "had to nudge a number"
            // bug). Turn-independent in the frontend (stream-store handles
            // it before the liveTurn guard); never breaks the tool.
            try {
              toolDeps?.emit?.({
                type: "browser-viewport",
                sessionId: "",
                tabId: sessionId,
                viewport: { width: v.width, height: v.height, preset: v.preset, zoom: v.zoom, rotate: v.rotate },
              });
            } catch {
              // The frame is an optimization on top of the 4s poll backfill.
            }
            return {
              ok: true,
              output: `viewport set to ${v.width}×${v.height} (${v.preset}, zoom ${v.zoom}${v.rotate ? ", rotated" : ""}). The user's browser panel resizes live.${noTabHint}`,
            };
          }

          // ── R62 (D8): read — the current page's text, server-side ──────
          if (action === "read") {
            const state = browserGetStateCommand(sessionId);
            if (state.currentUrl === null) {
              return {
                ok: false,
                output: `browser_control: read — no page is open in tab '${sessionId}' yet; navigate first`,
              };
            }
            const maxCharsRaw = input.maxChars;
            const maxChars =
              typeof maxCharsRaw === "number" && Number.isFinite(maxCharsRaw)
                ? Math.min(16000, Math.max(1000, Math.round(maxCharsRaw)))
                : 8000;
            const fetched = await webFetch(state.currentUrl);
            if (!fetched.ok) {
              return {
                ok: false,
                output: `browser_control: read — fetching the panel's page failed: ${fetched.output}`,
              };
            }
            // The read is bounded (the same 16KB web_fetch cap) — trim to
            // the requested window and note the truncation honestly.
            let text = fetched.output;
            let truncated = false;
            if (text.length > maxChars) {
              text = `${text.slice(0, maxChars)}\n…(truncated — ${text.length} chars total; raise maxChars up to 16000)`;
              truncated = true;
            }
            // R66 (A4): the fetched text carries the wall markers just like
            // the live page (the proxy renders what the server saw) — flag
            // it so the agent calls wait_for_verification instead of
            // pretending the page is usable.
            const note = (() => {
              const hit = detectVerificationWall({ title: state.title ?? undefined, text: fetched.output });
              return hit !== null ? wallWarningNote(hit) : "";
            })();
            return {
              ok: true,
              output: `Embedded-browser page ${state.title ?? "(untitled)"} — ${state.currentUrl}${truncated ? "" : " (full text)"}:\n\n${text}${noTabHint}${note}`,
            };
          }

          // ── R66 (A6): read_dom — the structured page outline ───────────
          if (action === "read_dom") {
            const include = input.include === "all" ? "all" : "interactive";
            const maxCharsRaw = input.maxChars;
            const maxChars =
              typeof maxCharsRaw === "number" && Number.isFinite(maxCharsRaw)
                ? Math.min(20000, Math.max(2000, Math.round(maxCharsRaw)))
                : 12000;
            const page = await runPageScript("read_dom", buildReadDomScript(include));
            if (!page.ok) return { ok: false, output: page.output };
            const miss = pageError("read_dom", page.value);
            if (miss !== null) return { ok: false, output: miss };
            // The outline is capped at the SERIALIZED level (the script
            // already caps entries/strings — this bounds the total).
            const serialized = JSON.stringify(page.value ?? null);
            const capped =
              serialized.length > maxChars
                ? `${serialized.slice(0, maxChars)}…(truncated, ${serialized.length} chars total — raise maxChars up to 20000, or use include 'interactive' rather than 'all')`
                : serialized;
            return {
              ok: true,
              output: `read_dom ok (tab '${sessionId}', include ${include}) → ${capped}`,
            };
          }

          // ── R66 (A6): source — html | css | scripts ─────────────────────
          if (action === "source") {
            const part = input.part === "html" ? "html" : input.part === "css" ? "css" : input.part === "scripts" ? "scripts" : "";
            if (part === "") {
              return { ok: false, output: "browser_control: source requires part html | css | scripts" };
            }
            const selector = typeof input.selector === "string" ? input.selector.trim() : "";
            const maxCharsRaw = input.maxChars;
            const maxChars =
              typeof maxCharsRaw === "number" && Number.isFinite(maxCharsRaw)
                ? Math.min(20000, Math.max(1000, Math.round(maxCharsRaw)))
                : 12000;
            const page = await runPageScript("source", buildSourceScript(part, selector, maxChars));
            if (!page.ok) return { ok: false, output: page.output };
            const miss = pageError("source", page.value);
            if (miss !== null) return { ok: false, output: miss };
            return {
              ok: true,
              output: `source ${part} ok (tab '${sessionId}') → ${JSON.stringify(page.value ?? null)}`,
            };
          }

          // ── R66 (A3): click — by selector or by text label ─────────────
          if (action === "click") {
            const selector = typeof input.selector === "string" ? input.selector.trim() : "";
            const text = typeof input.text === "string" ? input.text.trim() : "";
            const nthRaw = input.nth;
            const nth =
              typeof nthRaw === "number" && Number.isFinite(nthRaw) ? Math.max(1, Math.round(nthRaw)) : 1;
            if (selector === "" && text === "") {
              return {
                ok: false,
                output: "browser_control: click requires 'selector' (CSS) or 'text' (a substring of the clickable element's label)",
              };
            }
            const page = await runPageScript("click", buildClickScript(selector, text, nth));
            if (!page.ok) return { ok: false, output: page.output };
            const miss = pageError("click", page.value);
            if (miss !== null) return { ok: false, output: miss };
            return {
              ok: true,
              output: `clicked (tab '${sessionId}') → ${JSON.stringify((page.value as { clicked?: unknown })?.clicked ?? page.value)}`,
            };
          }

          // ── R66 (A3): type — the framework-visible value setter ────────
          if (action === "type") {
            const selector = typeof input.selector === "string" ? input.selector.trim() : "";
            const text = typeof input.text === "string" ? input.text : "";
            if (selector === "" || typeof input.text !== "string") {
              return { ok: false, output: "browser_control: type requires 'selector' and 'text'" };
            }
            const submit = input.submit === true;
            const page = await runPageScript("type", buildTypeScript(selector, text, submit));
            if (!page.ok) return { ok: false, output: page.output };
            const miss = pageError("type", page.value);
            if (miss !== null) return { ok: false, output: miss };
            const value = (page.value ?? {}) as { submitted?: unknown; submitHow?: unknown };
            const submitNote =
              submit === false
                ? ""
                : value.submitted === true
                  ? " The form was submitted (native requestSubmit)."
                  : ` The form was NOT submitted natively: ${typeof value.submitHow === "string" ? value.submitHow : "no form found"}.`;
            return {
              ok: true,
              output: `typed into ${selector} (tab '${sessionId}', input/change events dispatched so the page's framework sees it).${submitNote} → ${JSON.stringify(page.value)}`,
            };
          }

          // ── R66 (A3): press_key — with the Enter→requestSubmit fix ──────
          if (action === "press_key") {
            const key = typeof input.key === "string" ? input.key.trim() : "";
            if (key === "") {
              return { ok: false, output: "browser_control: press_key requires 'key' (e.g. Enter, Tab, Escape, or a character)" };
            }
            if (key.length > 32) {
              return { ok: false, output: "browser_control: press_key — key must be a single key name, not a long string" };
            }
            const selector = typeof input.selector === "string" ? input.selector.trim() : "";
            const page = await runPageScript("press_key", buildPressKeyScript(key, selector));
            if (!page.ok) return { ok: false, output: page.output };
            const miss = pageError("press_key", page.value);
            if (miss !== null) return { ok: false, output: miss };
            const value = (page.value ?? {}) as { submitted?: unknown };
            return {
              ok: true,
              output: `pressed ${key} (tab '${sessionId}') → ${JSON.stringify(page.value)}${value.submitted === true ? " — the focused element's form was submitted natively (requestSubmit)." : ""}`,
            };
          }

          // ── R66 (A4): wait_for_verification — the owner-solvable wait ──
          if (action === "wait_for_verification") {
            const state = browserGetStateCommand(sessionId);
            if (state.currentUrl === null) {
              return {
                ok: false,
                output: `browser_control: wait_for_verification — no page is open in tab '${sessionId}' yet; navigate first`,
              };
            }
            const url = state.currentUrl;
            // (1) Probe the CURRENT wall state (live page via the bridge;
            // server-side fetch fallback).
            const probe = await probeWallOnce(url, state.title);
            if (!probe.ok) {
              return {
                ok: false,
                output: `browser_control: wait_for_verification — could not probe the page: ${probe.error}`,
              };
            }
            const initial = detectVerificationWall({ title: probe.title, text: probe.text });
            // (2) Clean page — no checkpoint, no wait.
            if (initial === null) {
              return {
                ok: true,
                output: `no verification wall detected on ${url} — the page looks accessible; continue normally${probe.via === "fetch" ? " (probed via a server-side fetch; the live panel may differ)" : ""}`,
              };
            }
            // (3) Wall — clamp the wait and open the checkpoint.
            const waitMsRaw = input.waitMs;
            const waitMs =
              typeof waitMsRaw === "number" && Number.isFinite(waitMsRaw)
                ? Math.min(60_000, Math.max(3_000, Math.round(waitMsRaw)))
                : 15_000;
            if (toolDeps === undefined || typeof toolDeps.emit !== "function") {
              return {
                ok: false,
                output: `browser_control: wait_for_verification — a ${initial.kind} wall is showing on ${url} (${initial.evidence}), but there is no live chat channel in this context to open a countdown card; ask the owner to solve it in the browser panel, then re-check with read or eval`,
              };
            }
            let resolution: { resolution: "done" | "stop" | "timeout" };
            try {
              resolution = await openBrowserCheckpoint(toolDeps.emit, {
                tabId: sessionId,
                kind: initial.kind,
                url,
                waitMs,
              });
            } catch (error) {
              return {
                ok: false,
                output: `browser_control: wait_for_verification — the checkpoint could not be opened: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
            // (4) Re-probe once (a "stop" needs no re-check — the owner said
            // stop) and report honestly.
            if (resolution.resolution === "stop") {
              return {
                ok: true,
                output: `the owner stopped the wait — do not retry this page automatically; ask how to proceed (a ${initial.kind} wall was showing on ${url})`,
              };
            }
            const reprobe = await probeWallOnce(url, state.title);
            if (!reprobe.ok) {
              return {
                ok: true,
                output: `${resolution.resolution === "done" ? "the owner marked it done" : `the ${Math.round(waitMs / 1000)}s wait timed out`}, but re-checking the page failed: ${reprobe.error} — verify with read or eval before continuing`,
              };
            }
            const still = detectVerificationWall({ title: reprobe.title, text: reprobe.text });
            if (resolution.resolution === "done") {
              if (still === null) {
                return {
                  ok: true,
                  output: `verification cleared — the page now shows ${reprobe.title !== "" ? reprobe.title : url} (the owner solved the ${initial.kind} wall; re-probe found no wall markers)`,
                };
              }
              return {
                ok: true,
                output: `the owner marked it done but the wall markers are still present (${still.kind}: ${still.evidence}) — re-check or ask before trusting the page`,
              };
            }
            // timeout
            if (still === null) {
              return {
                ok: true,
                output: `the ${Math.round(waitMs / 1000)}s wait timed out but the wall appears cleared — the page now shows ${reprobe.title !== "" ? reprobe.title : url}; continue carefully`,
              };
            }
            return {
              ok: true,
              output: `the ${Math.round(waitMs / 1000)}s wait timed out with the wall still up (${still.kind}: ${still.evidence}) — tell the owner what is needed (solve it in the browser panel, then ask me to re-check)`,
            };
          }

          // ── R62 (D8): eval — JavaScript inside the live page ───────────
          if (action === "eval") {
            const script = typeof input.script === "string" ? input.script : "";
            if (script.trim() === "") {
              return { ok: false, output: "browser_control: eval requires a non-empty 'script' (end it with `return value`)" };
            }
            if (script.length > 20_000) {
              return { ok: false, output: "browser_control: eval script too large (max 20000 chars)" };
            }
            if (toolDeps === undefined || typeof toolDeps.emit !== "function") {
              return {
                ok: false,
                output:
                  "browser_control: eval unavailable — no live stream channel in this context (eval needs the app UI to run the script in the page)",
              };
            }
            let data: unknown;
            try {
              data = await sendBrowserCommand(toolDeps.emit, sessionId, "eval", { script }, 12_000);
            } catch (error) {
              return {
                ok: false,
                output: `browser_control: eval failed — ${error instanceof Error ? error.message : String(error)}`,
              };
            }
            // The bridge replies with the Rust command's {ok, value|error}.
            const result = (data ?? {}) as { ok?: unknown; value?: unknown; error?: unknown };
            if (result.ok !== true) {
              const message = typeof result.error === "string" ? result.error : "the page rejected the script";
              return { ok: false, output: `browser_control: eval — page error: ${message}` };
            }
            const serialized = JSON.stringify(result.value ?? null);
            const capped =
              serialized.length > 12_000
                ? `${serialized.slice(0, 12_000)}…(truncated, ${serialized.length} chars total)`
                : serialized;
            return {
              ok: true,
              output: `eval ok (tab '${sessionId}') → ${capped}`,
            };
          }

          // ── R62 (D8): screenshot — capture + describe the panel ─────────
          if (action === "screenshot") {
            const state = browserGetStateCommand(sessionId);
            if (state.currentUrl === null) {
              return {
                ok: false,
                output: `browser_control: screenshot — no page is open in tab '${sessionId}' yet; navigate first`,
              };
            }
            const relay = getActiveComputerRelay();
            if (relay === null) {
              return {
                ok: false,
                output:
                  "browser_control: screenshot needs Computer Use enabled (Settings → Computer Use — the screen-capture engine). It is currently OFF. Meanwhile action 'read' gets the page text and 'eval' the live DOM.",
              };
            }
            if (toolDeps === undefined || toolDeps.db === null || toolDeps.db === undefined) {
              return { ok: false, output: "browser_control: screenshot unavailable — no database in this context" };
            }
            // Ask the live UI for the panel's on-screen region (physical px).
            // No answer / web mode → capture the whole display instead.
            let region: { x: number; y: number; w: number; h: number } | null = null;
            let regionNote = "full display capture";
            if (typeof toolDeps.emit === "function") {
              try {
                const meta = (await sendBrowserCommand(toolDeps.emit, sessionId, "screenshot_meta", {}, 5000)) as {
                  supported?: unknown;
                  region?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
                };
                if (
                  meta?.supported === true &&
                  meta.region !== null &&
                  meta.region !== undefined &&
                  typeof meta.region.x === "number" &&
                  typeof meta.region.y === "number" &&
                  typeof meta.region.w === "number" &&
                  typeof meta.region.h === "number" &&
                  meta.region.w > 0 &&
                  meta.region.h > 0
                ) {
                  region = {
                    x: Math.round(meta.region.x),
                    y: Math.round(meta.region.y),
                    w: Math.round(meta.region.w),
                    h: Math.round(meta.region.h),
                  };
                  regionNote = `panel region ${region.w}×${region.h}`;
                }
              } catch {
                // The UI didn't answer (no panel mounted / web dev mode) —
                // the full-display fallback below stays.
              }
            }
            const raster =
              region !== null
                ? await relay.backend.captureRegion(relay.run, region)
                : await relay.backend.captureDisplay(relay.run, 1);
            if ("error" in raster) {
              return {
                ok: false,
                output: `browser_control: screenshot — screen capture failed: ${raster.error}`,
              };
            }
            // R66 (A1): NO relay.session.record here anymore — browser
            // screenshots must NOT appear in the computer-use monitor ring
            // (the owner: browser work wrongly showed "agent is using your
            // computer"). The capture + vision description stand alone.
            const instruction =
              typeof input.instruction === "string" && input.instruction.trim() !== ""
                ? input.instruction.trim().slice(0, 500)
                : "Describe the embedded browser panel in this screenshot: which page/site is open, its visible headline content, main interactive elements, and anything actionable for the task.";
            const vision = await relayVision(toolDeps.db, toolDeps.keyring, toolDeps.mainModel, raster.pngBase64, instruction);
            if (vision.ok) {
              return {
                ok: true,
                output: `Browser panel screenshot (${regionNote}, ${raster.width}×${raster.height}px, page ${state.currentUrl}) — vision (${vision.model}) says:\n${vision.text}`,
              };
            }
            return {
              ok: true,
              output: `Browser panel screenshot captured (${regionNote}, ${raster.width}×${raster.height}px, page ${state.currentUrl}), but the vision description is unavailable: ${vision.error}`,
            };
          }

          if (action === "get_state") {
            // R62: the state now includes every open tab + which one the
            // user is viewing (the owner: "get the status of the things").
            const state = browserGetStateCommand(sessionId);
            const payload = {
              ...state,
              activeTab: activeTab,
              tabs: browserListSessionsCommand().map((t) => ({
                sessionId: t.sessionId,
                currentUrl: t.currentUrl,
                title: t.title,
                viewport: `${t.viewport.width}×${t.viewport.height} @ ${t.viewport.zoom}×${t.viewport.rotate ? " (rotated)" : ""}`,
              })),
            };
            return { ok: true, output: JSON.stringify(payload) };
          }
          return {
            ok: false,
            output: `browser_control: unknown action '${action}' (navigate | back | forward | reload | set_viewport | read | read_dom | source | click | type | press_key | eval | screenshot | get_state | wait_for_verification)`,
          };
        },
      },
    ];
  },
};
