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
 *                  platform screen-capture backends + describe it with the
 *                  (separate or main) vision model; R98-G1: DECOUPLED from
 *                  the Computer Use master switch (its own standalone
 *                  capture backend path — getCaptureBackend);
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
 *
 * ROUND-67 (R67, the owner's 0.66.0 live Windows report):
 *   · E1 — navigate/back/forward/reload now emit an instant `browser-navigate`
 *     SSE frame (the panel loads the URL the moment the tool runs — the old
 *     transport-less navigate + the poll's adopt-without-create left the
 *     panel BLANK until the user pressed Enter in the address bar);
 *   · E3 — the default target is the CHAT SESSION's bound browser tab (not
 *     the process-global LRU tail that leaked across sessions); unbound
 *     sessions mint a deterministic `ag-<chatSession>` tab announced with a
 *     `browser-open` frame (the sidebar opens the tab; its id IS the sidecar
 *     session id, so panel/bridge/history align);
 *   · E4 — the panel's session mint now carries the project id (per-project
 *     cookie profiles, closing the R46 wire-up).
 *   · R67-D — the screenshot action announces the capture to the chat as a
 *     `screenshot` SSE frame (a minted `bs_<base36>` raster id) so the live
 *     THUMBNAIL strip can show what the browser tool saw (bytes still never
 *     enter the computer-use monitor ring — A1 holds).
 */
import { jsonSchema } from "ai";
// R95-C: file:// URLs — Node's battle-tested URL→path conversion for the
// read action's disk branch (the frontend twin is src/lib/local-url.ts).
import { fileURLToPath } from "node:url";
import {
  VIEWPORT_PRESETS,
  agentTabIdForChatSession,
  bindChatSession,
  browserGetStateCommand,
  browserListSessionsCommand,
  browserNavigateCommand,
  browserSessionForChatSession,
  browserViewportCommand,
  isTextualLocalContentType,
  readLocalBrowserFile,
} from "../../browser-proxy.js";
import { sendBrowserCommand } from "../../browser-command.js";
// ROUND-89 (R89-E): the AGENT HANDS — the visible, human-like input engine
// (browser-hands.ts: the in-page cursor/typing/scroll runtime + drivers).
// R94-F: buildHandsInstallScript is the ONE-TIME runtime installer — it rides
// every evalJob command as payload.installScript (the action script itself
// stays tiny; see the split's comment in browser-hands.ts).
import {
  buildHandsClickScript,
  buildHandsTypeScript,
  buildHandsPressKeyScript,
  buildHandsMouseScript,
  buildHandsInstallScript,
} from "./browser-hands.js";
import { detectVerificationWall, openBrowserCheckpoint } from "../../browser-checkpoint.js";
import type { VerificationWallHit } from "../../browser-checkpoint.js";
import { requestWebFetchApproval } from "../../approvals.js";
import { buildApprovalDeps } from "../approval-deps.js";
// ROUND-98 (R98-G1): the DECOUPLED capture engine — the browser screenshot
// no longer borrows the computer-use relay (that registry is armed only
// when Settings → Computer Use is enabled, an unrelated OFF-by-default
// master switch). getCaptureBackend returns the ACTIVE platform backend +
// its runner directly; the relay stays for computer-use's own path.
import { getCaptureBackend } from "../../computer/backends/index.js";
import { relayVision } from "./computer-use.js";
// R94-E (PART 3) → R98-G1: the vision-gate helpers. The gate SPLIT in
// round 98: sessionHasVisionPath now gates only the DESCRIBE leg
// (relayVision — the Image-Analysis description) AFTER the capture; the
// capture itself (captureRegion + registerRaster + the chat thumbnail
// frame) is NOT vision-gated (a blind session still gets the raster — the
// owner sees it in the chat thumbnail; only the description is refused
// honestly with the canonical message).
import { NO_VISION_SCREENSHOT_MESSAGE, sessionHasVisionPath } from "./computer-use.js";
// ROUND-67 (R67-D): the screenshot action copies its capture into the
// route-served raster registry + announces the chat THUMBNAIL frame.
import { registerRaster } from "../../computer/raster-cache.js";
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

// ── ROUND-95 (R95-C): local files ─────────────────────────────────────
//
// The owner: "I gave it a file path for a local HTML file and after giving
// it that, it gave me this error: 'Native browser unavailable. Only
// HTTP/HTTPS URLs are supported by the embedded browser.'" The native
// browser opens local files now (the Rust gate + the panel + the navigate
// core all accept file://), and the TOOL normalizes what the model naturally
// sends — a Windows path, a POSIX path, a UNC path, or a ready file:// URL —
// into the canonical file:// URL before it reaches the history.

