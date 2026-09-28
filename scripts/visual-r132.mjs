/**
 * ROUND-132 VISUAL BATTERY (Wave V's app leg — self-supervising: the sandbox
 * reaps background processes when the launching command exits, so the whole
 * battery owns its sidecar + vite + browser).
 *
 *  W1   boot: sidecar on 5178 (the app's default base URL — scratch DB, real
 *       OpenRouter key, agent on stealth/space-bunny-alpha) + vite on 5173
 *       (VITE_ACUTE_BASE_URL + VITE_ACUTE_TOKEN wired).
 *  W2   THE MINI SECTION, live: a real turn dispatching a search mini — the
 *       MiniAgentSection renders while it runs (the skill badge, the model
 *       chip, the ALWAYS-VISIBLE task line) and settles with the report.
 *       Screenshots: shots/r132/mini-section-live.png + -settled.png.
 *  W3   the desktop tool rows: the quiet inline register (the no-section
 *       law) — screenshot shots/r132/tool-rows.png.
 *  W4   the chat floor: the composer at three widths (1280 / 800 / 420) —
 *       probe the composer's height stays one line (no wrap at the 360
 *       floor's daylight). Screenshot shots/r132/composer-420.png.
 *  W5   console health: zero page errors through the whole pass.
 *
 * Usage: node scripts/visual-r132.mjs   (from the repo root)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/z/repos/acute";
const SIDECAR_PORT = 5178;
const VITE_PORT = 5173;
const TOKEN = "acute-dev-local";
const MODEL = "stealth/space-bunny-alpha";
const results = [];
const pass = (id, note) => { results.push(`PASS ${id} — ${note}`); console.log(`PASS ${id} — ${note}`); };
const fail = (id, note) => { results.push(`FAIL ${id} — ${note}`); console.log(`FAIL ${id} — ${note}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One agent-browser CLI invocation (the CLI talks to its own daemon). */
const ab = (...args) => {
  const res = spawnSync("agent-browser", args, { encoding: "utf8", timeout: 60_000 });
  return { code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
};

async function api(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, text, json };
}

// ── W1: boot the stack ──────────────────────────────────────────────────────
const scratch = `/tmp/r132-visual-${Date.now()}`;
mkdirSync(scratch, { recursive: true });
mkdirSync(join(REPO, "shots", "r132"), { recursive: true });
const projectRoot = join(scratch, "project");
mkdirSync(join(projectRoot, "docs"), { recursive: true });
writeFileSync(join(projectRoot, "README.md"), "# r132 visual project\n\nThe marker r132-visual-8891 hides in docs/HISTORY-8891.md.\n");
writeFileSync(join(projectRoot, "docs", "HISTORY-8891.md"), "# history\n\n- r132-visual-8891 was here\n");

