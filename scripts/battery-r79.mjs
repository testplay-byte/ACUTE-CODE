/**
 * ROUND-79 LIVE BATTERY (self-supervising — the sandbox reaps background
 * processes when the launching command exits, so the whole battery owns its
 * sidecar + mock provider; the battery-r78 harness, one round later):
 *
 *  S79-1  boot: dedicated sidecar on 5197 (scratch DB) + the LOCAL mock
 *         OpenRouter-compatible SSE provider on 5196. The mock dispatches by
 *         REQUEST BODY (a child call carries the ROLE_FRAMING text "You are
 *         acting as a"; a parent call does not) — order-proof against the
 *         background child's detached run racing the parent's next call —
 *         and records every body (the model-facing oracle).
 *  S79-2  BLOCKING delegation regression: delegate_task {task} (no task_id)
 *         — the tool call WAITS, the child runs on the mock, the report
 *         returns INLINE: the parent's SECOND model call's request body
 *         contains the child's report text (the model actually saw it), the
 *         child row is completed + taskId null (pre-R79 behavior verbatim).
 *  S79-3  BACKGROUND delegation: delegate_task {task, task_id, background}
 *         — the tool call returns IMMEDIATELY (the parent's second call
 *         lands while the child still sleeps 4 s), the parent turn ENDS,
 *         and the child COMPLETES AFTER it (poll /subagents) — the detached
 *         run outlived the turn that started it. The receipt's task_id +
 *         session ride the tool result (asserted via the next body).
 *  S79-4  the NEXT turn's request body carries the "## BACKGROUND TASKS"
 *         section with the task_id + the COMPLETED line (the model is TOLD
 *         a result awaits collection — without polling).
 *  S79-5  resume COLLECTS: a tool-call turn delegate_task {resume} → the
 *         tool result is the child's report; the SUBSEQUENT turn's body NO
 *         LONGER contains the section (the delegation.collected marker).
 *  S79-6  resume WAITS: a background child with a 3 s chat delay; the
 *         resume tool call blocks until it completes (the tool-call →
 *         done frame gap >= 2.5 s) and returns the report.
 *  S79-7  duplicate task_id refusal: a new background delegation with the
 *         SAME task_id is refused honestly ("already used").
 *  S79-8  /subagents rows carry taskId (the panel's address surface).
 *  S79-9  unknown-address resume → the honest addressable list (real ids).
 *  S79-10 failed background child + resume retries it: the child's first
 *         attempt 500s; the resume tool call retries from the event log —
 *         the continuation request body carries "You were interrupted
 *         while working on this task" (the oracle) and the retry's report
 *         returns to the parent.
 *
 * Usage: node scripts/battery-r79.mjs   (from the repo root)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const REPO = "/home/z/PROJECT/ACUTE-CODE";
const PORT = 5197;
const MOCK_PORT = 5196;
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
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, text, json };
}

/** Read one streamed turn, collecting every SSE frame (+ arrival times). */
async function streamTurn(sessionId, content, extra) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ content, thinkingLevel: "default", ...extra }),
  });
  if (res.status !== 200) return { status: res.status, frames: [], text: "", times: [] };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames = [];
  const times = [];
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
            times.push(Date.now());
            if (frame.type === "text-delta" && typeof frame.delta === "string") text += frame.delta;
          } catch { /* partial frame */ }
        }
      }
    }
  } catch (err) {
    frames.push({ type: "__reader_error", message: String(err?.message ?? err) });
  }
  return { status: res.status, frames, text, times };
}

/* ── the mock OpenRouter-compatible SSE provider ────────────────────────────
 * Body-driven dispatch: a CHILD request ALWAYS carries the ROLE_FRAMING
 * marker ("You are acting as a") somewhere in its history (the framing IS
 * the child's first user message — it never leaves the child's context);
 * a PARENT request NEVER does (the parent only ever sees tool RESULTS —
 * receipts and reports — never the child's framing). Checking the RAW body
 * (not the last message — a child mid-tool-loop ends with tool results, and
 * that last-message check mis-dispatched exactly those calls) makes the
 * dispatch order-proof AND tool-loop-proof. Parent replies burn
 * parentScripts in order; child replies burn childScripts in order. Every
 * request body is recorded — the model-facing oracle. A script of
 * {fail:true} answers HTTP {failStatus ?? 400} (a fail-fast error; a 500
 * would be NETWORK-transient and the R75 ladder would auto-retry it). */