/** A relative path that names a local page-ish file (`demo.html`). */
const RELATIVE_LOCAL_FILE_RE = /^[^?#]*\.(?:html?|xhtml|svg|md|txt|json|css|js|mjs)(?:[?#]|$)/i;

/**
 * ROUND-98 (R98-G1, bug b): the degenerate-region floor for the screenshot
 * action. A VISIBLE browser panel is hundreds of pixels on every axis; a
 * hidden (display:none) tab, a collapsed sidebar, or stale geometry reports
 * a 0×0 (or single-digit) rect that the pre-fix code CLAMPED to 1×1 and then
 * "successfully" captured one pixel. Anything below this floor is refused
 * honestly with the cause named — never captured.
 */
const REGION_MIN_PX = 50;

// ── ROUND-124 (R124): the FIXED CAPTURE RESOLUTION law ────────────────────
//
// The owner's verdict on the built-in browser's screenshots: "if the browser
// window is way too small, then the resolution of the screenshot is way too
// less… the screenshots… should be taken in a higher resolution, even if the
// total area being taken up by the browser window is way too small. Meaning
// the screenshot… should not be based on the actual device's resolution, but
// it should be based on some other factors." THE OTHER FACTORS: a FIXED
// LOGICAL capture resolution — 1280×720 (the HD band; the viewport preset
// family's own laptop step on the width axis) — commanded at the tab's
// webview for the duration of the grab, whatever the visible panel size is.
// The frontend twin of these constants lives in
// src/lib/agent-browser-capture.ts (BROWSER_CAPTURE_WIDTH/HEIGHT) as the
// FALLBACK default; THIS side is the source of truth and threads the numbers
// through the screenshot_capture command payload (the sidecar cannot import
// frontend code — the normalizeLocalFileUrl lockstep precedent; the frontend
// suite pins the same values).
export const BROWSER_CAPTURE_WIDTH = 1280;
/** R124: the fixed logical capture height (see BROWSER_CAPTURE_WIDTH). */
export const BROWSER_CAPTURE_HEIGHT = 720;

/**
 * R124: the whole round-trip budget for the staged capture — the frontend's
 * stage (bounds + zoom + show) + settle (400ms) + the sidecar's own capture
 * route (its backend capsule carries a 20s timeout) + the restore. The
 * evalJob precedent runs to 75s for human-paced jobs; a capture is one grab,
 * so half that is generous.
 */
const BROWSER_CAPTURE_COMMAND_TIMEOUT_MS = 30_000;

/**
 * R95-C: normalize a file:// URL or a bare LOCAL PATH (Windows drive, POSIX
 * absolute, UNC) into the canonical file:// URL the native chain accepts.
 * `null` for everything else — http(s) URLs pass through untouched and the
 * backend's validation stays the authority for junk.
 *
 * The frontend twin lives in src/lib/local-url.ts (agent-core cannot import
 * frontend code — keep the two in behavioral lockstep; local-url.test.ts +
 * browser-tool.test.ts pin the same shapes).
 */
function normalizeLocalFileUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString();
    } catch {
      return null; // a broken file URL — the backend's error is the honest one
    }
  }
  try {
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
      // C:\Users\me\page.html or C:/Users/me/page.html → file:///C:/Users/me/page.html
      return new URL(`file:///${trimmed.replace(/\\/g, "/")}`).toString();
    }
    if (trimmed.startsWith("\\\\")) {
      // \\server\share\page.html → file://server/share/page.html (host lowercases
      // like every URL host; only BACKSLASH-led strings count as UNC).
      const parts = trimmed.slice(2).replace(/\\/g, "/").split("/").filter((p) => p !== "");
      if (parts.length === 0) return null;
      const [host, ...pathParts] = parts;
      const suffix = pathParts.length > 0 ? `/${pathParts.join("/")}` : "";
      return new URL(`file://${host.toLowerCase()}${suffix}`).toString();
    }
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
      // POSIX absolute path: /home/me/page.html → file:///home/me/page.html.
      return new URL(`file://${trimmed}`).toString();
    }
  } catch {
    return null;
  }
  return null;
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
 *
 * R93-B3: pageState — the SPA SECTION tracker. The owner's report: "it was
 * in the images section, but it then reverted back to the all section" —
 * the outline alone could not tell the model WHICH section a SPA currently
 * shows, so a click that silently reverted was invisible. pageState carries
 * (a) the URL hash + query params, (b) every [aria-selected="true"] /
 * [aria-current] element (the active tab / nav link — tag, role, text,
 * href, capped at 12), (c) <html lang> (title + full url already ride the
 * top level). Cheap by design: one querySelectorAll, no layout reads —
 * the model calls read_dom again after clicking a section, compares
 * pageState, and re-clicks when the app reverted.
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
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
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
// R93-B3: pageState — the SPA section signals (see the doc above). Every
// read is individually guarded: a page with no hash/aria state still gets a
// usable (small) object instead of an error.
const pageState = { lang: document.documentElement.getAttribute("lang") || undefined };
try { pageState.hash = location.hash || undefined; } catch (e) {}
const query = {};
try { new URLSearchParams(location.search).forEach((v, k) => { if (query[k] === undefined && Object.keys(query).length < 20) query[k] = v; }); } catch (e) {}
if (Object.keys(query).length > 0) pageState.query = query;
const selected = [];
try {
  for (const el of Array.from(document.querySelectorAll('[aria-selected="true"], [aria-current]')).slice(0, 12)) {
    selected.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || undefined, ariaCurrent: el.getAttribute("aria-current") || undefined, text: clip(el.textContent, 40) || undefined, href: (el.getAttribute && el.getAttribute("href")) || undefined });
  }
} catch (e) {}
if (selected.length > 0) pageState.selected = selected;
return { title: clip(document.title, 120), url: location.href, headings: headings, interactive: interactive, forms: forms, paragraphs: paragraphs, pageState: pageState };`;
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

/**
 * R94-F: the ONE-TIME hands runtime installer, sent with EVERY evalJob
 * command as `payload.installScript`. It rides the SSE frame — NOT the page
 * eval — and the BrowserPanel only evals it when the (tiny) action script
 * answers {needInstall:true}, i.e. once per page navigation. This is the
 * structural fix for the owner's v0.91.0 Windows report: the old action
 * scripts embedded this whole runtime into every click/type/press_key
 * (17-19KB monoliths — the ONLY evals failing on his machine while ~2KB
 * evals on the same pages worked; size was the discriminating variable).
 */
const HANDS_INSTALL_SCRIPT = buildHandsInstallScript();

/** R94-F: the wait action's page probe — a tiny read-only eval answered with
 * {ready, has, url}. `selector` is embedded via JSON.stringify ONLY
 * (injection safety, the same contract as every other page script). A
 * failing probe (page navigating, bridge timeout) is NEVER an immediate
 * error — the wait loop treats it as not-ready and keeps probing. */
function buildWaitProbeScript(selector: string): string {
  return `return { ready: document.readyState, has: ${
    selector === "" ? "null" : `!!(document.querySelector(${JSON.stringify(selector)}))`
  }, url: location.href };`;
}

/** The step actions a sequence may chain (R94-F) — every action except
 * "sequence" itself (no nesting) and except the tool-level plumbing that
 * must not run mid-chain. Kept in sync with the action enum + the schema's
 * steps description. */
const SEQUENCE_STEP_ACTIONS: ReadonlySet<string> = new Set([
  "navigate",
  "back",
  "forward",
  "reload",
  "read",
  "read_dom",
  "source",
  "click",
  "type",
  "press_key",
  "mouse",
  "eval",
  "wait",
  "wait_for_verification",
  "set_viewport",
  "screenshot",
  "get_state",
]);

/** R94-F: one condensed line for a sequence step's report — the step
 * outputs can be huge (read_dom up to 20KB); the sequence report is a
 * progress overview, not a data dump (the failing step's FULL error is
 * always surfaced separately, and data actions should be called directly
 * when their payload matters). */
function condenseSequenceLine(output: string): string {
  const flat = output.replace(/\s+/g, " ").trim();
  return flat.length > 500 ? `${flat.slice(0, 500)}…(${flat.length} chars — call the action directly for the full result)` : flat;
}

export const browserPlugin: PluginDefinition = {
  id: "core-browser",
  name: "Embedded Browser",
  version: "1.2.0",
  description:
    "Drives the user's embedded browser panel (navigate/history/viewport/read_dom/source/click/type/press_key/eval/wait/sequence/wait_for_verification/screenshot/state).",
  category: "browser",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    return [
      {
        name: "browser_control",
        // ROUND-117 (R117-c, C1): the ~7.7K one-paragraph description became a
        // ~1.3K POLICY HEAD — surface boundary, drive-the-panel-only,
        // read_dom-first, navigation settles, forms submit semantics, bot
        // walls, pacing — while the per-action parameter detail moved INTO
        // the inputSchema (the authoritative surface for WHAT each action
        // takes; nothing was lost, the action/url/part/steps descriptions
        // below now carry it). Round-tags stripped from the model-facing
        // text (kept here in the developer comments).
        description:
          "Control the user's EMBEDDED BROWSER PANEL — a real in-app browser the user watches live. The panel lives INSIDE the app: browser_control never opens the user's real browsers or touches their desktop, and computer-use tools never drive the panel. Input is visible and human-paced (an agent cursor travels to each target; typing lands word-by-word) — pace actions in order like a person, never in parallel. Omit sessionId to drive this chat session's own tab (auto-opened).\n\n" +
          "How to work: (1) search first — navigate to a search engine and type the query, never guess URLs; (2) read_dom first on every new page — its structured outline (selectors, positions, pageState) beats screenshots for knowing the page; (3) navigation settles: after navigate/back/forward/reload, wait (or use sequence, which settles automatically) before interacting; (4) forms: typing alone never submits — type with submit:true, press_key Enter, or click the submit button; (5) bot walls: a '⚠ A verification wall' warning means stop retrying and call wait_for_verification while the owner solves it.\n\n" +
          "The panel's page may differ from a fresh fetch (logins, JS): read for text, eval for the live DOM, screenshot for the page's pixels at a fixed 1280×720 capture resolution (it works even while the browser tab is hidden or the user is elsewhere in the app). Full parameters live in the schema; deep craft lives in read_skill \"browser-use\".",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            action: {
              type: "string",
              description:
                "navigate (open an absolute http(s) URL or a local HTML file — a file:// URL or an absolute local path; docs/source hosts like github.com navigate freely, other hosts ask the owner for permission first) | back | forward | reload (walk that tab's history) | set_viewport (resize the display the user sees — responsive-layout testing) | read (fresh server-side text of the current page; local file:// pages read from disk; works in every mode) | read_dom (structured JSON outline of the LIVE page — title, headings, every visible interactive element with a short CSS selector + text/label/value + x/y/w/h, form field names, and pageState: the URL hash/query + the aria-selected/aria-current tab, so after clicking a section or tab you can re-read and confirm it stuck; include 'all' adds the first 80 text paragraphs) | source (the live page's raw material: html/css/scripts) | click (the cursor visibly travels, hovers, then a full real pointer sequence fires at the element; the result reports where focus moved — a cheap effect check; native desktop mode only) | type (human word-by-word typing with real per-character events — React/Vue inputs register it, a ~1s beat after the focusing click; newlines become real Shift+Enter newlines, never an implicit submit; capped at 600 chars per call — split longer texts; native desktop mode only) | press_key (Enter inside a form triggers native form submission) | mouse (pointer ops at exact page coordinates from read_dom — the cursor visibly travels every path; native desktop mode only) | eval (run JavaScript inside the live page and get the value back — the page's own state, logins and JS included; native desktop mode only) | wait (probe the live page until its conditions hold — always call it after navigate before clicking/typing) | sequence (atomic multi-step chain in ONE call — steps settle automatically between) | screenshot (captures the page at a FIXED 1280×720 capture resolution — independent of the visible browser panel's size, and works even while the tab is hidden or the user is elsewhere in the app; the vision description needs a vision model, the capture alone does not; prefer read/read_dom unless pixels are the question; native desktop mode only) | get_state (currentUrl, title, viewport, canBack/canForward + this chat session's tab) | wait_for_verification (bot-wall pause: a countdown card opens in the owner's chat while they solve it, then the page is re-checked honestly)",
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
                "mouse",
                "eval",
                "wait",
                "sequence",
                "screenshot",
                "get_state",
                "wait_for_verification",
              ],
            },
            op: {
              type: "string",
              description: "action=mouse: the pointer operation — move (hover), click (left), double, right, drag, scroll",
              enum: ["move", "click", "double", "right", "drag", "scroll"],
            },
            x: { type: "number", description: "action=mouse: x in page CSS px (read_dom reports per-element x/y/w/h); scroll: optional hover point" },
            y: { type: "number", description: "action=mouse: y in page CSS px" },
            toX: { type: "number", description: "action=mouse op=drag: the end x" },
            toY: { type: "number", description: "action=mouse op=drag: the end y" },
            dx: { type: "number", description: "action=mouse op=scroll: horizontal scroll pixels (positive = right)" },
            dy: { type: "number", description: "action=mouse op=scroll: vertical scroll pixels (positive = down)" },
            url: { type: "string", description: "Absolute http(s) URL, or a local file (a file:// URL or an absolute local path like C:\\Users\\me\\page.html) — local HTML files open natively in the browser panel (action=navigate)" },
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
                "CSS selector of the target element (actions click/press_key/source; type also falls back to matching an input by aria-label/name/placeholder/id substring when the selector matches nothing; action=wait: succeed once document.querySelector(selector) finds an element)",
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
              description: "action=source: which part of the page to dump — html (outerHTML of the page or one selector), css (stylesheets + the computed style of a selector), scripts (src list + inline bodies)",
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
            ms: {
              type: "number",
              description:
                "action=wait: the total wait budget in ms (250-15000, default 900) — the tool probes the page every 250ms until the conditions hold (readyState complete by default; optional selector appearing / urlContains); with readyState:false and no selector/urlContains it is a plain pause",
            },
            urlContains: {
              type: "string",
              description:
                "action=wait: succeed once the tab's URL contains this substring (a redirect/settle detector — e.g. 'github.com' while a login hop lands)",
            },
            readyState: {
              type: "boolean",
              description:
                "action=wait: require document.readyState === 'complete' (default true — the recommended wait after navigate; set false for a pure ms pause)",
            },
            steps: {
              type: "array",
              description:
                "action=sequence: 1-8 steps, each an object {action: <one of navigate/back/forward/reload/read/read_dom/source/click/type/press_key/mouse/eval/wait/wait_for_verification/set_viewport/screenshot/get_state>, ...that action's params} — executed IN ORDER on ONE tab in a single tool call, each step through the exact same code as the standalone action, stopping at the first failure (e.g. {action:'type', selector:'#q', text:'hello', submit:true} then {action:'wait', ms:900} then {action:'click', selector:'button[type=submit]'}); between steps the tool settles automatically (250ms, or up to 5s for readyState complete after navigate/back/forward/reload)",
              items: {
                type: "object",
                description:
                  "One sequence step: {action, ...params} — the same params the standalone action takes. 'sequence' is not allowed as a step action (no nesting).",
              },
              maxItems: 8,
            },
            sessionId: {
              type: "string",
              description:
                "Browser tab session id — omit to target this chat session's own browser tab (one is opened for you if none exists)",
            },
          },
          required: ["action"],
        }),
        execute: async (input) => {
          // Mirror of the backend's SESSION_ID_RE (browser-proxy.ts) — the
          // command entry points trust their caller, so validate here.
          const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
          const explicit = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
          if (explicit !== "" && !SESSION_ID_RE.test(explicit)) {
            return { ok: false, output: "browser_control: sessionId must be alphanumeric/-/./_ (max 64 chars)" };
          }
          // ── ROUND-67 (R67/E3): chat-session-scoped tab targeting ────────
          // The owner's leak report: a NEW chat session drove the PREVIOUS
          // session's still-open browser tab (the old default target was the
          // process-global LRU tail). Resolution order is now:
          //   1. an explicit sessionId param (pinned by the model);
          //   2. this CHAT session's binding — declared by the frontend
          //      (POST /browser/bind, the tab the user is viewing in this
          //      chat session's sidebar) or minted below;
          //   3. unbound → MINT a deterministic agent tab `ag-<chatSession>`
          //      for this chat session, bind it, and announce it with a
          //      `browser-open` frame so the sidebar opens a real tab (the
          //      panel's tab id IS the session id — the bridge, the webview
          //      label and the history all align on one id).
          // The legacy global-LRU/"agent" fallback only survives for
          // catalog/test contexts with NO chat-session id.
          const chatSessionId =
            toolDeps !== undefined && typeof toolDeps.sessionId === "string" && toolDeps.sessionId !== ""
              ? toolDeps.sessionId
              : null;
          let sessionId: string;
          let mintedAgentTab = false;
          if (explicit !== "") {
            sessionId = explicit;
          } else {
            const bound = chatSessionId !== null ? browserSessionForChatSession(chatSessionId) : null;
            if (bound !== null) {
              sessionId = bound;
            } else {
              const minted = chatSessionId !== null ? agentTabIdForChatSession(chatSessionId) : null;
              if (minted === null || chatSessionId === null) {
                sessionId = "agent";
              } else {
                sessionId = minted;
                bindChatSession(chatSessionId, minted);
                mintedAgentTab = true;
              }
            }
          }
          if (mintedAgentTab && toolDeps !== undefined && typeof toolDeps.emit === "function") {
            // The sidebar needs a tab for this chat session RIGHT NOW — the
            // frame carries the minted id so the created tab's id equals the
            // sidecar session id (panel ↔ bridge ↔ history all align). The
            // url rides null here; the navigate action (or the user) fills
            // it. SSE-only: emit never persists (see runtime's emit wiring).
            try {
              toolDeps.emit({
                type: "browser-open",
                sessionId: "",
                tabId: sessionId,
                chatSessionId: chatSessionId ?? "",
                url: null,
              });
            } catch {
              // The frame is an optimization — the 4s poll backfills.
            }
          }
          const noTabHint =
            sessionId === "agent" && explicit === ""
              ? " (note: no chat-session context — using the shared fallback tab; this state is not visible to the user)"
              : "";

          // ── ROUND-94 (R94-F): the per-action dispatch ────────────────
          // Extracted from the single-action path so the SEQUENCE action
          // (below) can run its steps through THE SAME code — one shared
          // if-chain, one set of helpers, one validation story. The tab is
          // resolved ONCE by the outer execute() (a sequence never
          // re-resolves or re-mints); every action reads its params from
          // `input` exactly as before.
          const executeAction = async (
            input: Record<string, unknown>,
            resolvedSessionId: string,
            hint: string,
          ): Promise<{ ok: boolean; output: string }> => {
            const action = typeof input.action === "string" ? input.action : "";
            const sessionId = resolvedSessionId;
            const noTabHint = hint;

            // ── R66 (A3/A6): run ONE eval script through the bridge ────────
            // Shared by click/type/press_key/source/read_dom. Fails closed
            // exactly like the raw eval action (no toolDeps/emit → honest
            // refusal); page-level {ok:false} + thrown errors + the script's
            // own {error} return all surface as honest tool failures.
            const runPageScript = async (
              actionName: string,
              script: string,
              timeoutMs: number = 12_000,
            ): Promise<{ ok: true; value: unknown } | { ok: false; output: string }> => {
              if (toolDeps === undefined || typeof toolDeps.emit !== "function") {
                return {
                  ok: false,
                  output: `browser_control: ${actionName} unavailable — no live stream channel in this context (${actionName} needs the app UI to run a script in the page)`,
                };
              }
              let data: unknown;
              try {
                data = await sendBrowserCommand(toolDeps.emit, sessionId, "eval", { script }, timeoutMs);
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

            /** R89-E (R94-F split): run one AGENT-HANDS job — the TINY action
             * script starts the async job and returns {started:true} at once
             * (the ~15KB runtime installer rides the command payload as
             * installScript — the BrowserPanel evals it only when the page
             * reports {needInstall:true}); the evalJob BRIDGE action then
             * polls the page's job state every 120ms and answers with the
             * final result.
             * R90-D1: the budget is now 75s — the human pacing grew (tap →
             * ~1s beat → typing → ~1s beat → Enter; ~150 WPM ≈ 12.5 chars/s
             * means a full 600-char type call alone takes ~48s, plus the move
             * path + the beats). The panel's own job budget matches (60s) and
             * this outer round-trip covers the bridge overhead on top. */
            const runPageJob = async (
              actionName: string,
              script: string,
            ): Promise<{ ok: true; value: unknown } | { ok: false; output: string }> => {
              if (toolDeps === undefined || typeof toolDeps.emit !== "function") {
                return {
                  ok: false,
                  output: `browser_control: ${actionName} unavailable — no live stream channel in this context (${actionName} needs the app UI to drive the page)`,
                };
              }
              let data: unknown;
              try {
                data = await sendBrowserCommand(toolDeps.emit, sessionId, "evalJob", { script, installScript: HANDS_INSTALL_SCRIPT }, 75_000);
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
              // R95-C: a local file has no upstream to interrogate — the
              // bridge probe (the LIVE page) is the only real signal. Without
              // it, treat the file as clean: a static local file does not
              // serve bot walls, and any marker text inside it is already
              // visible to read/eval.
              if (/^file:\/\//i.test(url)) {
                return { ok: true, title: fallbackTitle ?? "", text: "", via: "fetch" };
              }
              const fetched = await webFetch(url);
              if (!fetched.ok) {
                return { ok: false, error: `fetching the page failed: ${fetched.output}` };
              }
              return { ok: true, title: fallbackTitle ?? "", text: fetched.output, via: "fetch" };
            };

            if (action === "navigate") {
              let url = typeof input.url === "string" ? input.url.trim() : "";
              if (url === "") return { ok: false, output: "browser_control: action navigate requires url" };
              // ── ROUND-95 (R95-C): local files open natively ────────────
              // Normalize what the model naturally sends — a Windows/POSIX/
              // UNC path or a file:// URL — into the canonical file:// URL
              // before anything else looks at it.
              const local = normalizeLocalFileUrl(url);
              if (local !== null) {
                url = local;
              } else if (RELATIVE_LOCAL_FILE_RE.test(url)) {
                return {
                  ok: false,
                  output: `browser_control: navigate — '${url}' is a relative local path; give an absolute path (C:\\Users\\me\\page.html or /home/me/page.html)`,
                };
              }
              // ROUND-45 (audit P0-5): agent-driven navigation is host-gated
              // exactly like web_fetch (the panel then renders through the
              // server-side proxy). Malformed/non-http URLs fall through to the
              // shape validation below (its error is the better one); no approval
              // channel at all = fail-closed for http(s) too.
              // R95-C: file:// navigations are NOT host-gated — a local file is
              // the owner's own disk at the same trust level as the (approval-
              // governed) read_file tool, and the panel renders it visibly live.
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
              // ── ROUND-67 (R67/E1): the INSTANT navigation frame ───────────
              // The owner's blank-panel bug: navigate used to mutate ONLY the
              // sidecar history and the panel learned via the 4s poll — on a
              // fresh tab the poll ADOPTED the URL without ever creating the
              // WebView2, so the panel stayed empty until the user pressed
              // Enter in the address bar. The frame carries the target tab +
              // URL so the panel navigates (creating the webview when needed)
              // IMMEDIATELY; the poll stays as the backfill. Turn-independent
              // on the frontend (stream-store handles it before the liveTurn
              // guard), mirroring the R66 browser-viewport frame.
              if (toolDeps !== undefined && typeof toolDeps.emit === "function") {
                try {
                  toolDeps.emit({
                    type: "browser-navigate",
                    sessionId: "",
                    tabId: sessionId,
                    url: result.entry?.url ?? url,
                  });
                } catch {
                  // The frame is an optimization on top of the 4s poll backfill.
                }
              }
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
                output: `navigated the embedded browser to ${result.entry?.url ?? url} (history index ${result.index}, canBack ${result.canBack}, canForward ${result.canForward}). The panel follows immediately (a browser tab opens in the user's right sidebar if none is open for this session yet).${noTabHint}${note}`,
              };
            }
            if (action === "back" || action === "forward" || action === "reload") {
              const result = browserNavigateCommand(sessionId, { direction: action });
              if (!result.ok) return { ok: false, output: `browser_control: ${result.error}` };
              if (result.action === "noop" || result.entry === null) {
                return { ok: true, output: `browser_control: ${action} did nothing (history boundary; index ${result.index})` };
              }
              // R67/E1: back/forward/reload announce the landed URL the same
              // instant-navigate way (the panel loads it immediately; the 4s
              // poll stays as the backfill).
              if (toolDeps !== undefined && typeof toolDeps.emit === "function" && result.entry !== null) {
                try {
                  toolDeps.emit({
                    type: "browser-navigate",
                    sessionId: "",
                    tabId: sessionId,
                    url: result.entry.url,
                  });
                } catch {
                  // Backfill via the poll.
                }
              }
              return {
                ok: true,
                output: `${action} → ${result.entry.url} (history index ${result.index}, canBack ${result.canBack}, canForward ${result.canForward}). The panel follows immediately.`,
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
              // ── R95-C: a file:// page reads from DISK, not the network ──
              // The owner's local file is the page the user's panel shows;
              // web_fetch refuses the file: scheme, so read it through the
              // same capped, validated reader the /browser/local-file route
              // serves (raw source — a local HTML file is usually the very
              // code the agent is working on).
              if (/^file:\/\//i.test(state.currentUrl)) {
                let localPath: string | null = null;
                try {
                  localPath = fileURLToPath(new URL(state.currentUrl));
                } catch {
                  localPath = null;
                }
                if (localPath === null) {
                  return {
                    ok: false,
                    output: `browser_control: read — '${state.currentUrl}' is not a valid local file URL`,
                  };
                }
                const file = await readLocalBrowserFile(localPath);
                if (!file.ok) {
                  return { ok: false, output: `browser_control: read — reading the local file failed: ${file.error}` };
                }
                if (!isTextualLocalContentType(file.file.contentType)) {
                  return {
                    ok: false,
                    output: `browser_control: read — '${file.file.path}' is a ${file.file.contentType} file; read returns TEXT (use screenshot for pixels)`,
                  };
                }
                let fileText = file.file.bytes.toString("utf8");
                let fileTruncated = false;
                if (fileText.length > maxChars) {
                  fileText = `${fileText.slice(0, maxChars)}\n…(truncated — ${fileText.length} chars total; raise maxChars up to 16000)`;
                  fileTruncated = true;
                }
                // R66 (A4): the wall markers are checked on local files too
                // (a saved interstitial page still reads like one).
                const fileNote = (() => {
                  const hit = detectVerificationWall({ title: state.title ?? undefined, text: file.file.bytes.toString("utf8") });
                  return hit !== null ? wallWarningNote(hit) : "";
                })();
                return {
                  ok: true,
                  output: `Local file page ${state.title ?? "(untitled)"} — ${state.currentUrl} (read from disk, raw source${fileTruncated ? "" : ", full text"}):\n\n${fileText}${noTabHint}${fileNote}`,
                };
              }
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
              const page = await runPageJob("click", buildHandsClickScript(selector, text, nth));
              if (!page.ok) return { ok: false, output: page.output };
              const miss = pageError("click", page.value);
              if (miss !== null) return { ok: false, output: miss };
              // R93-B3: the light post-action verification — the hands' click
              // reports where focus moved (tag/name) when it changed; surfaced
              // as a hint (never fatal, absent when focus did not move).
              const value = (page.value ?? {}) as { clicked?: unknown; focus?: unknown };
              const focusNote =
                value.focus === undefined || value.focus === null
                  ? ""
                  : ` Focus moved to ${JSON.stringify(value.focus)} — the click took effect.`;
              return {
                ok: true,
                output: `clicked (tab '${sessionId}') → ${JSON.stringify(value.clicked ?? page.value)}${focusNote}`,
              };
            }

            // ── R66 (A3): type — the framework-visible value setter ────────
            if (action === "type") {
              const selector = typeof input.selector === "string" ? input.selector.trim() : "";
              const text = typeof input.text === "string" ? input.text : "";
              if (selector === "" || typeof input.text !== "string") {
                return { ok: false, output: "browser_control: type requires 'selector' and 'text'" };
              }
              if (text.length > 600) {
                return {
                  ok: false,
                  output: `browser_control: type — the text is ${text.length} chars; the human-paced typing (150 WPM) is capped at 600 chars per call. Split the text and type it in parts.`,
                };
              }
              const submit = input.submit === true;
              const page = await runPageJob("type", buildHandsTypeScript(selector, text, submit));
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
              const page = await runPageJob("press_key", buildHandsPressKeyScript(key, selector));
              if (!page.ok) return { ok: false, output: page.output };
              const miss = pageError("press_key", page.value);
              if (miss !== null) return { ok: false, output: miss };
              const value = (page.value ?? {}) as { submitted?: unknown };
              return {
                ok: true,
                output: `pressed ${key} (tab '${sessionId}') → ${JSON.stringify(page.value)}${value.submitted === true ? " — the focused element's form was submitted natively (requestSubmit)." : ""}`,
              };
            }

            // ── R89-E: mouse — the full-fledged pointer control ──────────────
            // The owner's directive: "give it full-fledged capabilities… its
            // own custom mouse pointer… the mouse pointer will actually be
            // shown moving… left click or right click… the scroll
            // functionality will work properly too." Coordinates are PAGE CSS
            // pixels — exactly what read_dom reports per element.
            if (action === "mouse") {
              const opInput = input.op;
              const op =
                opInput === "move" || opInput === "click" || opInput === "double" || opInput === "right" || opInput === "drag" || opInput === "scroll"
                  ? opInput
                  : "";
              if (op === "") {
                return {
                  ok: false,
                  output: "browser_control: mouse requires 'op' — move | click | double | right | drag | scroll",
                };
              }
              const numOrNull = (v: unknown): number | null =>
                typeof v === "number" && Number.isFinite(v) ? v : null;
              const x = numOrNull(input.x);
              const y = numOrNull(input.y);
              const toX = numOrNull(input.toX);
              const toY = numOrNull(input.toY);
              const dx = numOrNull(input.dx);
              const dy = numOrNull(input.dy);
              if (op === "drag" && (x === null || y === null || toX === null || toY === null)) {
                return { ok: false, output: "browser_control: mouse drag requires x, y (start) AND toX, toY (end)" };
              }
              if ((op === "move" || op === "click" || op === "double" || op === "right") && (x === null || y === null)) {
                return { ok: false, output: `browser_control: mouse ${op} requires x and y (page CSS px — read_dom reports them per element)` };
              }
              if (op === "scroll" && dx === null && dy === null) {
                return { ok: false, output: "browser_control: mouse scroll requires dx and/or dy (pixels; positive = down/right)" };
              }
              const page = await runPageJob("mouse", buildHandsMouseScript(op, x, y, toX, toY, dx, dy));
              if (!page.ok) return { ok: false, output: page.output };
              const miss = pageError("mouse", page.value);
              if (miss !== null) return { ok: false, output: miss };
              return {
                ok: true,
                output: `mouse ${op} (tab '${sessionId}', the visible agent cursor performed it) → ${JSON.stringify(page.value)}`,
              };
            }

            // ── R94-F: wait — the proper waiting the owner asked for ──────
            // His v0.91.0 report: the model literally called a nonexistent
            // action 'wait' after navigate (and then fired clicks into pages
            // that were still loading — the click failures that started the
            // whole detour). This is the real one: a server-side probe loop
            // (250ms cadence, SHORT 2s per-probe timeout — a failing probe
            // means the page is NAVIGATING, i.e. not ready, never an error)
            // until readyState complete (default) and/or a selector appears
            // and/or the URL contains a substring, all within `ms` (250ms
            // floor, 15s cap, default 900ms).
            if (action === "wait") {
              const msRaw = input.ms;
              const ms =
                typeof msRaw === "number" && Number.isFinite(msRaw)
                  ? Math.min(15_000, Math.max(250, Math.round(msRaw)))
                  : 900;
              const selector = typeof input.selector === "string" ? input.selector.trim() : "";
              const urlContains = typeof input.urlContains === "string" ? input.urlContains.trim() : "";
              const readyStateNeeded = input.readyState !== false; // default true
              // A wait with NO conditions is a plain pause — no page probe,
              // no bridge needed (works in every mode, like a person pausing).
              if (selector === "" && urlContains === "" && !readyStateNeeded) {
                await new Promise((resolve) => setTimeout(resolve, ms));
                return {
                  ok: true,
                  output: `wait ok (tab '${sessionId}') — paused ${ms}ms (no conditions requested; set readyState true or a selector/urlContains to wait for the page)`,
                };
              }
              if (toolDeps === undefined || typeof toolDeps.emit !== "function") {
                return {
                  ok: false,
                  output:
                    "browser_control: wait unavailable — no live stream channel in this context (wait needs the app UI to probe the live page)",
                };
              }
              const started = Date.now();
              const deadline = started + ms;
              let lastReady: string | null = null;
              let lastUrl: string | null = null;
              let lastHas: boolean | null = null;
              // Probe → check → (not ready) sleep to the next 250ms tick,
              // until the conditions hold or the budget is spent. A probe
              // that FAILS (bridge error, page navigating) is simply not
              // ready — the loop keeps its head and the honest timeout
              // below says what never matched.
              for (;;) {
                const probe = await runPageScript("wait", buildWaitProbeScript(selector), 2_000);
                if (probe.ok) {
                  const value = (probe.value ?? {}) as { ready?: unknown; has?: unknown; url?: unknown; error?: unknown };
                  if (typeof value.error !== "string" || value.error === "") {
                    if (typeof value.ready === "string") lastReady = value.ready;
                    if (typeof value.url === "string") lastUrl = value.url;
                    if (typeof value.has === "boolean") lastHas = value.has;
                    const readyOk = !readyStateNeeded || lastReady === "complete";
                    const selectorOk = selector === "" || lastHas === true;
                    const urlOk = urlContains === "" || (lastUrl ?? "").includes(urlContains);
                    if (readyOk && selectorOk && urlOk) {
                      return {
                        ok: true,
                        output: `wait ok (tab '${sessionId}') → ${JSON.stringify({
                          waited: true,
                          elapsedMs: Date.now() - started,
                          readyState: lastReady,
                          matched: {
                            readyState: readyStateNeeded || undefined,
                            selector: selector === "" ? undefined : true,
                            urlContains: urlContains === "" ? undefined : true,
                          },
                        })}`,
                      };
                    }
                  }
                }
                if (Date.now() >= deadline) break;
                await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(250, deadline - Date.now()))));
              }
              // The honest timeout — every unmet condition, named.
              const unmet: string[] = [];
              if (readyStateNeeded && lastReady !== "complete") {
                unmet.push(
                  `document.readyState is '${lastReady ?? "unknown — the page never answered a probe (it may be navigating)"}' (needs 'complete')`,
                );
              }
              if (selector !== "" && lastHas !== true) unmet.push(`the selector '${selector}' did not appear`);
              if (urlContains !== "" && !(lastUrl ?? "").includes(urlContains)) {
                unmet.push(`the URL still doesn't contain '${urlContains}' (last seen: ${lastUrl ?? "unknown"})`);
              }
              return {
                ok: false,
                output: `browser_control: wait — timed out after ${ms}ms: ${unmet.join("; ")}. Read the page state (read_dom) and decide: wait again, or investigate why the condition never held.`,
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
              if (toolDeps === undefined || toolDeps.db === null || toolDeps.db === undefined) {
                return { ok: false, output: "browser_control: screenshot unavailable — no database in this context" };
              }
              // ── ROUND-98 (R98-G1): the three gate fixes ────────────────────
              // The owner: "it was currently unable to take screenshots of the
              // web browser." The chain had three dishonest gates:
              //  (1) the Computer Use master switch — this action used to
              //      borrow the computer-use RELAY, which is armed inside the
              //      computer-use plugin's createTools ONLY when Settings →
              //      Computer Use is enabled (DEFAULT OFF). Browser
              //      screenshots therefore silently required an unrelated
              //      off-by-default feature. The capture now goes through
              //      getCaptureBackend() — the SAME platform backend + runner
              //      the relay would carry, minus the computer-use
              //      session/relay/settings (computer-use's own path is
              //      untouched — zero regression there).
              //  (2) the R94-E vision gate fired BEFORE any capture work, so
              //      a no-vision session got NOTHING even though the capture
              //      itself has value (the owner's chat thumbnail). The gate
              //      moved below the capture and now gates the DESCRIBE leg
              //      (relayVision) ONLY — the capture, registerRaster, and the
              //      SSE `screenshot` frame are not vision-gated.
              //  (3) a degenerate region PASSED: the frontend clamped a
              //      display:none tab's 0×0 rect with Math.max(1,…) and the
              //      validation below only tested w>0 && h>0 — a 1×1
              //      physical-px capture "succeeded" and photographed ONE
              //      PIXEL of whatever sat behind the app (and when the
              //      webview was hidden — Home view, a covering overlay — the
              //      GDI capture photographed the app DOM, not the page).
              //      Both ends refuse honestly now: the BrowserPanel's
              //      screenshot_meta handler answers an explicit not-visible
              //      ERROR naming the cause, and THIS side enforces a floor —
              //      a sub-50px region never reaches the backend.
              //
              // ── ROUND-124 (R124): the STAGED capture — tried FIRST ────────
              // The owner's verdict: "if I have the application closed, then it
              // cannot take screenshots of the inbuilt browser"… "if the
              // browser window is way too small, then the resolution of the
              // screenshot is way too less"… "this should also happen if the
              // user is in some other application, is in the settings of the
              // program or something else." The app now stages the tab's
              // webview at the FIXED capture resolution (1280×720 logical px,
              // zoom 1 — BROWSER_CAPTURE_WIDTH/HEIGHT above) INSIDE the
              // screenshot_capture command: bounds → settle → the sidecar's
              // own capture route → restore, all atomic in one handler, so it
              // works while the panel is hidden (keep-alive), unmounted
              // (Settings — the module-level bridge fallback answers), or just
              // small (the raster is the staged size, never the view size).
              // The reply carries the PNG bytes + the HONEST geometry (the
              // staged logical size, the raster size, whether the target was
              // clamped to the app window).
              //
              // VERSION SKEW, both directions, honestly handled:
              //  · an OLDER app answers "unknown browser command
              //    'screenshot_capture'" → the LEGACY screenshot_meta path
              //    below runs VERBATIM (its R98-G1 pins still guard it);
              //  · an older app's generic reply that is not the capture
              //    contract → same legacy fallback (never a fabricated
              //    raster);
              //  · THIS app's honest refusals (webview gone, minimized window,
              //    capture failure) arrive as command ERRORS → surfaced
              //    VERBATIM below (the model can act on the named cause).
              let raster: { pngBase64: string; width: number; height: number } | null = null;
              let captureNote = "";
              if (typeof toolDeps.emit === "function") {
                try {
                  const reply = (await sendBrowserCommand(
                    toolDeps.emit,
                    sessionId,
                    "screenshot_capture",
                    { width: BROWSER_CAPTURE_WIDTH, height: BROWSER_CAPTURE_HEIGHT },
                    BROWSER_CAPTURE_COMMAND_TIMEOUT_MS,
                  )) as {
                    pngBase64?: unknown;
                    width?: unknown;
                    height?: unknown;
                    logicalWidth?: unknown;
                    logicalHeight?: unknown;
                    clamped?: unknown;
                  } | null;
                  if (
                    reply !== null &&
                    typeof reply === "object" &&
                    typeof reply.pngBase64 === "string" &&
                    reply.pngBase64.length >= 64 &&
                    typeof reply.width === "number" &&
                    typeof reply.height === "number"
                  ) {
                    raster = { pngBase64: reply.pngBase64, width: reply.width, height: reply.height };
                    const logicalW = typeof reply.logicalWidth === "number" ? Math.round(reply.logicalWidth) : BROWSER_CAPTURE_WIDTH;
                    const logicalH = typeof reply.logicalHeight === "number" ? Math.round(reply.logicalHeight) : BROWSER_CAPTURE_HEIGHT;
                    captureNote =
                      `staged ${logicalW}×${logicalH} logical px, ${raster.width}×${raster.height}px raster` +
                      (reply.clamped === true ? " (clamped to the app window)" : "");
                  }
                  // A reply that is NOT the capture contract (an older app
                  // answered with something else) falls through — raster stays
                  // null and the legacy path below takes over. Never fabricate.
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  if (!/unknown browser command/i.test(message)) {
                    // The NEW app refused honestly — surface the cause
                    // verbatim (same shape as the legacy refusals below).
                    return {
                      ok: false,
                      output:
                        `browser_control: screenshot — ${message} ` +
                        "The panel-only capture NEVER falls back to a full-screen shot. " +
                        "Use action 'read' for the page text or 'read_dom' for the structured content (they work everywhere).",
                    };
                  }
                  // "unknown browser command 'screenshot_capture'" → the app
                  // predates R124 → the legacy path below, verbatim.
                }
              }
              if (raster === null) {
              // ── the LEGACY path (R62 D8 → R98-G1) — an older app's only ──
              // surface, and the honest fallback when no staged reply came.
              // Ask the live UI for the panel's on-screen region (physical px).
              // R87 (the owner: screenshots must be the PANEL ONLY — never the
              // whole display): no answer / web mode → an HONEST ERROR steering
              // to read/read_dom, never a full-display capture (the old fallback
              // leaked the owner's entire screen into the agent's context).
              // R98-G1: the panel's own NOT-VISIBLE refusals (a display:none
              // keep-alive tab, the Home view, a covering overlay, a hidden
              // sidebar) now arrive as command ERRORS — surfaced verbatim
              // instead of being swallowed into the generic no-region message.
              let region: { x: number; y: number; w: number; h: number } | null = null;
              let panelRefusal: string | null = null;
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
                  }
                } catch (error) {
                  // The panel answered with an explicit honest refusal (the
                  // tab is not visible — its message names the cause), or the
                  // bridge reported no mounted handler ("the tab is closed,
                  // inactive, or running outside the desktop app"), or the
                  // command timed out (web dev mode / a wedged UI). Keep the
                  // message — the refusal below surfaces it instead of
                  // guessing a cause.
                  panelRefusal = error instanceof Error ? error.message : String(error);
                }
              }
              if (region === null) {
                return {
                  ok: false,
                  output:
                    `browser_control: screenshot — ${
                      panelRefusal !== null
                        ? panelRefusal
                        : "the browser panel is not mounted in the app right now (web dev mode, or the browser tab is closed)"
                    }, so there is no panel region to capture. ` +
                    "The panel-only capture NEVER falls back to a full-screen shot. " +
                    "Use action 'read' for the page text or 'read_dom' for the structured content (they work everywhere), or make the browser tab visible in the app's right sidebar and retry.",
                };
              }
              // R98-G1 (bug b): the degenerate-region floor. A region smaller
              // than this cannot be a visible browser panel (a display:none
              // rect, a collapsed sidebar, stale geometry) — capturing it
              // would produce a useless sliver and report "success". Refuse
              // honestly, never capture.
              if (region.w < REGION_MIN_PX || region.h < REGION_MIN_PX) {
                return {
                  ok: false,
                  output:
                    `browser_control: screenshot — the browser tab is not visible: its panel region came back as ${region.w}×${region.h}px (a hidden or collapsed panel reports a degenerate rect). ` +
                    "Switch the right sidebar to the Browser panel (and off any view that hides the page) and retry. The panel-only capture NEVER falls back to a full-screen shot. " +
                    "Meanwhile action 'read' gets the page text and 'read_dom' the structured content.",
                };
              }
              // R98-G1 (1): the STANDALONE capture engine — no Computer Use
              // session, no relay, no settings gate. Same platform backend
              // singleton the computer-use dispatcher uses, so capture
              // behavior is identical when both features are on.
              const capture = getCaptureBackend();
              const legacyRaster = await capture.backend.captureRegion(capture.run, region);
              if ("error" in legacyRaster) {
                return {
                  ok: false,
                  output: `browser_control: screenshot — screen capture failed: ${legacyRaster.error}`,
                };
              }
              raster = legacyRaster;
              captureNote = `panel region ${region.w}×${region.h}`;
              }
              // ── ROUND-67 (R67-D): the chat THUMBNAIL frame ────────────────
              // The owner: "if the agent takes screenshots… the images should
              // be shown during its thinking in the agent's chat window itself,
              // in a small view." The capture's bytes are LOCAL to this plugin
              // call, so they are copied into the route-served raster registry
              // under a MINTED id (`bs_<base36>` — no session frame exists for
              // browser captures) and announced as a `screenshot` SSE frame.
              // Never recorded into the computer-use monitor ring (A1 above
              // still holds); never persisted (emit is the SSE-only channel);
              // never model-facing. Enhancement only — try/catch discipline.
              if (toolDeps !== undefined && typeof toolDeps.emit === "function") {
                try {
                  const frameId = `bs_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
                  registerRaster(frameId, raster.pngBase64);
                  toolDeps.emit({
                    type: "screenshot",
                    sessionId: toolDeps.sessionId,
                    frameId,
                    tool: "browser_control",
                    note: "browser panel",
                  });
                } catch {
                  // The thumbnail strip is an enhancement — never break the tool.
                }
              }
              // R66 (A1): NO computer-use session record here — browser
              // screenshots must NOT appear in the computer-use monitor ring
              // (the owner: browser work wrongly showed "agent is using your
              // computer"). The capture + vision description stand alone.
              // ── R98-G1 (2): the DESCRIBE leg — the ONLY vision-gated part ──
              // The capture above succeeded and is already shown to the owner
              // (the thumbnail frame just emitted); the DESCRIPTION needs a
              // seer. NO vision path → the honest refusal rides the SUCCESS
              // output (R94-E's canonical message): the capture is real, the
              // describe is not — steer to the text actions that work.
              // R124: captureNote describes WHICH capture produced the bytes
              // ("staged WxH logical px, WxH px raster" for the fixed-
              // resolution path, "panel region WxH" for the legacy path) —
              // never fabricated, always the honest geometry.
              if (!sessionHasVisionPath(toolDeps.db, toolDeps.mainModel)) {
                return {
                  ok: true,
                  output: `Browser panel screenshot captured (${captureNote}, ${raster.width}×${raster.height}px, page ${state.currentUrl}) — shown to the owner in the chat thumbnail, but NOT described: ${NO_VISION_SCREENSHOT_MESSAGE} Use read / read_dom for the page text; call screenshot only when the owner needs to SEE the panel.`,
                };
              }
              const instruction =
                typeof input.instruction === "string" && input.instruction.trim() !== ""
                  ? input.instruction.trim().slice(0, 500)
                  : "Describe the embedded browser panel in this screenshot: which page/site is open, its visible headline content, main interactive elements, and anything actionable for the task.";
              const vision = await relayVision(toolDeps.db, toolDeps.keyring, toolDeps.mainModel, raster.pngBase64, instruction);
              if (vision.ok) {
                return {
                  ok: true,
                  output: `Browser panel screenshot (${captureNote}, ${raster.width}×${raster.height}px, page ${state.currentUrl}) — vision (${vision.model}) says:\n${vision.text}`,
                };
              }
              return {
                ok: true,
                output: `Browser panel screenshot captured (${captureNote}, ${raster.width}×${raster.height}px, page ${state.currentUrl}), but the vision description is unavailable: ${vision.error}`,
              };
            }

            if (action === "get_state") {
              // R62: the state includes the open tabs + which one is active.
              // R67/E3: the tab list is now SCOPED to what this chat session
              // can drive — its own bound tab (plus any explicitly-addressed
              // tab). The owner's leak report: a new session's get_state used
              // to list EVERY session's tabs globally, inviting the model to
              // drive another session's still-open tab. With no binding yet,
              // the tool mints one above (browser-open frame) — so the agent
              // always sees exactly its own tab.
              const state = browserGetStateCommand(sessionId);
              const known = new Set<string>([sessionId]);
              const payload = {
                ...state,
                activeTab: sessionId,
                tabs: browserListSessionsCommand()
                  .filter((t) => known.has(t.sessionId))
                  .map((t) => ({
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
              output: `browser_control: unknown action '${action}' (navigate | back | forward | reload | set_viewport | read | read_dom | source | click | type | press_key | eval | wait | sequence | screenshot | get_state | wait_for_verification)`,
            };
          };

          // ── ROUND-94 (R94-F): sequence — the multi-stage step chain ──
          // The owner's report: a 45-step browsing session where every
          // hands action failed left the model stringing dozens of tiny
          // tool calls together with NO waiting between them. sequence is
          // the atomic multi-step path: 1-8 steps, ONE tab, first failure
          // stops the chain, and the built-in settle between steps is the
          // "proper waiting" he asked for (250ms; after navigate/back/
          // forward/reload, up to 5s for readyState complete via the wait
          // logic above).
          if (input.action === "sequence") {
            const stepsRaw = input.steps;
            if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
              return {
                ok: false,
                output:
                  "browser_control: sequence requires 'steps' — an array of 1-8 step objects, e.g. {steps: [{action: 'type', selector: '#q', text: 'hello', submit: true}, {action: 'wait', ms: 900}, {action: 'click', selector: 'button[type=submit]'}]}",
              };
            }
            if (stepsRaw.length > 8) {
              return {
                ok: false,
                output: `browser_control: sequence — ${stepsRaw.length} steps is over the cap of 8; split the flow into consecutive sequence calls (each stays focused and its own progress report)`,
              };
            }
            const steps: Array<Record<string, unknown>> = [];
            for (const raw of stepsRaw) {
              if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
                return {
                  ok: false,
                  output: "browser_control: sequence — every step must be an object like {action: 'click', selector: '…'}",
                };
              }
              const step = raw as Record<string, unknown>;
              const stepAction = typeof step.action === "string" ? step.action : "";
              if (stepAction === "sequence") {
                return {
                  ok: false,
                  output:
                    "browser_control: sequence steps cannot include 'sequence' (no nesting) — build the flow as consecutive sequence calls instead",
                };
              }
              if (!SEQUENCE_STEP_ACTIONS.has(stepAction)) {
                return {
                  ok: false,
                  output: `browser_control: sequence — step action '${stepAction}' is not allowed (allowed step actions: ${[...SEQUENCE_STEP_ACTIONS].join(" | ")})`,
                };
              }
              steps.push(step);
            }
            const started = Date.now();
            const results: Array<{ ok: boolean; action: string; output: string }> = [];
            const readyNotes: string[] = [];
            for (let i = 0; i < steps.length; i++) {
              const step = steps[i];
              const stepAction = String(step.action);
              // All steps run on the ONE resolved tab — a per-step
              // sessionId override is stripped (with a note in the step's
              // line) so a step can never silently hop tabs mid-chain.
              const stepSession = typeof step.sessionId === "string" ? step.sessionId.trim() : "";
              const stepInput: Record<string, unknown> = { ...step };
              delete stepInput.sessionId;
              const result = await executeAction(stepInput, sessionId, noTabHint);
              const overrideNote =
                stepSession !== "" && stepSession !== sessionId
                  ? ` (per-step sessionId '${stepSession}' ignored — the sequence runs on tab '${sessionId}')`
                  : "";
              results.push({ ok: result.ok, action: stepAction, output: result.ok ? result.output + overrideNote : result.output });
              if (!result.ok) {
                const lines = results.map((r, n) => `${n + 1}. ${r.ok ? "ok" : "FAILED"} ${r.action} — ${condenseSequenceLine(r.output)}`);
                return {
                  ok: false,
                  output:
                    `browser_control: sequence FAILED at step ${i + 1} (${stepAction}) — steps after it were NOT run. ${condenseSequenceLine(result.output)}\n` +
                    `${lines.join("\n")}` +
                    (readyNotes.length > 0 ? `\n${readyNotes.join("\n")}` : "") +
                    `\nFix or verify step ${i + 1}, then re-run the sequence (or continue with single actions).`,
                };
              }
              // The settle between steps — the built-in proper waiting.
              if (i < steps.length - 1) {
                if (stepAction === "navigate" || stepAction === "back" || stepAction === "forward" || stepAction === "reload") {
                  const settle = await executeAction({ action: "wait", ms: 5_000, readyState: true }, sessionId, "");
                  if (!settle.ok) {
                    readyNotes.push(
                      `(note: the page did not reach readyState complete within 5s before step ${i + 2} — it may still be loading; the step's own result is the honest signal)`,
                    );
                  }
                } else {
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
              }
            }
            const lines = results.map((r, n) => `${n + 1}. ok ${r.action} — ${condenseSequenceLine(r.output)}`);
            return {
              ok: true,
              output:
                `sequence ok (tab '${sessionId}', ${steps.length} step${steps.length === 1 ? "" : "s"}, ${((Date.now() - started) / 1000).toFixed(1)}s) — all steps succeeded:\n` +
                `${lines.join("\n")}` +
                (readyNotes.length > 0 ? `\n${readyNotes.join("\n")}` : "") +
                "\n(step outputs are condensed — call the action directly for its full result)",
            };
          }

          return executeAction(input, sessionId, noTabHint);
        },
      },
    ];
  },
};