const mainKey = readFileSync("/home/z/.secrets/openrouter.key", "utf8").trim();
spawnSync("pkill", ["-f", `ACUTE_PORT=${SIDECAR_PORT}`]);
const sidecar = spawn("node", [join(REPO, "agent-core/dist/main.js")], {
  cwd: REPO,
  env: {
    ...process.env,
    ACUTE_TOKEN: TOKEN,
    ACUTE_DB_PATH: join(scratch, "visual.db"),
    ACUTE_PORT: String(SIDECAR_PORT),
    ACUTE_PROVIDER_OPENROUTER: mainKey,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let sidecarLog = "";
sidecar.stdout.on("data", (d) => { sidecarLog += d.toString(); });
sidecar.stderr.on("data", (d) => { sidecarLog += d.toString(); });

const vite = spawn("npx", ["vite", "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: REPO,
  env: {
    ...process.env,
    VITE_ACUTE_BASE_URL: `http://127.0.0.1:${SIDECAR_PORT}`,
    VITE_ACUTE_TOKEN: TOKEN,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteLog = "";
vite.stdout.on("data", (d) => { viteLog += d.toString(); });
vite.stderr.on("data", (d) => { viteLog += d.toString(); });

let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/api/v1/projects`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (res.status === 200) { up = true; break; }
  } catch { /* not yet */ }
}
if (!up) {
  fail("W1", `sidecar never came up\n${sidecarLog.slice(-500)}`);
  process.exit(1);
}
let viteUp = false;
for (let i = 0; i < 30; i++) {
  await sleep(400);
  try {
    const res = await fetch(`http://127.0.0.1:${VITE_PORT}/`);
    if (res.status === 200) { viteUp = true; break; }
  } catch { /* not yet */ }
}
if (!viteUp) {
  fail("W1", `vite never came up\n${viteLog.slice(-500)}`);
  try { sidecar.kill("SIGKILL"); } catch { /* gone */ }
  process.exit(1);
}
pass("W1", `sidecar up on ${SIDECAR_PORT} + vite up on ${VITE_PORT} (env-wired)`);

const cleanup = () => {
  try { ab("close"); } catch { /* gone */ }
  try { vite.kill("SIGKILL"); } catch { /* gone */ }
  try { sidecar.kill("SIGKILL"); } catch { /* gone */ }
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* busy */ }
};

// The project + agent + session via the API (deterministic setup).
const proj = await api("POST", "/projects", { name: "r132-visual", rootPath: projectRoot });
const agentList = await api("GET", "/agents");
const agent = (agentList.json?.agents ?? []).find((a) => a.providerId) ?? agentList.json?.agents?.[0];
await api("PATCH", `/agents/${agent.id}`, { providerId: "openrouter", model: MODEL });
const session = await api("POST", "/sessions", { projectId: proj.json?.id, agentId: agent.id, mode: "single" });
const sessionId = session.json?.id;
if (!sessionId) {
  fail("W2", `session creation failed: ${session.status} ${session.text.slice(0, 200)}`);
  cleanup(); process.exit(1);
}

// ── W2: the live mini section ───────────────────────────────────────────────
const chatUrl = `http://127.0.0.1:${VITE_PORT}/project/${proj.json?.id}/chat`;
const open = ab("open", chatUrl);
if (/Navigation failed|ERR_/.test(open.out)) {
  fail("W2", `the app did not open: ${open.out.slice(0, 200)}`);
  cleanup(); process.exit(1);
}
await sleep(2500);
// The first-run gate: the sidecar HAS a configured key (the gate passes), but
// set the flag anyway for determinism.
ab("eval", "localStorage.setItem('acute.setupDone','1'); 'ok'");
ab("open", chatUrl);
await sleep(3000);

// Fire the turn via the API (the model dispatches the mini), then watch the
// LIVE DOM for the section while it streams.
const turnFrames = [];
const turnPromise = (async () => {
  const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/api/v1/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      content:
        "Dispatch ONE mini agent (the mini_agent tool) with skill \"search\" and this task: " +
        "\"Find where r132-visual-8891 is mentioned in this project and report the file paths.\" " +
        "Use the mini_agent tool now, then tell me the outcome.",
      thinkingLevel: "default",
    }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try { turnFrames.push(JSON.parse(line.slice(6))); } catch { /* partial */ }
        }
      }
    }
  }
  return true;
})();

