/**
 * ROUND-49 LIVE BATTERY (run inside scripts/dev.mjs lifetime — the sandbox
 * reaps background processes when the launching command exits, so the whole
 * battery runs in ONE command):
 *
 *  S49-1  memory settings round-trip (GET/PUT /settings/memory)
 *  S49-2  migration 0019 present on the pre-R49 dev DB
 *  S49-3  THE OWNER'S EXACT SCENARIO: main agent delegates to a sub-agent
 *         that CREATES A FOLDER + a formatted story .md with its own tools
 *         (the thing that failed on Windows: "no write_file/list_dir").
 *  S49-4  the created files exist on disk with markdown content
 *  S49-5  browser proxy: rewritten sub-resource URLs are ABSOLUTE against
 *         the sidecar origin (the CSS/JS 404 fix) and a rewritten
 *         stylesheet actually returns CSS through the proxy.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";


const REPO = "/home/z/PROJECT/ACUTE-CODE";
const BASE = "http://127.0.0.1:5178/api/v1";
const TOKEN = "acute-dev-local";
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const results = [];
let batteryPublicDir = "";
const pass = (id, note) => { results.push(`PASS ${id} — ${note}`); console.log(`PASS ${id} — ${note}`); };
const fail = (id, note) => { results.push(`FAIL ${id} — ${note}`); console.log(`FAIL ${id} — ${note}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, extraHeaders) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...H, ...(extraHeaders ?? {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, text, json, headers: res.headers };
}

// ── boot the stack ──────────────────────────────────────────────────────────
const keys = {
  ACUTE_PROVIDER_OPENROUTER: readFileSync("/home/z/.secrets/openrouter-main.key", "utf8").trim(),
  ACUTE_PROVIDER_OPENROUTER_SLOT1: readFileSync("/home/z/.secrets/openrouter-sub1.key", "utf8").trim(),
  ACUTE_PROVIDER_OPENROUTER_SLOT2: readFileSync("/home/z/.secrets/openrouter-sub2.key", "utf8").trim(),
  ACUTE_PROVIDER_OPENROUTER_SLOT3: readFileSync("/home/z/.secrets/openrouter-sub3.key", "utf8").trim(),
};
spawnSync("pkill", ["-f", "agent-core/dist/main.js"]);
spawnSync("pkill", ["-f", "scripts/dev.mjs"]);
spawnSync("pkill", ["-f", "vite/bin/vite.js"]);
await sleep(1500);
const dev = spawn("node", ["scripts/dev.mjs"], {
  cwd: REPO,
  env: { ...process.env, ...keys },
  stdio: ["ignore", "inherit", "inherit"],
  detached: true,
});
let up = false;
let viteUp = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try {
    const res = await fetch(`${BASE}/projects`, { headers: H });
    if (res.status === 200) up = true;
    const vite = await fetch("http://[::1]:5173/");
    if (vite.status === 200) viteUp = true;
    if (up && viteUp) break;
  } catch { /* not yet */ }
}
if (!up || !viteUp) { fail("S49-boot", `sidecar=${up} vite=${viteUp}`); console.log(results.join("\n")); process.exit(1); }
console.log("[battery] sidecar + vite up");

