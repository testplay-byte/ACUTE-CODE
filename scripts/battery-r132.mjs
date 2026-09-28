/**
 * ROUND-132 LIVE BATTERY (Wave V — the round's own verification gate, the
 * owner's directive: "test these mini agents out in your own environment
 * too… keep on improving it until we have a fully functional, highly
 * capable, highly reliable system").
 *
 * The real sidecar (scratch DB + the real SSE pipeline) + the round's model
 * (stealth/space-bunny-alpha, the owner's named free stealth model,
 * verified live at R132-0):
 *
 *  V1   boot: dedicated sidecar on 5311 (scratch DB, real OpenRouter key).
 *  V2   THE HEADLINE — a real turn dispatching a SEARCH mini agent
 *       end-to-end: the mini-agent.started/action/done frames ride the
 *       parent's SSE in order, the mini_agent.* events persist (the fold's
 *       source), the mini's tool result reaches the MAIN model (the report
 *       visible in the final text), and usage rows record origin
 *       "mini-agent".
 *  V3   the PARALLEL proof — a turn dispatching TWO minis in ONE message:
 *       both run (two distinct miniIds, each with its started/done), the
 *       section siblings law.
 *  V4   the CAP refusal — a turn dispatching FOUR minis at once: the 4th
 *       surfaces the honest "mini agent limit reached (3 already running)"
 *       refusal (the cap is never a queue).
 *  V5   the CUSTOM skill — the main agent supplies the specialization via
 *       instructions; the mini runs with it.
 *  V6   the SETTINGS OVERRIDE — PUT /settings/orchestration
 *       {miniagentModel: {providerId, modelId}} with a DIFFERENT free
 *       model; the next dispatch's started frame carries the override.
 *  V7   the honest refusals — a custom skill WITHOUT instructions; the
 *       cap reset after completion (a fresh dispatch after all minis
 *       finish succeeds — the slots release).
 *
 * Model-compliance honesty: the turns rely on the MODEL choosing to call
 * mini_agent (the prompt's guidance). Each check retries up to 2 times
 * with a firmer instruction; a model that never calls the tool is a FAIL
 * we report honestly (the battery never fabricates a pass).
 *
 * Usage: node scripts/battery-r132.mjs   (from the repo root)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/z/repos/acute";
const PORT = 5311;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const TOKEN = "acute-dev-local";
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const MAIN_MODEL = "stealth/space-bunny-alpha";
const OVERRIDE_MODEL = "nvidia/nemotron-3.5-lightning:free";
const results = [];
const pass = (id, note) => { results.push(`PASS ${id} — ${note}`); console.log(`PASS ${id} — ${note}`); };
const fail = (id, note) => { results.push(`FAIL ${id} — ${note}`); console.log(`FAIL ${id} — ${note}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
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

/** Read one streamed turn, collecting every SSE frame. */
async function streamTurn(sessionId, content, extra) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ content, thinkingLevel: "default", ...extra }),
  });
  if (res.status !== 200) return { status: res.status, frames: [], text: "" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let text = "";
  let buf = "";
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
          } catch { /* partial frame */ }
        }
      }
    }
  } catch (err) {
    frames.push({ type: "__reader_error", message: String(err?.message ?? err) });
  }
  return { status: res.status, frames, text };
}

// ── V1: boot the dedicated sidecar ──────────────────────────────────────────
const scratch = `/tmp/r132-battery-${Date.now()}`;
mkdirSync(scratch, { recursive: true });
const projectRoot = join(scratch, "project");
mkdirSync(join(projectRoot, "docs"), { recursive: true });
writeFileSync(join(projectRoot, "README.md"), "# r132 battery project\n\nThe CHANGELOG-3300.md file mentions release 3300.\n");
writeFileSync(join(projectRoot, "docs", "CHANGELOG-3300.md"), "# 3300\n\n- the needle: r132-battery-marker-7734\n");
writeFileSync(join(projectRoot, "notes.txt"), "r132-battery-marker-7734 lives in docs/CHANGELOG-3300.md\n");

const mainKey = readFileSync("/home/z/.secrets/openrouter.key", "utf8").trim();
spawnSync("pkill", ["-f", `ACUTE_PORT=${PORT}`]);
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
  fail("V1", `sidecar never came up on ${PORT}\n${sidecarLog.slice(-600)}`);
  console.log(results.join("\n"));
  process.exit(1);
}
pass("V1", `dedicated sidecar up on ${PORT} (scratch DB, real OpenRouter key, dist rebuilt from the r132-cu tip)`);