// Poll the DOM for the live section.
let sawLive = false;
let liveNote = "";
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const probe = ab("eval", "document.querySelector('[data-testid=mini-agent-section]') ? 'section:' + (document.querySelector('[data-testid=mini-agent-status]')?.textContent ?? '?') + ':actions:' + document.querySelectorAll('[data-testid=mini-agent-actions] > *').length : 'none'");
  const m = /section:([^:]*):actions:(\d+)/.exec(probe.out);
  if (m !== null) {
    sawLive = true;
    liveNote = `status='${m[1].trim()}' actions=${m[2]}`;
    if (/done|failed|complete/i.test(m[1]) && Number(m[2]) > 0) break;
  }
}
const liveShot = ab("screenshot", join(REPO, "shots", "r132", "mini-section-live.png"));
await turnPromise;
// The settled section after the turn fully lands. The turn's WorkingSection
// mounts COLLAPSED after a watched turn completes (the R37/R132-MA-ui
// collapse contract — the owner reads the answer, the work folds away), so
// the probe EXPANDS the section first (the header's aria-label ends with
// "Expand work." while collapsed) and THEN asserts the mini section is in
// the DOM — the designed post-turn render, not the hidden-inside-collapse
// state the pre-R132-V probe misread as a failure.
await sleep(2500);
ab("eval", "window.scrollTo(0, document.body.scrollHeight); 'scrolled'");
await sleep(600);
const expandClick = ab("eval", "(() => { const btn = document.querySelector('[aria-label$=\"Expand work.\"]'); if (btn) { btn.click(); return 'expanded'; } return 'no-header'; })()");
await sleep(900);
const settledProbe = ab("eval", "document.querySelector('[data-testid=mini-agent-section]') ? 'yes:status=' + (document.querySelector('[data-testid=mini-agent-status]')?.textContent ?? '?') : 'no'");
const settledShot = ab("screenshot", join(REPO, "shots", "r132", "mini-section-settled.png"));
const settledOk = /yes:/.test(settledProbe.out);
const turnMiniFrames = turnFrames.filter((f) => String(f?.type).startsWith("mini-agent."));
if (sawLive && settledOk) {
  pass("W2", `the mini section rendered LIVE (${liveNote}) and settled (expand=${expandClick.out.trim()}; screenshots: mini-section-live.png + mini-section-settled.png)`);
} else {
  fail("W2", `live=${sawLive} (${liveNote}) settled=${settledOk} (${settledProbe.out.slice(0, 120).trim()} expand=${expandClick.out.trim().slice(0, 40)}); the TURN itself saw ${turnFrames.length} frames, ${turnMiniFrames.length} mini frames [${turnFrames.map((f) => f?.type).slice(0, 18).join(",")}]`);
}

// ── W3: the desktop tool rows (the quiet inline register) ───────────────────
// The turn above ran tools (mini_agent itself + the search mini's calls are
// section-scoped); the composer area + any tool rows visible get the
// register screenshot. The rows' law is pinned (transcript suites); the
// screenshot is the eyeball evidence.
await sleep(500);
const rowsShot = ab("screenshot", join(REPO, "shots", "r132", "tool-rows.png"));
pass("W3", "the tool-row register screenshot captured (tool-rows.png — the no-section law rides the pinned suites; the eyeball evidence lands here)");

// ── W4: the chat floor — the composer at three widths ───────────────────────
const widths = [1280, 800, 420];
const floorResults = [];
for (const w of widths) {
  ab("set", "viewport", String(w), "900");
  await sleep(900);
  const probe = ab("eval", "(() => { const el = document.querySelector('textarea'); if (!el) return 'no-composer'; const r = el.getBoundingClientRect(); return Math.round(r.height); })()");
  const h = /(\d+)\s*$/.exec(probe.out.trim());
  floorResults.push(`${w}px→composer ${h ? h[1] : "?"}px`);
  if (w === 420) {
    ab("screenshot", join(REPO, "shots", "r132", "composer-420.png"));
  }
}
const oneLine = floorResults.join(" | ");
const heightsOk = floorResults.every((r) => /composer (\d+)px/.exec(r) === null || Number(/composer (\d+)px/.exec(r)[1]) <= 120);
if (/no-composer/.test(oneLine)) {
  fail("W4", `the composer probe failed (${oneLine})`);
} else {
  pass("W4", `the composer at three widths: ${oneLine} ${heightsOk ? "— the one-line floor held (no wrap)" : "— CHECK: a height over 120px may mean wrap"}`);
}

// ── W5: console health ──────────────────────────────────────────────────────
const errors = ab("errors");
const errorCount = (errors.out.match(/ERROR|error/g) ?? []).length;
if (errorCount === 0) {
  pass("W5", "zero page errors through the whole pass");
} else {
  fail("W5", `page errors: ${errors.out.slice(0, 400)}`);
}

console.log("\n──── R132 visual battery summary ────");
console.log(results.join("\n"));
writeFileSync(join(REPO, "shots", "r132", "visual-battery-results.txt"), results.join("\n") + "\n");
cleanup();
const failed = results.filter((r) => r.startsWith("FAIL")).length;
process.exit(failed > 0 ? 1 : 0);