const mockBodies = [];
let parentScripts = [];
let childScripts = [];
/** S79-10: once a child script {failForever:true} is shifted, EVERY child
 * call 400s until the latch is cleared — the runtime's outer loop retries a
 * failing chat a VARIABLE number of times (maxOuterLoops), so a fixed
 * number of fail scripts cannot pin the streak's length. The latch makes
 * "the child is down" terminal-deterministic; the battery clears it right
 * before the resume turn (the retry then gets the recovery script). */
let childFailLatch = false;
const mockServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c.toString(); });
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* not json */ }
    mockBodies.push({ body: parsed, raw, at: Date.now() });
    const isChild = raw.includes("You are acting as a");
    if (isChild && childFailLatch) {
      try {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock child model error: down (latch)" } }));
      } catch { /* socket gone */ }
      return;
    }
    let script = (isChild ? childScripts : parentScripts).shift() ?? { delayMs: 150, text: "mock default reply" };
    if (script.failForever === true) {
      childFailLatch = true;
      try {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: script.failMessage ?? "mock child model error: bad request after progress" } }));
      } catch { /* socket gone */ }
      return;
    }
    if (script.fail === true) {
      try {
        // 400 by default (a fail-fast model-style error); a 500 would be
        // NETWORK-transient and the R75 ladder would auto-retry the call.
        res.writeHead(script.failStatus ?? 400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: script.failMessage ?? "mock child failure" } }));
      } catch { /* socket gone */ }
      return;
    }
    const at = mockBodies.length;
    setTimeout(() => {
      // A stopped/aborted turn kills the socket before the delay fires —
      // writes on a dead socket must never crash the mock (try/catch).
      try {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const base = { id: `chatcmpl-m${at}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: parsed?.model ?? "mock-model" };
        if (script.toolCall) {
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${at}`, type: "function", function: { name: script.toolCall.name, arguments: "" } }] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: script.toolCall.arguments } }] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: script.text ?? "" }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } catch { /* socket gone (a stop) — the script is consumed either way */ }
    }, script.delayMs ?? 150);
  });
});

// ── S79-1: boot the dedicated sidecar + mock provider ───────────────────────
const scratch = `/tmp/r79-battery-${Date.now()}`;
mkdirSync(scratch, { recursive: true });
const mainKey = readFileSync("/home/z/.secrets/openrouter-main.key", "utf8").trim();
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
await new Promise((resolve) => mockServer.listen(MOCK_PORT, "127.0.0.1", resolve));

let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const res = await fetch(`${BASE}/projects`, { headers: H });
    if (res.status === 200) { up = true; break; }
  } catch { /* not yet */ }
}
if (!up) {
  fail("S79-1", `sidecar never came up on ${PORT}\n${sidecarLog.slice(-600)}`);
  console.log(results.join("\n"));
  process.exit(1);
}

const cleanup = () => {
  try { sidecar.kill("SIGKILL"); } catch { /* gone */ }
  try { mockServer.close(); } catch { /* gone */ }
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* busy */ }
};

/** A delegate_task tool-call script for the parent. */
const delegateCall = (args, delayMs = 100) => ({
  delayMs,
  toolCall: { name: "delegate_task", arguments: JSON.stringify(args) },
});
const textReply = (text, delayMs = 100) => ({ delayMs, text });

/** The last recorded request body (raw string) whose JSON contains `needle`. */
const lastBodyContaining = (needle) => {
  for (let i = mockBodies.length - 1; i >= 0; i -= 1) {
    if (mockBodies[i].raw.includes(needle)) return mockBodies[i].raw;
  }
  return null;
};

