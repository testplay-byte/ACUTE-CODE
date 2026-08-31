/**
 * ROUND-58 LIVE BATTERY (run inside ONE command — the sandbox reaps
 * background processes when the launching command exits, so the whole
 * battery supervises its own sidecar):
 *
 *  S58-1  boot: dedicated sidecar on a spare port (5199) with the real
 *         OpenRouter key, fresh scratch DB.
 *  S58-2  the owner's exact Windows test task, streamed: "create a folder
 *         with html/css/json files" — verify (a) the NEW tool-input-start /
 *         tool-input-delta frames arrive DURING arg generation (the live
 *         file-write preview source, in arrival order: input-start BEFORE
 *         tool-call), and (b) the files are actually created on disk.
 *  S58-3  stop path: start a long streamed turn, POST /sessions/:id/stop
 *         mid-flight — verify (a) the terminal `stopped` frame arrives,
 *         (b) the session status is `queued` right after (the sidebar
 *         eternal-spinner fix), and (c) the partial streamed text was
 *         flushed/persisted as a message.assistant event (the Continue
 *         fix — the partial no longer vanishes).
 *  S58-4  continue: send "Continue from where you left off." on the stopped
 *         session — the turn must complete OK (history replay includes the
 *         partial + tool results).
 *  S58-5  reveal route: POST /providers/openrouter/keys/reveal returns the
 *         real key values (the owner's visible-keys demand).
 *
 * Usage: node scripts/battery-r58.mjs   (from the repo root)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/z/PROJECT/ACUTE-CODE";
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const TOKEN = "acute-dev-local";
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const results = [];
const pass = (id, note) => { results.push(`PASS ${id} — ${note}`); console.log(`PASS ${id} — ${note}`); };
const fail = (id, note) => { results.push(`FAIL ${id} — ${note}`); console.log(`FAIL ${id} — ${note}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      // Only set content-type when a body rides along — Fastify 400s an
      // empty body with a JSON content-type (cost the battery its first run).
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, text, json };
}

/** Read the stream of a turn, collecting every SSE frame. */
async function streamTurn(sessionId, content, signalAbort, onFrame) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ content, thinkingLevel: "default" }),
    signal: signalAbort,
  });
  if (res.status !== 200) return { status: res.status, frames: [], text: "" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames = [];
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const frame = JSON.parse(line.slice(6));
            frames.push(frame);
            if (frame.type === "text-delta" && typeof frame.delta === "string") text += frame.delta;
            if (onFrame !== undefined) onFrame(frame, text);
          } catch { /* partial frame */ }
        }
      }
    }
  } catch (err) {
    frames.push({ type: "__reader_error", message: String(err?.message ?? err) });
  }
  return { status: res.status, frames, text };
}

const terminalType = (frames) => {
  const t = frames.filter((f) => f.type === "done" || f.type === "stopped" || f.type === "error");
  return t.length > 0 ? t[t.length - 1].type : null;
};