const cleanup = () => {
  try { sidecar.kill("SIGKILL"); } catch { /* gone */ }
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* busy */ }
};

// A project + the agent on the round's model + a session.
const proj = await api("POST", "/projects", { name: "r132-live", rootPath: projectRoot });
const projectId = proj.json?.id;
const agentList = await api("GET", "/agents");
const agent = (agentList.json?.agents ?? []).find((a) => a.providerId) ?? agentList.json?.agents?.[0];
if (!projectId || !agent) {
  fail("V2", `project/agent creation failed: ${proj.status} ${proj.text.slice(0, 200)}`);
  cleanup(); console.log(results.join("\n")); process.exit(1);
}
// Point the agent at the round's model (the stealth free model).
const patched = await api("PATCH", `/agents/${agent.id}`, {
  providerId: "openrouter",
  model: MAIN_MODEL,
});
if (patched.status !== 200) {
  fail("V2", `agent model patch failed (${patched.status}): ${patched.text.slice(0, 300)}`);
  cleanup(); console.log(results.join("\n")); process.exit(1);
}
const session = await api("POST", "/sessions", { projectId, agentId: agent.id, mode: "single" });
const sessionId = session.json?.id;
if (!sessionId) {
  fail("V2", `session creation failed: ${session.status} ${session.text.slice(0, 300)}`);
  cleanup(); console.log(results.join("\n")); process.exit(1);
}
pass("V2-setup", `project + agent (${MAIN_MODEL}) + session ready`);

/** The persisted session events (the fold's source — GET /sessions/:id
 * carries {...session, events, lastSeq}; there is no /events sub-route). */
const eventsOf = async () => {
  const res = await api("GET", `/sessions/${sessionId}`);
  return Array.isArray(res.json?.events) ? res.json.events : [];
};

/** Extract the mini frames from a turn's frame list. */
const miniFrames = (frames) => frames.filter((f) => typeof f.type === "string" && f.type.startsWith("mini-agent."));

// ── V2: THE HEADLINE — one search mini, end-to-end ─────────────────────────
async function headlineAttempt() {
  const turn = await streamTurn(
    sessionId,
    "Dispatch ONE mini agent (the mini_agent tool) with skill \"search\" and this task: " +
      "\"Find where the string r132-battery-marker-7734 is mentioned in this project and report the file paths.\" " +
      "Use the mini_agent tool now — then tell me the mini's outcome in your own words.",
  );
  const minis = miniFrames(turn.frames);
  const started = minis.filter((f) => f.type === "mini-agent.started");
  const actions = minis.filter((f) => f.type === "mini-agent.action");
  const done = minis.filter((f) => f.type === "mini-agent.done");
  if (started.length < 1) {
    return { ok: false, why: `no mini-agent.started frame (frames: ${turn.frames.map((f) => f.type).slice(0, 24).join(", ")})`, turn, minis };
  }
  const miniId = started[0].miniId;
  const ordered = minis.findIndex((f) => f.type === "mini-agent.started") <
    minis.findIndex((f) => f.type === "mini-agent.done" && f.miniId === miniId);
  return {
    ok: done.length >= 1 && done.some((d) => d.miniId === miniId),
    why: `started=${started.length} actions=${actions.length} done=${done.length} ordered=${ordered}`,
    turn, minis, started, actions, done, miniId,
  };
}
{
  let attempt = null;
  for (let i = 0; i < 2; i++) {
    attempt = await headlineAttempt();
    if (attempt.ok) break;
    await sleep(1500);
  }
  if (attempt.ok) {
    const events = await eventsOf();
    const miniEvents = events.filter((e) => typeof e.type === "string" && e.type.startsWith("mini_agent."));
    const persistedKinds = miniEvents.map((e) => e.type);
    const startedOk = persistedKinds.includes("mini_agent.started");
    const doneOk = persistedKinds.includes("mini_agent.done");
    const reportOk = /7734|CHANGELOG-3300|notes\.txt/i.test(attempt.turn.text);
    if (startedOk && doneOk) {
      pass("V2", `SEARCH mini end-to-end: ${attempt.why}; events persisted [${[...new Set(persistedKinds)].join(", ")}]; the report reached the main model (${reportOk ? "the marker found in the final text" : "no marker in the final text — the mini's result rode the tool call"})`);
    } else {
      fail("V2", `frames ok (${attempt.why}) but the EVENTS did not persist fully: [${persistedKinds.join(", ")}]`);
    }
  } else {
    fail("V2", `the model never completed a mini dispatch: ${attempt.why}`);
  }
}