try {
  // ── S49-1: memory settings round-trip ────────────────────────────────────
  try {
    const init = await api("GET", "/settings/memory");
    const off = await api("PUT", "/settings/memory", { enabled: false });
    const reread = await api("GET", "/settings/memory");
    const on = await api("PUT", "/settings/memory", { enabled: true });
    const bad = await api("PUT", "/settings/memory", { enabled: "yes" });
    if (
      init.status === 200 && init.json.enabled === true &&
      off.json.enabled === false && reread.json.enabled === false &&
      on.json.enabled === true && bad.status === 400
    ) {
      pass("S49-1", `memory settings round-trip (default on → off → persists → on; invalid → 400)`);
    } else {
      fail("S49-1", `unexpected: init=${init.status}/${JSON.stringify(init.json)} off=${JSON.stringify(off.json)} bad=${bad.status}`);
    }
  } catch (e) { fail("S49-1", e.message); }

  // ── S49-2: migration 0019 on the real dev DB ─────────────────────────────
  try {
    const { createRequire } = await import("node:module");
    const require2 = createRequire(`${REPO}/agent-core/package.json`);
    const Database = require2("better-sqlite3");
    const db = new Database(`${REPO}/.dev/acute.db`, { readonly: true });
    const rows = db.prepare("SELECT version, name FROM schema_migrations WHERE version = 19").all();
    const agentRow = db.prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_default_nova'").get();
    db.close();
    if (rows.length === 1 && rows[0].name === "0019_repair_default_agent_tools.sql" && agentRow.allowed_tools === "[]") {
      pass("S49-2", `migration 0019 applied; default agent allowed_tools = [] (ALL tools)`);
    } else {
      fail("S49-2", `migrations=${JSON.stringify(rows)} agent=${JSON.stringify(agentRow)}`);
    }
  } catch (e) { fail("S49-2", e.message); }

  // ── S49-3: THE OWNER'S SCENARIO (delegation with real file tools) ────────
  // Fresh root per run: POST /projects 409s on a reused folder path (and a
  // project-less session silently gets NO tools — the battery must measure
  // the real project path).
  const projectRoot = `/tmp/acute-r49-battery-${Date.now()}`;
  rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(`${projectRoot}/AGENTS.md`, "# R49 Battery\nTemporary battery project.\n");

  const TASK =
    "Run a sub-agent (delegate_task, role coder) to do the following: create a folder called " +
    "ShortStories in this project's root directory, and inside it create a markdown file named " +
    "story.md containing a short story of about 200 words with proper markdown formatting — " +
    "a title heading, at least two section headings, and a final horizontal rule. The sub-agent " +
    "must do the actual work with its own tools (create_dir + write_file). When the sub-agent " +
    "finishes, tell me exactly which files were created.";

  try {
    const proj = await api("POST", "/projects", { name: `R49 Battery ${Date.now()}`, rootPath: projectRoot });
    if (proj.status !== 201 || typeof proj.json?.id !== "string") {
      fail("S49-3", `project creation failed: ${proj.status} ${proj.text.slice(0, 200)}`);
      throw new Error("project creation failed");
    }
    const agents = await api("GET", "/agents?includeTemplates=false");
    const list = agents.json?.agents ?? [];
    const acute = list.find((a) => a.name === "Acute") ?? list[0];
    const sess = await api("POST", "/sessions", { agentId: acute.id, projectId: proj.json.id, mode: "single" });
    const sessionId = sess.json.id;
    console.log(`[battery] session ${sessionId} — sending the delegation task (this runs the full agentic loop; 2-6 min)…`);

    const started = Date.now();
    // The default free GLM model intermittently emits tool calls as TEXT
    // (a model limitation, not a machinery bug) — the battery pins a
    // reliably tool-calling model so it measures OUR delegation machinery.
    const msg = await api("POST", `/sessions/${sessionId}/messages`, { content: TASK, model: "deepseek/deepseek-chat-v3.1" });
    const took = Math.round((Date.now() - started) / 1000);
    const replyText = msg.json?.assistantMessage?.content ?? msg.text.slice(0, 400);
    console.log(`[battery] main turn finished in ${took}s (status ${msg.status})`);

    const subs = await api("GET", `/sessions/${sessionId}/subagents`);
    const rows = subs.json?.subagents ?? [];
    const childEvents = [];
    for (const row of rows) {
      // GET /sessions/:id returns the session WITH its full event log.
      const ev = await api("GET", `/sessions/${row.id}`);
      const list = Array.isArray(ev.json?.events) ? ev.json.events : [];
      childEvents.push(...list);
    }
    const toolUses = childEvents.filter((e) => e.type === "tool.use").map((e) => e.payload?.toolName ?? e.payload?.name);
    const sawCreateDir = toolUses.includes("create_dir");
    const sawWriteFile = toolUses.includes("write_file");

    // ── S49-4: the files exist ──────────────────────────────────────────────
    const storyPath = `${projectRoot}/ShortStories/story.md`;
    const storyExists = existsSync(storyPath);
    let storyOk = false;
    if (storyExists) {
      const story = readFileSync(storyPath, "utf8");
      storyOk = /^#\s/m.test(story) && /^##\s/m.test(story) && story.includes("---") && story.length > 400;
    }

    if (msg.status === 200 && rows.length >= 1 && sawCreateDir && sawWriteFile && storyOk) {
      pass("S49-3", `delegation end-to-end: ${rows.length} sub-agent(s), child tools [${[...new Set(toolUses)].join(", ")}], turn ${took}s`);
      pass("S49-4", `ShortStories/story.md on disk (${storyExists}) with markdown title/sections/rule (${storyOk})`);
    } else {
      fail("S49-3", `msg=${msg.status} subs=${rows.length} childTools=[${toolUses.join(",")}] createDir=${sawCreateDir} writeFile=${sawWriteFile}`);
      fail("S49-4", `story exists=${storyExists} markdownOk=${storyOk}`);
      console.log(`[battery] main reply head: ${replyText.slice(0, 600)}`);
    }
  } catch (e) { fail("S49-3", e.message); fail("S49-4", e.message); }

  // ── S49-5: browser proxy absolute rewrites + stylesheet fetch ────────────
  // Wikipedia 403s this sandbox's datacenter IP, so the battery serves its
  // OWN page (external CSS + JS + img) from the vite dev server — one of the
  // private-net-allowlisted origins — and drives the full sub-resource
  // pipeline through the proxy against a REAL http upstream.
  batteryPublicDir = `${REPO}/public/__r49_battery__`;
  mkdirSync(batteryPublicDir, { recursive: true });
  writeFileSync(`${batteryPublicDir}/page.html`,
    "<!doctype html><html><head><title>R49 Battery Page</title>" +
    '<link rel="stylesheet" href="style.css">' +
    '</head><body><h1>Battery</h1><img src="cat.png">' +
    '<script src="app.js"></script></body></html>');
  writeFileSync(`${batteryPublicDir}/style.css`,
    "body { background: url('bg.png'); }\n.card { color: #FF6B2C; }\n/* r49 battery stylesheet */");
  writeFileSync(`${batteryPublicDir}/app.js`, "console.log('r49 battery script');");
  writeFileSync(`${batteryPublicDir}/cat.png`, Buffer.alloc(8));
  writeFileSync(`${batteryPublicDir}/bg.png`, Buffer.alloc(8));
  try {
    const mint = await api("POST", "/browser/session", { sessionId: "r49bat" });
    if (mint.status !== 200) fail("S49-5", `ticket mint failed: ${mint.status} ${mint.text.slice(0, 200)}`);
    const bt = mint.json.ticket;
    const page = await fetch(`${BASE}/browser/proxy?url=${encodeURIComponent("http://[::1]:5173/__r49_battery__/page.html")}&sessionId=r49bat&bt=${bt}`, {
      headers: { host: "127.0.0.1:5178", accept: "text/html" },
    });
    const html = await page.text();
    const absoluteCount = (html.match(/https?:\/\/127\.0\.0\.1:5178\/api\/v1\/browser\/proxy\?/g) ?? []).length;
    const cssMatch = html.match(/href="(https?:\/\/127\.0\.0\.1:5178\/api\/v1\/browser\/proxy\?[^"]+)"/);

    let cssOk = false;
    let cssType = "";
    if (cssMatch) {
      const cssRes = await fetch(cssMatch[1].replace(/&amp;/g, "&"), { headers: { "sec-fetch-dest": "style" } });
      cssType = cssRes.headers.get("content-type") ?? "";
      const cssBody = await cssRes.text();
      cssOk = cssRes.status === 200 && /css/i.test(cssType) && cssBody.length > 20 && cssBody.includes("r49 battery stylesheet");
    }
    const jsMatch = html.match(/src="(https?:\/\/127\.0\.0\.1:5178\/api\/v1\/browser\/proxy\?[^"]+)"/);
    if (page.status === 200 && absoluteCount >= 3 && cssOk && jsMatch !== null) {
      pass("S49-5", `proxy rewrites: ${absoluteCount} absolute sidecar URLs; stylesheet round-trip via proxy (content-type ${cssType.split(";")[0]})`);
    } else {
      fail("S49-5", `page=${page.status} absolute=${absoluteCount} cssOk=${cssOk} cssType=${cssType} cssHref=${cssMatch?.[1]?.slice(0, 80)}`);
      console.log(`[battery] page body head: ${html.slice(0, 300)}`);
    }
  } catch (e) { fail("S49-5", e.message); }
} finally {
  try { if (batteryPublicDir !== "") rmSync(batteryPublicDir, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log("\n=== BATTERY SUMMARY ===");
  console.log(results.join("\n"));
  try { process.kill(-dev.pid, "SIGTERM"); } catch { /* already gone */ }
  try { process.kill(dev.pid, "SIGTERM"); } catch { /* already gone */ }
}