// ── S58-1: boot the dedicated sidecar ───────────────────────────────────────
const scratch = `/tmp/r58-battery-${Date.now()}`;
mkdirSync(scratch, { recursive: true });
const mainKey = readFileSync("/home/z/.secrets/openrouter-main.key", "utf8").trim();
spawnSync("pkill", ["-f", `ACUTE_PORT=${PORT}`]); // only OUR battery port, never the dev stack
const sidecar = spawn("node", [join(REPO, "agent-core/dist/main.js")], {
  cwd: REPO,
  env: {
    ...process.env,
    ACUTE_TOKEN: TOKEN,
    ACUTE_DB_PATH: join(scratch, "battery.db"),
    ACUTE_PORT: String(PORT),
    ACUTE_PROVIDER_OPENROUTER: mainKey,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let sidecarLog = "";
sidecar.stdout.on("data", (d) => { sidecarLog += d.toString(); });
sidecar.stderr.on("data", (d) => { sidecarLog += d.toString(); });

let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const res = await fetch(`${BASE}/projects`, { headers: H });
    if (res.status === 200) { up = true; break; }
  } catch { /* not yet */ }
}
if (!up) {
  fail("S58-1", `sidecar never came up on ${PORT}\n${sidecarLog.slice(-600)}`);
  console.log(results.join("\n"));
  process.exit(1);
}
pass("S58-1", `dedicated sidecar up on ${PORT}`);

try {
  // ── fresh project + agent + session (a PROJECT is what grants file
  // tools — a projectless session runs tool-less by design) ──────────────
  const projectRoot = join(scratch, "site");
  mkdirSync(projectRoot, { recursive: true });
  const project = await api("POST", "/projects", { name: `R58-battery-${Date.now()}`, rootPath: projectRoot });
  const projectId = project.json?.id;
  if (!projectId) { fail("S58-2", `project create failed: ${project.status} ${project.text.slice(0, 150)}`); throw new Error("no project"); }
  const agentRes = await api("POST", "/agents", {
    name: "R58 Battery Agent",
    systemPrompt: "You are a helpful coding agent. Complete tasks with real tool calls.",
    providerId: "openrouter",
    model: "z-ai/glm-5.2:free",
    temperature: 0.2,
    maxTurns: 8,
  });
  const agentId = agentRes.json?.id;
  if (!agentId) { fail("S58-2", `agent create failed: ${agentRes.status} ${agentRes.text.slice(0, 150)}`); throw new Error("no agent"); }
  const sessionRes = await api("POST", "/sessions", { agentId, mode: "single", title: "R58 battery", projectId });
  const sessionId = sessionRes.json?.id;
  if (!sessionId) { fail("S58-2", `session create failed: ${sessionRes.status}`); throw new Error("no session"); }

  // ── S58-2: the owner's exact task, streamed, with frame-order checks ─────
  const task =
    `Create a folder at ${projectRoot} and inside it create exactly three files: index.html (a tiny valid HTML page that loads style.css and script.js), style.css (a tiny stylesheet), and script.json (a small valid JSON config). Then briefly summarize what you did. When finished, say "Done."`;
  const turn = await streamTurn(sessionId, task);
  const term = terminalType(turn.frames);
  const inputStarts = turn.frames.filter((f) => f.type === "tool-input-start");
  const inputDeltas = turn.frames.filter((f) => f.type === "tool-input-delta");
  const toolCalls = turn.frames.filter((f) => f.type === "tool-call");
  const firstInputStart = turn.frames.findIndex((f) => f.type === "tool-input-start");
  const firstToolCall = turn.frames.findIndex((f) => f.type === "tool-call");
  const htmlOk = existsSync(join(projectRoot, "index.html"));
  const cssOk = existsSync(join(projectRoot, "style.css"));
  const jsonOk = existsSync(join(projectRoot, "script.json"));
  if (term !== "done") {
    fail("S58-2", `stream terminal frame = ${term ?? "none"} (last frames: ${turn.frames.slice(-3).map((f) => f.type).join(",")})`);
  } else if (toolCalls.length === 0 || !htmlOk || !cssOk || !jsonOk) {
    fail("S58-2", `tools=${toolCalls.length} files html=${htmlOk} css=${cssOk} json=${jsonOk}`);
  } else if (inputStarts.length === 0 || inputDeltas.length === 0) {
    fail("S58-2", `no tool-input frames (starts=${inputStarts.length} deltas=${inputDeltas.length}) — the live-preview source is missing`);
  } else if (firstToolCall !== -1 && firstInputStart > firstToolCall) {
    fail("S58-2", `tool-input-start (${firstInputStart}) arrived AFTER the first tool-call (${firstToolCall}) — wrong order`);
  } else {
    pass("S58-2", `task done: ${toolCalls.length} tool calls, 3 files on disk, ${inputStarts.length} tool-input-start + ${inputDeltas.length} tool-input-delta frames, input-start precedes tool-call`);
  }

  // ── S58-3: stop path (the owner's stop complaint) ─────────────────────────
  const stopSessionRes = await api("POST", "/sessions", { agentId, mode: "single", title: "R58 stop test", projectId });
  const stopSessionId = stopSessionRes.json?.id;
  // Stop only once text is actually streaming (free-tier first-token
  // latency can exceed a fixed wait — poll frames until ~120 chars).
  let streamedChars = 0;
  let sawText = false;
  const turnPromise = streamTurn(
    stopSessionId,
    "Count from 1 to 500 extremely slowly, one number per line, writing each number's full English name and a short sentence about it after each number. Do not use any tools.",
    undefined,
    (frame, textSoFar) => {
      streamedChars = textSoFar.length;
      if (streamedChars >= 120) sawText = true;
    },
  );
  const waitStart = Date.now();
  while (!sawText && Date.now() - waitStart < 45_000) await sleep(300);
  if (!sawText) {
    fail("S58-3", `no text streamed within 45s (chars=${streamedChars}) — free-tier latency; rerun the battery`);
    // Still drain the turn so the teardown is clean.
    await api("POST", `/sessions/${stopSessionId}/stop`);
    await turnPromise;
  } else {
    await api("POST", `/sessions/${stopSessionId}/stop`);
    const stopped = await turnPromise;
    const stopTerm = terminalType(stopped.frames);
    const sessionAfter = await api("GET", `/sessions/${stopSessionId}`);
    const statusAfter = sessionAfter.json?.session?.status ?? sessionAfter.json?.status;
    const eventsAfter = sessionAfter.json?.events ?? [];
    const partialAssistant = eventsAfter.filter(
      (e) => e.type === "message.assistant" && typeof e.payload?.content === "string" && e.payload.content.length > 0,
    );
    const stopStatusOk = statusAfter === "queued";
    const stopTermOk = stopTerm === "stopped";
    const partialOk = partialAssistant.length > 0 && stopped.text.length > 0;
    if (!stopTermOk) {
      fail("S58-3", `terminal frame after stop = ${stopTerm ?? "none"} (expected stopped)`);
    } else if (!stopStatusOk) {
      fail("S58-3", `session status after stop = ${statusAfter} (expected queued — the eternal-spinner fix)`);
    } else if (!partialOk) {
      fail("S58-3", `partial text NOT persisted (streamed ${stopped.text.length} chars, assistant events: ${partialAssistant.length})`);
    } else {
      pass("S58-3", `stopped frame received; status=${statusAfter}; partial (${stopped.text.length} chars streamed, ${partialAssistant.length} assistant event(s)) persisted`);
    }
  }

  // ── S58-4: continue after stop ────────────────────────────────────────────
  const cont = await streamTurn(stopSessionId, "Continue from where you left off.");
  const contTerm = terminalType(cont.frames);
  if (contTerm !== "done") {
    fail("S58-4", `continue turn terminal = ${contTerm ?? "none"} — resume broken`);
  } else {
    pass("S58-4", `continue turn completed (done), reply ${cont.text.length} chars`);
  }

  // ── S58-5: key reveal route ───────────────────────────────────────────────
  const reveal = await api("POST", "/providers/openrouter/keys/reveal");
  const revealed = reveal.json?.keys ?? [];
  const slot0 = revealed.find((k) => k.slot === 0);
  const valueOk = typeof slot0?.value === "string" && slot0.value.length > 40 && slot0.value === mainKey;
  if (reveal.status !== 200 || !valueOk) {
    fail("S58-5", `reveal status=${reveal.status} slot0=${slot0 ? `${slot0.value?.length} chars` : "missing"}`);
  } else {
    pass("S58-5", `reveal route returned the real key value (${revealed.length} slot(s))`);
  }

  // ── teardown ──────────────────────────────────────────────────────────────
  console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} battery checks passed`);
  if (results.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;
} finally {
  try { sidecar.kill("SIGTERM"); } catch { /* already gone */ }
  await sleep(800);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}