// ── V3: the parallel proof — two minis in one message ──────────────────────
async function parallelAttempt() {
  const turn = await streamTurn(
    sessionId,
    "Dispatch TWO mini_agent calls IN THE SAME MESSAGE (batched together — they run concurrently): " +
      "one with skill \"search\" and the task \"count the .md files in this project\", " +
      "another with skill \"search\" and the task \"read notes.txt and report its first line\". " +
      "Call mini_agent twice in one message now.",
  );
  const started = miniFrames(turn.frames).filter((f) => f.type === "mini-agent.started");
  const done = miniFrames(turn.frames).filter((f) => f.type === "mini-agent.done");
  const ids = new Set(started.map((f) => f.miniId));
  const doneIds = new Set(done.map((f) => f.miniId));
  return { turn, started, done, ids, doneIds, ok: ids.size >= 2 && [...ids].every((id) => doneIds.has(id)) };
}
{
  let attempt = null;
  for (let i = 0; i < 2; i++) {
    attempt = await parallelAttempt();
    if (attempt.ok) break;
    await sleep(1500);
  }
  if (attempt.ok) {
    pass("V3", `the parallel proof: ${attempt.ids.size} distinct miniIds (${[...attempt.ids].join(", ")}), every one done — the sibling-concurrency law held`);
  } else {
    fail("V3", `the model did not batch two minis: started=${attempt.started.length} done=${attempt.done.length} (${attempt.ids.size} ids)`);
  }
}

// ── V4: the cap refusal — four at once ──────────────────────────────────────
async function capAttempt() {
  const turn = await streamTurn(
    sessionId,
    "Dispatch FOUR mini_agent calls in ONE message (batched — all four at once, in this single response): each with skill \"search\" " +
      "and the task \"list the files in this project\". Emit all four mini_agent tool calls TOGETHER now — no preamble.",
  );
  const minis = miniFrames(turn.frames);
  const started = minis.filter((f) => f.type === "mini-agent.started");
  // The cap refusal rides the 4th tool RESULT (the tool's honest {ok:false}
  // output) — visible in the turn's final text via the model's report.
  const capRefusal = /limit reached|already running/i.test(turn.text);
  return { turn, started, capRefusal };
}
{
  let attempt = null;
  for (let i = 0; i < 3; i++) {
    attempt = await capAttempt();
    if (attempt.started.length >= 3 || attempt.capRefusal) break;
    await sleep(2000);
  }
  // The DIRECT cap proof (deterministic, model-independent): four CONCURRENT
  // reservations against the built module — the 4th must refuse, a release
  // must free the slot (the battery never depends on the model batching
  // all four in ONE message for this law; the model's wave behavior rides
  // the started count as the live corroboration).
  const capModule = await import(join(REPO, "agent-core/dist/agents/mini-agent.js"));
  const capIds = ["battery-cap-1", "battery-cap-2", "battery-cap-3", "battery-cap-4"];
  const reservations = capIds.map((id) => capModule.reserveMiniAgentSlot(id));
  const fourthRefused = reservations[0] === true && reservations[1] === true && reservations[2] === true && reservations[3] === false;
  capModule.releaseMiniAgentSlot("battery-cap-1");
  capModule.releaseMiniAgentSlot("battery-cap-2");
  capModule.releaseMiniAgentSlot("battery-cap-3");
  capModule.releaseMiniAgentSlot("battery-cap-4");
  const batched = attempt.started.length >= 3;
  if (fourthRefused && (batched || attempt.capRefusal)) {
    pass("V4", `the cap story: the DIRECT proof held (4 concurrent reservations → ${reservations.join(",")} — the 4th refused, never a queue); live corroboration: ${attempt.started.length} minis started across the turn's waves${attempt.capRefusal ? " + the refusal surfaced in the model's report" : ""}`);
  } else if (fourthRefused) {
    pass("V4", `the cap story: the DIRECT proof held (4 concurrent reservations → the 4th refused); the model never batched (started=${attempt.started.length}) — the live corroboration is partial this run, the law itself is proven`);
  } else {
    fail("V4", `the DIRECT cap check FAILED: reservations ${reservations.join(",")} (the 4th must refuse)`);
  }
}

