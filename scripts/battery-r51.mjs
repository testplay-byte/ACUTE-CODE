/**
 * ROUND-51 LIVE BATTERY (run inside scripts/dev.mjs lifetime — the sandbox
 * reaps background processes when the launching command exits, so the whole
 * battery runs in ONE command):
 *
 *  S51-1  boot: sidecar + vite up on the R51 tree (migrations apply clean)
 *  S51-2  context report carries the ROUND-51 usage split
 *         (usage.main / usage.subagents / usage.combined) after a real
 *         streamed turn — main > 0, subagents = 0, combined == main.
 *  S51-3  delegation on the R51 prompt + loop-guard tree: a child completes
 *         end-to-end (the loop guard must NOT false-positive on a healthy
 *         varied run) and the /subagents row carries the model.
 *  S51-4  the split widens after delegation: subagents > 0, combined >
 *         main (the child's ledger lands in the subagents group).
 *  S51-5  scripts/export-usage.mjs runs green against the live dev DB and
 *         the export includes the battery's own project.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const REPO = "/home/z/PROJECT/ACUTE-CODE";
const BASE = "http://127.0.0.1:5178/api/v1";
const TOKEN = "acute-dev-local";
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const results = [];
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
  return { status: res.status, text, json };
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
if (!up || !viteUp) { fail("S51-1", `boot sidecar=${up} vite=${viteUp}`); console.log(results.join("\n")); process.exit(1); }
pass("S51-1", "sidecar + vite up on the R51 tree");

try {
  // ── fresh project + session ───────────────────────────────────────────────
  const projectRoot = `/tmp/r51-battery-${Date.now()}`;
  mkdirSync(projectRoot, { recursive: true });
  const project = await api("POST", "/projects", { name: `R51-battery-${Date.now()}`, rootPath: projectRoot });
  const projectId = project.json?.id;
  if (!projectId) { fail("S51-2", `project create failed: ${project.status} ${project.text.slice(0, 150)}`); throw new Error("no project"); }
  const agents = await api("GET", "/agents?includeTemplates=false");
  const agentList = agents.json?.agents ?? [];
  const acute = agentList.find((a) => a.name === "Acute") ?? agentList[0];
  const session = await api("POST", "/sessions", { agentId: acute.id, projectId, mode: "single" });
  const sessionId = session.json?.id;
  if (!sessionId) { fail("S51-2", `session create failed: ${session.status} ${session.text.slice(0, 150)}`); throw new Error("no session"); }

  // ── S51-2: a real streamed turn, then the usage split ─────────────────────
  // thinkingLevel=low keeps the turn cheap; a trivial factual ask needs no
  // tools (round-33 rule) so the turn is fast and deterministic-ish.
  const streamRes = await fetch(`${BASE}/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ content: "Reply with exactly the word: pinecone", thinkingLevel: "low" }),
  });
  const streamText = await streamRes.text();
  const ok1 = streamRes.status === 200 && /pinecone/i.test(streamText);
  if (ok1) pass("S51-2a", "streamed turn completed on the R51 prompt+guard tree");
  else fail("S51-2a", `stream status=${streamRes.status} tail=${streamText.slice(-300)}`);

  await sleep(800); // usage ledger flush
  const ctx1 = await api("GET", `/sessions/${sessionId}/context`);
  const usage1 = ctx1.json?.usage;
  const splitOk = usage1 && typeof usage1.main?.inputTokens === "number" &&
    usage1.main.inputTokens > 0 && usage1.subagents &&
    usage1.combined && usage1.combined.inputTokens === usage1.main.inputTokens + usage1.subagents.inputTokens;
  if (splitOk) pass("S51-2", `usage split live: main=${usage1.main.inputTokens}in sub=${usage1.subagents.inputTokens}in combined=${usage1.combined.inputTokens}in`);
  else fail("S51-2", `usage split missing/wrong: ${JSON.stringify(usage1)?.slice(0, 200)}`);

  // ── S51-3: delegation with the new prompt + loop guard ────────────────────
  const del = await fetch(`${BASE}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ content: "Delegate one sub-agent task: ask it to reply with exactly the word: cedar. Nothing else.", model: "deepseek/deepseek-chat-v3.1" }),
  });
  const delText = await del.text();
  let childDone = false;
  for (let i = 0; i < 90 && !childDone; i++) {
    await sleep(2000);
    const rows = await api("GET", `/sessions/${sessionId}/subagents`);
    const list = rows.json?.subagents ?? rows.json ?? [];
    childDone = Array.isArray(list) && list.some((s) => s.status === "completed" || s.status === "failed");
  }
  const rowsFinal = await api("GET", `/sessions/${sessionId}/subagents`);
  const listFinal = rowsFinal.json?.subagents ?? rowsFinal.json ?? [];
  const child = Array.isArray(listFinal) ? listFinal.find((s) => s.status === "completed" || s.status === "failed") : null;
  if (del.status === 200 && child && child.status === "completed" && typeof child.model === "string" && child.model.length > 0) {
    pass("S51-3", `delegation completed on the R51 tree (child model=${child.model}, /subagents row carries it)`);
  } else {
    fail("S51-3", `delegation: status=${del.status} child=${child ? child.status : "none"} model=${child?.model ?? "?"}`);
  }

  // ── S51-4: the split widens after delegation ──────────────────────────────
  await sleep(800);
  const ctx2 = await api("GET", `/sessions/${sessionId}/context`);
  const usage2 = ctx2.json?.usage;
  if (usage2 && usage2.subagents.inputTokens > 0 && usage2.combined.inputTokens > usage2.main.inputTokens) {
    pass("S51-4", `split widens: sub=${usage2.subagents.inputTokens}in > 0, combined=${usage2.combined.inputTokens}in > main=${usage2.main.inputTokens}in`);
  } else {
    fail("S51-4", `usage split after delegation: ${JSON.stringify(usage2)?.slice(0, 200)}`);
  }

  // ── S51-5: the usage export script runs green on the live dev DB ─────────
  const exp = spawnSync("node", ["scripts/export-usage.mjs", "--out", "/tmp/r51-usage.json"], { cwd: REPO, encoding: "utf8" });
  let exportOk = exp.status === 0;
  if (exportOk) {
    try {
      const data = JSON.parse(readFileSync("/tmp/r51-usage.json", "utf8"));
      const found = (data.projects ?? []).some((p) => typeof p.name === "string" && p.name.startsWith("R51-battery-"));
      exportOk = found;
    } catch { exportOk = false; }
  }
  if (exportOk) pass("S51-5", "export-usage.mjs green on the live DB and includes this battery's project");
  else fail("S51-5", `export exit=${exp.status} tail=${(exp.stdout + exp.stderr).slice(-200)}`);

} catch (err) {
  fail("S51-crash", err instanceof Error ? err.message : String(err));
} finally {
  try { process.kill(-dev.pid, "SIGKILL"); } catch { /* already gone */ }
  spawnSync("pkill", ["-f", "agent-core/dist/main.js"]);
  spawnSync("pkill", ["-f", "vite/bin/vite.js"]);
}

const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n[battery] ${results.length - failed}/${results.length} checks green`);
process.exit(failed > 0 ? 1 : 0);