try {
  // Fresh project + mock provider + the battery agent.
  const projectRoot = join(scratch, "site");
  mkdirSync(projectRoot, { recursive: true });
  const project = await api("POST", "/projects", { name: `R79-battery-${Date.now()}`, rootPath: projectRoot });
  const projectId = project.json?.id;
  const mockProv = await api("POST", "/providers", {
    id: "mockr79",
    name: "Mock R79",
    kind: "openai-compatible",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    apiFormat: "chat-completions",
    enabled: true,
  });
  if (mockProv.status >= 400) { fail("S79-1", `mock provider create failed: ${mockProv.status} ${mockProv.text.slice(0, 200)}`); throw new Error("no provider"); }
  const keyPut = await api("PUT", "/providers/mockr79/key", { value: "mock-key" });
  if (keyPut.status >= 400) { fail("S79-1", `mock key put failed: ${keyPut.status}`); throw new Error("no key"); }
  const agent = await api("POST", "/agents", {
    name: "R79 Battery Agent",
    systemPrompt: "You are a helpful coding agent. Complete tasks with real tool calls.",
    providerId: "mockr79",
    model: "mock-model",
    temperature: 0.2,
    maxTurns: 8,
  });
  const agentId = agent.json?.id;
  if (!projectId || !agentId) { fail("S79-1", `setup failed: project=${projectId} agent=${agentId}`); throw new Error("setup"); }
  pass("S79-1", `dedicated sidecar up on ${PORT} + body-dispatch mock provider on ${MOCK_PORT}`);

  const newSession = async (title) => {
    const s = await api("POST", "/sessions", { agentId, mode: "single", title, projectId });
    return s.json?.id;
  };

  // ── S79-2: BLOCKING delegation regression (pre-R79 behavior verbatim) ─────
  {
    const sid = await newSession("S79-2 blocking regression");
    const bodiesBefore = mockBodies.length;
    parentScripts = [delegateCall({ task: "Research the battery blocking path.", role: "researcher" }), textReply("S79-2 parent final reply.")];
    childScripts = [textReply("S79-2 BLOCKING REPORT: the research is complete.", 400)];
    const turn = await streamTurn(sid, "Delegate the research please.");
    const toolCallFrame = turn.frames.find((f) => f.type === "tool-call" && String(f.toolName ?? "").includes("delegate_task"));
    const done = turn.frames.find((f) => f.type === "done");
    const rows = ((await api("GET", `/sessions/${sid}/subagents`)).json ?? {}).subagents ?? [];
    // The oracle: the parent's SECOND call's body carries the report inline.
    const parentBodies = mockBodies.slice(bodiesBefore).filter((b) => !(b.raw.includes("You are acting as a")));
    const secondBody = parentBodies.find((b) => b.raw.includes("S79-2 parent final") === false && b.raw.includes("BLOCKING REPORT"));
    if (!toolCallFrame || !done) {
      fail("S79-2", `frames incomplete: toolCall=${!!toolCallFrame} done=${!!done}`);
    } else if (rows.length !== 1 || rows[0].status !== "completed" || rows[0].taskId !== null) {
      fail("S79-2", `child row wrong: ${JSON.stringify(rows[0] ?? {}).slice(0, 200)}`);
    } else if (secondBody === undefined) {
      fail("S79-2", `the parent's second call never saw the report (bodies=${parentBodies.length})`);
    } else {
      pass("S79-2", `blocking delegation: tool waited, child completed, report INLINE in the parent's next request body, taskId null`);
    }
  }

  // ── S79-3: BACKGROUND delegation (immediate return + outliving the turn) ──
  {
    const sid = await newSession("S79-3 background");
    const bodiesBefore = mockBodies.length;
    parentScripts = [delegateCall({ task: "Research the background path deeply.", role: "researcher", task_id: "bg-research", background: true }), textReply("S79-3 parent continues immediately.")];
    childScripts = [textReply("S79-3 BACKGROUND REPORT: research finished after the turn.", 4000)];
    const turnStarted = Date.now();
    const turn = await streamTurn(sid, "Start the background research.");
    const turnMs = Date.now() - turnStarted;
    const done = turn.frames.find((f) => f.type === "done");
    const rows = ((await api("GET", `/sessions/${sid}/subagents`)).json ?? {}).subagents ?? [];
    // The turn must END long before the child's 4 s chat completes.
    const earlyRow = rows[0]?.status ?? "missing";
    // Wait for the detached completion (the child outlived the turn).
    let completed = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      const fresh = ((await api("GET", `/sessions/${sid}/subagents`)).json ?? {}).subagents ?? [];
      if (fresh[0]?.status === "completed") { completed = true; break; }
    }
    // The receipt rode the tool result: the parent's second body carries it.
    // (Find by the receipt's own distinctive line — the reply text is what
    // the model GENERATES in answer to that body, never part of it.)
    const parentBodies = mockBodies.slice(bodiesBefore).filter((b) => !b.raw.includes("You are acting as a"));
    const receiptBody = parentBodies.find((b) => b.raw.includes("running in the background"));
    const receiptOk =
      receiptBody !== undefined &&
      receiptBody.raw.includes("bg-research") &&
      receiptBody.raw.includes("subagent session");
    if (!done || turnMs >= 3500) {
      fail("S79-3", `the parent turn did not finish fast (ms=${turnMs}, done=${!!done}) — the background call blocked`);
    } else if (!receiptOk) {
      fail("S79-3", `the immediate receipt never reached the parent's next request body`);
    } else if (!completed) {
      fail("S79-3", `the detached child never completed after the turn (row status after turn: ${earlyRow})`);
    } else {
      pass("S79-3", `background: turn done in ${Math.round(turnMs)}ms (child sleeps 4s), receipt inline, child COMPLETED after the turn ended`);
    }
  }

  // ── S79-4: the NEXT turn's body carries the BACKGROUND TASKS section ──────
  {
    const s3 = (await api("GET", "/sessions")).json?.sessions?.find?.((s) => s.title === "S79-3 background")?.id;
    parentScripts = [textReply("S79-4 seen the section.")];
    const turn = await streamTurn(s3, "What happened to my background research?");
    // The request body of THIS turn: its user message is unique to it (the
    // LAST body containing it = the turn's last model call).
    const body = lastBodyContaining("What happened to my background research?") ?? "";
    const section = body.includes("## BACKGROUND TASKS");
    const named = body.includes("bg-research") && body.includes("COMPLETED");
    if (!turn.frames.find((f) => f.type === "done")) {
      fail("S79-4", "the turn did not complete");
    } else if (!section || !named) {
      fail("S79-4", `the next turn's request body lacks the reminder (section=${section} named=${named}): …${body.slice(-400)}`);
    } else {
      pass("S79-4", `next turn's request body: "## BACKGROUND TASKS" + bg-research + COMPLETED (the model is told, without polling)`);
    }
  }

  // ── S79-5: resume COLLECTS (report + the section disappears) ──────────────
  {
    const s3 = (await api("GET", "/sessions")).json?.sessions?.find?.((s) => s.title === "S79-3 background")?.id;
    const bodiesBeforeResume = mockBodies.length;
    parentScripts = [delegateCall({ resume: "bg-research" }), textReply("S79-5 collected, thanks.")];
    const turn = await streamTurn(s3, "Collect the background result now.");
    // The resume tool result (the report) must reach the model: it rides the
    // turn's second call's request body (after the tool result).
    const toolResultSeen = mockBodies
      .slice(bodiesBeforeResume)
      .some((b) => b.raw.includes("S79-3 BACKGROUND REPORT"));
    // The marker: the NEXT turn's body no longer lists the task.
    parentScripts = [textReply("S79-5b section gone.")];
    const turn2 = await streamTurn(s3, "Anything else outstanding?");
    const body2 = lastBodyContaining("Anything else outstanding?") ?? "";
    const gone = !body2.includes("## BACKGROUND TASKS");
    if (!turn.frames.find((f) => f.type === "done") || !toolResultSeen) {
      fail("S79-5", `resume turn incomplete or the report never reached the model (toolResultSeen=${toolResultSeen})`);
    } else if (!turn2.frames.find((f) => f.type === "done") || !gone) {
      fail("S79-5", `the section did not disappear after collection (gone=${gone}): …${body2.slice(-300)}`);
    } else {
      pass("S79-5", `resume collected the report (inline in the next request body) and the section is GONE the turn after`);
    }
  }

  // ── S79-6: resume WAITS for a running background child ────────────────────
  {
    const sid = await newSession("S79-6 resume waits");
    parentScripts = [
      delegateCall({ task: "Slow background work.", role: "coder", task_id: "slow-bg", background: true }),
      textReply("S79-6 started."),
    ];
    childScripts = [textReply("S79-6 SLOW REPORT: finally done.", 3000)];
    const turn1 = await streamTurn(sid, "Start the slow background task.");
    if (!turn1.frames.find((f) => f.type === "done")) { fail("S79-6", "the start turn never completed"); }
    // Give the child a moment to be mid-flight, then resume (it must WAIT).
    await sleep(300);
    parentScripts = [delegateCall({ resume: "slow-bg" }), textReply("S79-6 waited and collected.")];
    const resumeStarted = Date.now();
    const turn2 = await streamTurn(sid, "Wait for the slow result.");
    const waitedMs = Date.now() - resumeStarted;
    const toolIdx = turn2.frames.findIndex((f) => f.type === "tool-call");
    const doneIdx = turn2.frames.findIndex((f) => f.type === "done");
    const gapMs = toolIdx >= 0 && doneIdx > toolIdx ? turn2.times[doneIdx] - turn2.times[toolIdx] : -1;
    const report = (lastBodyContaining("Wait for the slow result.") ?? "").includes("S79-6 SLOW REPORT");
    if (waitedMs < 2500 || gapMs < 2000) {
      fail("S79-6", `resume did not wait (turn=${Math.round(waitedMs)}ms tool→done=${Math.round(gapMs)}ms, child sleeps 3000ms)`);
    } else if (!report) {
      fail("S79-6", "the waited report never reached the parent's next request body");
    } else {
      pass("S79-6", `resume WAITED ${Math.round(gapMs)}ms (tool→done) for the 3s child, then returned its report`);
    }
  }

  // ── S79-7: duplicate task_id refusal ───────────────────────────────────────
  {
    const s3 = (await api("GET", "/sessions")).json?.sessions?.find?.((s) => s.title === "S79-3 background")?.id;
    parentScripts = [
      delegateCall({ task: "A new research with a taken address.", role: "researcher", task_id: "bg-research", background: true }),
      textReply("S79-7 refused, moving on."),
    ];
    const turn = await streamTurn(s3, "Delegate with the same task_id.");
    const refusal = (lastBodyContaining("Delegate with the same task_id.") ?? "").includes("already used");
    if (!turn.frames.find((f) => f.type === "done") || !refusal) {
      fail("S79-7", `the duplicate refusal never reached the model (refusal=${refusal})`);
    } else {
      pass("S79-7", `duplicate task_id refused honestly ("already used" inline in the next request body)`);
    }
  }

  // ── S79-8: /subagents rows carry taskId ────────────────────────────────────
  {
    const s6 = (await api("GET", "/sessions")).json?.sessions?.find?.((s) => s.title === "S79-6 resume waits")?.id;
    const rows = ((await api("GET", `/sessions/${s6}/subagents`)).json ?? {}).subagents ?? [];
    const row = rows.find((r) => r.taskId === "slow-bg");
    if (row === undefined || row.status !== "completed") {
      fail("S79-8", `the row lacks taskId/status: ${JSON.stringify(rows[0] ?? {}).slice(0, 200)}`);
    } else {
      pass("S79-8", `GET /sessions/:id/subagents row carries taskId="slow-bg" (status completed) — the panel's address surface`);
    }
  }

  // ── S79-9: unknown-address resume → the honest addressable list ────────────
  {
    const s6 = (await api("GET", "/sessions")).json?.sessions?.find?.((s) => s.title === "S79-6 resume waits")?.id;
    parentScripts = [delegateCall({ resume: "no-such-address" }), textReply("S79-9 saw the list.")];
    const turn = await streamTurn(s6, "Resume something that does not exist.");
    const body = lastBodyContaining("Resume something that does not exist.") ?? "";
    const listed = body.includes("No sub-agent of this session matches") && body.includes("slow-bg");
    if (!turn.frames.find((f) => f.type === "done") || !listed) {
      fail("S79-9", `the honest list never reached the model (listed=${listed}): …${body.slice(-300)}`);
    } else {
      pass("S79-9", `unknown-address resume → the honest list (real addresses incl. slow-bg) inline`);
    }
  }

  // ── S79-10: failed background child + resume retries from the event log ────
  {
    const sid = await newSession("S79-10 fail then retry");
    parentScripts = [
      delegateCall({ task: "A task that fails first.", role: "coder", task_id: "phoenix-bg", background: true }),
      textReply("S79-10 started, it will fail."),
    ];
    // The child makes PROGRESS first (one list_dir tool call — persisted),
    // THEN goes DOWN: the {failForever} latch 400s every subsequent child
    // call for however many times the runtime's outer loop retries (the
    // streak length is the runtime's decision, not the mock's) until the
    // turn fails honestly. The event log then holds real work → the resume
    // takes the R39 CONTINUATION path ("You were interrupted…"), not a
    // task re-send.
    childScripts = [
      { delayMs: 150, toolCall: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } },
      { failForever: true, failMessage: "mock child model error: bad request after progress" },
    ];
    const turn1 = await streamTurn(sid, "Start the doomed background task.");
    // The child fails HONESTLY but not instantly: the runtime's outer loop
    // retries each failing chat call (maxOuterLoops iterations) before the
    // turn fails — poll a window that comfortably covers the whole streak.
    let failed = false;
    for (let i = 0; i < 120; i += 1) {
      await sleep(250);
      const rows = ((await api("GET", `/sessions/${sid}/subagents`)).json ?? {}).subagents ?? [];
      if (rows[0]?.status === "failed") { failed = true; break; }
    }
    // The failure is visible in the next turn's reminder (FAILED line).
    // Clear the latch + arm the recovery: the resume's continuation call
    // gets the retry report (exactly one child call happens per retry).
    childFailLatch = false;
    childScripts = [textReply("S79-10 RETRY REPORT: recovered and finished.", 200)];
    parentScripts = [delegateCall({ resume: "phoenix-bg" }), textReply("S79-10 retried and collected.")];
    const turn2 = await streamTurn(sid, "Retry the failed background task.");
    // The oracle: the continuation body carries the R39 framing.
    const continuation = lastBodyContaining("You were interrupted while working on this task");
    const report = (lastBodyContaining("Retry the failed background task.") ?? "").includes("S79-10 RETRY REPORT");
    const rowsFinal = ((await api("GET", `/sessions/${sid}/subagents`)).json ?? {}).subagents ?? [];
    if (!turn1.frames.find((f) => f.type === "done") || !failed) {
      const childBodies = mockBodies.filter((b) => b.raw.includes("You are acting as a")).length;
      const childEvents = ((await api("GET", `/sessions/${sid}`)).json ?? {}).events ?? [];
      const evLines = (Array.isArray(childEvents) ? childEvents : [])
        .filter((e) => e.sessionId === undefined || true)
        .map((e) => `${e.type}:${JSON.stringify(e.payload ?? {}).slice(0, 90)}`)
        .join(" | ");
      fail(
        "S79-10",
        `the doomed child never failed visibly (failed=${failed}, status=${rowsFinal[0]?.status ?? "?"}, childCalls=${childBodies}) EVENTS: ${evLines.slice(0, 900)}`,
      );
    } else if (!turn2.frames.find((f) => f.type === "done") || continuation === null || !report) {
      fail("S79-10", `the retry continuation/report never reached the model (turn2done=${!!turn2.frames.find((f) => f.type === "done")} continuation=${continuation !== null} report=${report})`);
    } else if (rowsFinal[0]?.status !== "completed") {
      fail("S79-10", `the retried child is not completed: ${JSON.stringify(rowsFinal[0] ?? {}).slice(0, 200)}`);
    } else {
      pass("S79-10", `failed background child: resume retried it (the "You were interrupted" continuation in the child's request body), the retry report returned, the child completed`);
    }
  }
} catch (err) {
  fail("S79-X", `battery crashed: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  cleanup();
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n=== R79 battery: ${results.length - fails} PASS / ${fails} FAIL ===`);
  process.exit(fails > 0 ? 1 : 0);
}