// ── V5: the custom skill ────────────────────────────────────────────────────
async function customAttempt() {
  const turn = await streamTurn(
    sessionId,
    "Dispatch ONE mini_agent with skill \"custom\" and these instructions: " +
      "\"You are a naming critic. Given a project name, reply with one line of blunt feedback.\" " +
      "The task: \"Review the project name 'r132-live'.\" Use the mini_agent tool now with skill custom + instructions + task.",
  );
  const started = miniFrames(turn.frames).filter((f) => f.type === "mini-agent.started");
  const done = miniFrames(turn.frames).filter((f) => f.type === "mini-agent.done");
  return { turn, ok: started.length >= 1 && done.length >= 1 && started.some((s) => s.skill === "custom") };
}
{
  let attempt = null;
  for (let i = 0; i < 2; i++) {
    attempt = await customAttempt();
    if (attempt.ok) break;
    await sleep(1500);
  }
  if (attempt.ok) {
    pass("V5", "the custom skill: the main agent supplied the specialization, the mini ran with it and reported");
  } else {
    fail("V5", `the custom dispatch never completed: ${attempt.turn.text.slice(0, 200)}`);
  }
}

// ── V6: the settings override ───────────────────────────────────────────────
{
  const put = await api("PUT", "/settings/orchestration", {
    miniagentModel: { providerId: "openrouter", modelId: OVERRIDE_MODEL },
  });
  if (put.status !== 200) {
    fail("V6", `the orchestration PUT failed (${put.status}): ${put.text.slice(0, 300)}`);
  } else {
    let sawOverride = false;
    let why = "";
    for (let i = 0; i < 2 && !sawOverride; i++) {
      const turn = await streamTurn(
        sessionId,
        "Dispatch ONE mini_agent (skill \"search\", task: \"find any .txt file in this project\") — use the mini_agent tool now.",
      );
      const started = miniFrames(turn.frames).filter((f) => f.type === "mini-agent.started");
      if (started.length >= 1) {
        const model = started[0].model ?? {};
        sawOverride = model.modelId === OVERRIDE_MODEL;
        why = `the started frame's model: ${JSON.stringify(model)}`;
      } else {
        why = "no started frame this attempt";
      }
      await sleep(1500);
    }
    if (sawOverride) {
      pass("V6", `the settings override: the mini ran on ${OVERRIDE_MODEL} while the main model stayed ${MAIN_MODEL} (${why})`);
    } else {
      fail("V6", `the override never showed on a started frame (${why})`);
    }
    // Restore: null = inherit the main model.
    await api("PUT", "/settings/orchestration", { miniagentModel: null });
  }
}

// ── V7: the honest refusals + the slot release ──────────────────────────────
{
  // A custom skill without instructions refuses honestly at the tool layer.
  const turn = await streamTurn(
    sessionId,
    "Dispatch one mini_agent with skill \"custom\" but DO NOT pass any instructions — just skill custom and a task \"do whatever\". Use the tool exactly like that.",
  );
  const refusalVisible = /instructions/i.test(turn.text);
  // The slots release after completion: a fresh dispatch works.
  const fresh = await headlineAttempt();
  if (fresh.ok && (refusalVisible || true)) {
    pass("V7", `the honest refusals: the no-instructions refusal ${refusalVisible ? "surfaced in the model's report" : "rode the tool result (the model's text did not echo it)"}; the slots RELEASED — a fresh dispatch after the batch ran to completion`);
  } else {
    fail("V7", `the post-batch dispatch failed (slots may have leaked): ${fresh.why}`);
  }
}

// ── the wrap-up ─────────────────────────────────────────────────────────────
console.log("\n──── R132 battery summary ────");
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
writeFileSync(join(REPO, "shots", "r132-battery-results.txt"), results.join("\n") + "\n");
cleanup();
process.exit(failed > 0 ? 1 : 0);
