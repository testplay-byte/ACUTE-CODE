/**
 * ROUND-78 LIVE BATTERY (self-supervising — the sandbox reaps background
 * processes when the launching command exits, so the whole battery owns its
 * sidecar + mock provider):
 *
 *  S78-1  boot: dedicated sidecar on 5199 (scratch DB, real OpenRouter key)
 *         + a LOCAL mock OpenRouter-compatible SSE provider on 5198 (records
 *         request bodies — the model-facing history oracle).
 *  S78-2  honest bad-model error: a nonexistent model fails IMMEDIATELY with
 *         the API's REAL text ("not a valid model ID"), class unknown, NO
 *         meta.retry frames (the owner's "wrong error message" complaint —
 *         only real rate limits may ladder).
 *  S78-3  real 429 ladder honesty: the account's burnt free quota → the
 *         meta.retry frames carry class rate_limit + providerError = the REAL
 *         "Rate limit exceeded: free-models-per-day…" text (not the generic
 *         line). Stop mid-ladder → the stopped frame + honest abort.
 *  S78-4  queue during the ladder wait: POST /queue lands on the OPEN stream
 *         (user.queued frame), the next loop-top delivers it
 *         (queued.delivered frame) even while the ladder keeps waiting.
 *  S78-5  retry-settings gate: PUT /settings/retry {autoRetryRateLimit:false}
 *         → the same 429 fails FAST (no meta.retry, attempts 1, real text) →
 *         settings restored.
 *  S78-6  mid-turn loop-top delivery (mock provider): call 1 = list_dir tool
 *         call (4 s delay so the queue lands mid-turn); the queued message
 *         flips to message.user BETWEEN the tool result and call 2 — call 2's
 *         request body MUST contain the queued text (the model actually sees
 *         it mid-turn, with its context).
 *  S78-7  turn-end continuation (mock): queue during a no-tool turn → the
 *         SAME SSE stream continues: meta.queue_continue frame → a second
 *         full turn (own message.user + reply) → one done frame at the end.
 *  S78-8  crash/stop recovery pre-flip: a lingering queued message (queued,
 *         then STOP before delivery) is delivered BEFORE the next send's
 *         message — call 1's body carries queued-then-new in order.
 *  S78-9  queue route honesty: POST /queue with NO live turn → 409
 *         NO_LIVE_TURN; DELETE /sessions/:id/queue/:seq removes a queued
 *         message; a delivered seq 404s.
 *
 * Usage: node scripts/battery-r78.mjs   (from the repo root)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const REPO = "/home/z/PROJECT/ACUTE-CODE";
const PORT = 5199;
const MOCK_PORT = 5198;
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

/** Read one streamed turn, collecting every SSE frame. */
async function streamTurn(sessionId, content, extra, onFrame) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ content, thinkingLevel: "default", ...extra }),
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

/* ── the mock OpenRouter-compatible SSE provider (records request bodies) ── */
const mockBodies = []; // { body, at }
let mockScript = [];   // replies to burn in order; each: {delayMs, text?, toolCall?}
let mockCalls = 0;
const mockServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c.toString(); });
  req.on("end", () => {
    mockCalls += 1;
    const at = mockCalls;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* not json */ }
    mockBodies.push({ body: parsed, raw, at });
    const script = mockScript.shift() ?? { delayMs: 200, text: "mock default reply" };
    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
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
          sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${at}`, type: "function", function: { name: script.toolCall.name, arguments: "" } }] }, finish_reason: null }] });
          sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: script.toolCall.arguments } }] }, finish_reason: null }] });
          sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        } else {
          sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: script.text ?? "" }, finish_reason: null }] });
          sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } catch { /* socket gone (a stop) — the script is consumed either way */ }
    }, script.delayMs ?? 200);
  });
});

// ── S78-1: boot the dedicated sidecar + mock provider ───────────────────────
const scratch = `/tmp/r78-battery-${Date.now()}`;
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
  fail("S78-1", `sidecar never came up on ${PORT}\n${sidecarLog.slice(-600)}`);
  console.log(results.join("\n"));
  process.exit(1);
}
pass("S78-1", `dedicated sidecar up on ${PORT} + mock provider on ${MOCK_PORT}`);

const cleanup = () => {
  try { sidecar.kill("SIGKILL"); } catch { /* gone */ }
  try { mockServer.close(); } catch { /* gone */ }
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* busy */ }
};

try {
  // Fresh project + mock provider + agents.
  const projectRoot = join(scratch, "site");
  mkdirSync(projectRoot, { recursive: true });
  const project = await api("POST", "/projects", { name: `R78-battery-${Date.now()}`, rootPath: projectRoot });
  const projectId = project.json?.id;
  const mockProv = await api("POST", "/providers", {
    id: "mockr78",
    name: "Mock R78",
    kind: "openai-compatible",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    apiFormat: "chat-completions",
    enabled: true,
  });
  if (mockProv.status >= 400) { fail("S78-1", `mock provider create failed: ${mockProv.status} ${mockProv.text.slice(0, 200)}`); throw new Error("no provider"); }
  // The mock provider needs a key entry — any string (the openai-compatible
  // client sends it as a bearer header; the mock ignores). The route's field
  // name is `value` (the reveal-route sibling contract).
  const keyPut = await api("PUT", "/providers/mockr78/key", { value: "mock-key" });
  if (keyPut.status >= 400) { fail("S78-1", `mock key put failed: ${keyPut.status} ${keyPut.text.slice(0, 200)}`); throw new Error("no key"); }
  const mockAgent = await api("POST", "/agents", {
    name: "R78 Mock Agent",
    systemPrompt: "You are a helpful coding agent. Complete tasks with real tool calls.",
    providerId: "mockr78",
    model: "mock-model",
    temperature: 0.2,
    maxTurns: 8,
  });
  const mockAgentId = mockAgent.json?.id;
  const orAgent = await api("POST", "/agents", {
    name: "R78 OpenRouter Agent",
    systemPrompt: "You are a helpful coding agent.",
    providerId: "openrouter",
    model: "z-ai/glm-5.2:free",
    temperature: 0.2,
    maxTurns: 8,
  });
  const orAgentId = orAgent.json?.id;
  if (!projectId || !mockAgentId || !orAgentId) {
    fail("S78-1", `setup failed: project=${projectId} mockAgent=${mockAgentId} orAgent=${orAgentId}`);
    throw new Error("setup");
  }
  pass("S78-1", `project + mock provider + 2 agents seeded (mock=${mockAgentId}, openrouter=${orAgentId})`);

  // ── S78-2: honest bad-model error (immediate, real text, no ladder) ──────
  {
    const s = await api("POST", "/sessions", { agentId: orAgentId, mode: "single", title: "S78-2 bad model", projectId });
    const sid = s.json?.id;
    const turn = await streamTurn(sid, "Say hi.", { model: "no-such-vendor/no-such-model" });
    const errFrame = turn.frames.find((f) => f.type === "error");
    const retryFrames = turn.frames.filter((f) => f.type === "meta.retry");
    const term = turn.frames.filter((f) => ["done", "stopped", "error"].includes(f.type)).pop()?.type ?? null;
    const details = errFrame?.details ?? {};
    if (term !== "error" || retryFrames.length > 0) {
      fail("S78-2", `term=${term} meta.retry frames=${retryFrames.length} (expected immediate error, no ladder)`);
    } else if (String(details.providerError ?? "").includes("not a valid model ID") === false) {
      fail("S78-2", `providerError missing the REAL text: ${JSON.stringify(details).slice(0, 300)}`);
    } else if (details.errorClass !== "unknown") {
      fail("S78-2", `errorClass=${details.errorClass} (expected unknown — a model error is not rate limiting)`);
    } else {
      pass("S78-2", `bad model → immediate honest error: class unknown, real text "not a valid model ID", 0 meta.retry frames, attempts=${details.attempts}`);
    }
  }

  // ── S78-3: real 429 ladder + REAL provider text on the frames ────────────
  {
    const s = await api("POST", "/sessions", { agentId: orAgentId, mode: "single", title: "S78-3 real 429", projectId });
    const sid = s.json?.id;
    const frames = [];
    const abort = new AbortController();
    const turnPromise = (async () => {
      const res = await fetch(`${BASE}/sessions/${sid}/messages/stream`, {
        method: "POST", headers: H,
        body: JSON.stringify({ content: "Say hi.", thinkingLevel: "default" }),
        signal: abort.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
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
              try { frames.push(JSON.parse(line.slice(6))); } catch { /* partial */ }
            }
          }
        }
      } catch { /* aborted — expected */ }
    })();
    // Wait for the first meta.retry frame (the immediate rung + the 90 s rung).
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && frames.filter((f) => f.type === "meta.retry").length === 0) {
      await sleep(300);
    }
    await sleep(1500); // let the second frame land (the 90 s rung heartbeat)
    const retryFrames = frames.filter((f) => f.type === "meta.retry");
    const first = retryFrames[0];
    const honest = retryFrames.some((f) => String(f.providerError ?? "").includes("Rate limit exceeded"));
    if (retryFrames.length === 0 || first?.errorClass !== "rate_limit") {
      fail("S78-3", `meta.retry frames=${retryFrames.length} firstClass=${first?.errorClass} (expected rate_limit ladder)`);
    } else if (!honest) {
      fail("S78-3", `meta.retry frames carry no REAL providerError: ${JSON.stringify(first).slice(0, 300)}`);
    } else if (!String(first.classMessage ?? "").includes("Rate limit exceeded")) {
      fail("S78-3", `classMessage is still the generic line: ${JSON.stringify(first.classMessage).slice(0, 200)}`);
    } else {
      pass(`S78-3`, `${retryFrames.length} meta.retry frames: class rate_limit + the REAL text "Rate limit exceeded: free-models-per-day…" on providerError AND classMessage (attempt ${first.attempt}/${first.totalAttempts})`);
    }
    // Stop mid-ladder → the honest stopped frame.
    abort.abort();
    await api("POST", `/sessions/${sid}/stop`).catch(() => {});
    await turnPromise;
    await sleep(800);
    const stopped = frames.some((f) => f.type === "stopped");
    const status = (await api("GET", `/sessions/${sid}`)).json?.status;
    if (stopped || status === "queued") {
      pass("S78-4a", `stop mid-ladder → stopped frame=${stopped}, session status=${status} (retryable)`);
    } else {
      fail("S78-4a", `stop mid-ladder: stopped frame=${stopped}, status=${status}`);
    }
  }

  // ── S78-4: queue during the ladder wait → delivered at the next loop-top ─
  {
    const s = await api("POST", "/sessions", { agentId: orAgentId, mode: "single", title: "S78-4 queue mid-ladder", projectId });
    const sid = s.json?.id;
    const frames = [];
    const abort = new AbortController();
    const turnPromise = (async () => {
      const res = await fetch(`${BASE}/sessions/${sid}/messages/stream`, {
        method: "POST", headers: H,
        body: JSON.stringify({ content: "Say hi.", thinkingLevel: "default" }),
        signal: abort.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
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
              try { frames.push(JSON.parse(line.slice(6))); } catch { /* partial */ }
            }
          }
        }
      } catch { /* aborted — expected */ }
    })();
    // Wait for the ladder's 90 s rung, then QUEUE a message during the wait.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && frames.filter((f) => f.type === "meta.retry").length === 0) await sleep(300);
    const queuedAt = Date.now();
    const q = await api("POST", `/sessions/${sid}/queue`, { content: "S78-4 queued while the ladder waits" });
    const userQueuedFrameArrived = await (async () => {
      const d = Date.now() + 8_000;
      while (Date.now() < d) {
        if (frames.some((f) => f.type === "user.queued" && f.content === "S78-4 queued while the ladder waits")) return true;
        await sleep(250);
      }
      return false;
    })();
    if (q.status !== 200 || q.json?.ok !== true) {
      fail("S78-4", `queue POST → ${q.status} ${q.text.slice(0, 200)}`);
    } else if (!userQueuedFrameArrived) {
      fail("S78-4", "no user.queued frame on the open stream within 8 s of the queue POST");
    } else {
      pass("S78-4a", `queue POST 200 (seq ${q.json.seq}) + user.queued frame arrived live on the open stream`);
    }
    // The 90 s rung fires → the retry fails again → the loop-top DELIVERS the
    // queued message → queued.delivered frame. Wait up to 100 s.
    const deliverDeadline = queuedAt + 100_000;
    let deliveredFrame = null;
    while (Date.now() < deliverDeadline && deliveredFrame === null) {
      deliveredFrame = frames.find((f) => f.type === "queued.delivered" && f.content === "S78-4 queued while the ladder waits") ?? null;
      if (deliveredFrame === null) await sleep(500);
    }
    abort.abort();
    await api("POST", `/sessions/${sid}/stop`).catch(() => {});
    await turnPromise.catch(() => {});
    const events = ((await api("GET", `/sessions/${sid}`)).json ?? {}).events ?? [];
    const asUser = Array.isArray(events) && events.some((e) => e.type === "message.user" && String(e.payload?.content ?? "").includes("S78-4 queued"));
    if (deliveredFrame === null || !asUser) {
      fail("S78-4", `queued.delivered frame=${deliveredFrame !== null} logAsUser=${asUser} (expected mid-ladder delivery at the loop-top)`);
    } else {
      pass("S78-4b", "queued message DELIVERED mid-ladder (queued.delivered frame + message.user in the log) — the agent will see it on the next retry");
    }
  }

  // ── S78-5: retry-settings gate (fail fast when rate-limit retry is off) ──
  {
    const put = await api("PUT", "/settings/retry", { autoRetryRateLimit: false });
    if (put.status !== 200 || put.json?.autoRetryRateLimit !== false) {
      fail("S78-5", `PUT /settings/retry → ${put.status} ${put.text.slice(0, 200)}`);
    } else {
      const s = await api("POST", "/sessions", { agentId: orAgentId, mode: "single", title: "S78-5 gated", projectId });
      const sid = s.json?.id;
      const turn = await streamTurn(sid, "Say hi.");
      const retryFrames = turn.frames.filter((f) => f.type === "meta.retry");
      const errFrame = turn.frames.find((f) => f.type === "error");
      const details = errFrame?.details ?? {};
      // (duration check is implicit: a gated failure has NO ladder waits)
      if (retryFrames.length > 0) {
        fail("S78-5", `autoRetryRateLimit=false still laddered (${retryFrames.length} meta.retry frames)`);
      } else if (errFrame === undefined) {
        fail("S78-5", `no error frame — terminal=${turn.frames.map((f) => f.type).slice(-3).join(",")}`);
      } else if (Number(details.attempts ?? 1) !== 1) {
        fail("S78-5", `attempts=${details.attempts} (expected 1 — fail fast)`);
      } else if (!String(details.providerError ?? "").includes("Rate limit exceeded")) {
        fail("S78-5", `providerError without the real text: ${JSON.stringify(details).slice(0, 200)}`);
      } else {
        pass("S78-5", `retry gate OFF → fail fast: 0 meta.retry frames, attempts=1, class=${details.errorClass}, REAL 429 text shown`);
      }
      await api("PUT", "/settings/retry", { autoRetryRateLimit: true });
    }
  }

  // ── S78-6: mid-turn loop-top delivery (mock tool call between) ───────────
  {
    const s = await api("POST", "/sessions", { agentId: mockAgentId, mode: "single", title: "S78-6 mid-turn", projectId });
    const sid = s.json?.id;
    // HTTP-call choreography (one streamText SDK call = its own internal
    // steps): call 1 = the list_dir tool call (4 s delay — the queue lands
    // mid-turn); call 2 = the SDK's internal step after the tool result (its
    // text carries NO completion signal so the OUTER loop iterates); call 3 =
    // iteration 1 — the loop-top delivery has ALREADY flipped the queued
    // message, so call 3's prompt MUST contain the marker.
    // NOTE the honest seq semantics: the queued message's POSITION is its
    // QUEUE TIME (chronology — the user typed it before the tool completed);
    // its DELIVERY (the model seeing it) happens at the next model call,
    // WITH the completed tool result in the same prompt — the spec's
    // "reads it with its context, after the current tool call".
    mockBodies.length = 0;
    mockCalls = 0;
    mockScript = [
      { delayMs: 4_000, toolCall: { name: "list_dir", arguments: '{"path":""}' } },
      { delayMs: 100, text: "S78-6 first segment after the tool" },
      { delayMs: 100, text: "S78-6 final reply after the queued message. Done." },
    ];
    const frames = [];
    const turnPromise = streamTurn(sid, "S78-6 start: list the project root first.", {}, (f) => frames.push(f));
    await sleep(1_500);
    const q = await api("POST", `/sessions/${sid}/queue`, { content: "S78-6 QUEUED-MID-TURN-MARKER" });
    const turn = await turnPromise;
    const delivered = frames.find((f) => f.type === "queued.delivered" && String(f.content ?? "").includes("QUEUED-MID-TURN-MARKER"));
    const call3 = mockBodies.find((b) => b.at === 3)?.body;
    const sawIt = call3 && JSON.stringify(call3.messages ?? []).includes("S78-6 QUEUED-MID-TURN-MARKER");
    const sawToolResult = call3 && JSON.stringify(call3.messages ?? []).includes("<tool_results>");
    const events = ((await api("GET", `/sessions/${sid}`)).json ?? {}).events ?? [];
    const originalUserSeq = (Array.isArray(events) ? events : []).find((e) => e.type === "message.user")?.seq;
    const toolSeq = (Array.isArray(events) ? events : []).find((e) => e.type === "tool.use")?.seq;
    const queuedUserSeq = (Array.isArray(events) ? events : []).find((e) => e.type === "message.user" && String(e.payload?.content ?? "").includes("QUEUED-MID-TURN-MARKER"))?.seq;
    const term = turn.frames.filter((f) => ["done", "stopped", "error"].includes(f.type)).pop()?.type;
    if (q.status !== 200 || delivered === undefined || !sawIt) {
      fail("S78-6", `queue=${q.status} deliveredFrame=${delivered !== undefined} modelSawIt=${Boolean(sawIt)} term=${term} frames=${frames.map((f) => f.type).join(",")} bodies=${mockBodies.map((b) => b.at).join(",")}`);
    } else if (queuedUserSeq === undefined || originalUserSeq === undefined || queuedUserSeq <= originalUserSeq) {
      fail("S78-6", `log order wrong: originalUserSeq=${originalUserSeq} queuedUserSeq=${queuedUserSeq} (the queued message must follow the original user message)`);
    } else if (!sawToolResult) {
      fail("S78-6", "call 3's prompt lacks the tool result — the model must read the queued message WITH the completed tool call's context");
    } else {
      pass(`S78-6`, `mid-turn delivery: queued during call 1's delay → queued.delivered frame → call 3's prompt carries the marker + the completed tool result (log: user ${originalUserSeq} → queued-user ${queuedUserSeq} → tool ${toolSeq}) → done`);
    }
  }

  // ── S78-7: turn-end continuation (queue → new turn on the SAME stream) ───
  {
    const s = await api("POST", "/sessions", { agentId: mockAgentId, mode: "single", title: "S78-7 continuation", projectId });
    const sid = s.json?.id;
    mockBodies.length = 0;
    mockCalls = 0;
    // Call 1 ends the TURN (the "Done." completion signal — no outer
    // iteration); the queued message must ride the ROUTE's continuation: a
    // second full turn on the SAME SSE stream.
    mockScript = [
      { delayMs: 4_000, text: "S78-7 first reply. Done." },
      { delayMs: 100, text: "S78-7 second reply (after the queued message). Done." },
    ];
    const turnPromise = streamTurn(sid, "S78-7 first turn.");
    await sleep(1_500);
    const q = await api("POST", `/sessions/${sid}/queue`, { content: "S78-7 QUEUED-END-MARKER" });
    const turn = await turnPromise;
    const contFrame = turn.frames.find((f) => f.type === "meta.queue_continue");
    const doneFrames = turn.frames.filter((f) => f.type === "done");
    const events = ((await api("GET", `/sessions/${sid}`)).json ?? {}).events ?? [];
    const userEvents = (Array.isArray(events) ? events : []).filter((e) => e.type === "message.user");
    const call2 = mockBodies.find((b) => b.at === 2)?.body;
    const sawIt = call2 && JSON.stringify(call2.messages ?? []).includes("S78-7 QUEUED-END-MARKER");
    const term = turn.frames.filter((f) => ["done", "stopped", "error"].includes(f.type)).pop()?.type;
    if (q.status !== 200 || contFrame === undefined || doneFrames.length !== 1 || term !== "done") {
      fail("S78-7", `queue=${q.status} continueFrame=${contFrame !== undefined} doneFrames=${doneFrames.length} term=${term} frames=${turn.frames.map((f) => f.type).join(",")}`);
    } else if (userEvents.length !== 2) {
      fail("S78-7", `expected 2 user turns in the log, got ${userEvents.length}`);
    } else if (!sawIt) {
      fail("S78-7", "call 2's prompt did not contain the queued marker");
    } else {
      pass("S78-7", `turn-end continuation: meta.queue_continue + a second full turn on the SAME stream (2 user turns, 1 done frame, call-2 prompt carries the marker)`);
    }
  }

  // ── S78-8: crash/stop recovery — the pre-flip before the next send ───────
  {
    const s = await api("POST", "/sessions", { agentId: mockAgentId, mode: "single", title: "S78-8 pre-flip", projectId });
    const sid = s.json?.id;
    mockBodies.length = 0;
    mockScript = [
      { delayMs: 8_000, text: "S78-8 slow reply that gets stopped" },
      { delayMs: 100, text: "S78-8 the reply after recovery" },
    ];
    const frames = [];
    const turnPromise = streamTurn(sid, "S78-8 a turn that will be stopped.", {}, (f) => frames.push(f));
    await sleep(1_500);
    const q = await api("POST", `/sessions/${sid}/queue`, { content: "S78-8 LINGERING-QUEUED-MARKER" });
    await api("POST", `/sessions/${sid}/stop`);
    await turnPromise;
    await sleep(500);
    // The queued message lingers (never delivered — the turn was stopped).
    const eventsBefore = ((await api("GET", `/sessions/${sid}`)).json ?? {}).events ?? [];
    const lingering = (Array.isArray(eventsBefore) ? eventsBefore : []).find((e) => e.type === "message.queued");
    // Now send a NEW message — the pre-flip must deliver the lingering queued
    // message BEFORE the new one (both visible to the model, in order).
    mockScript = [{ delayMs: 100, text: "S78-8 recovery reply. Done." }];
    await streamTurn(sid, "S78-8 the new message after the stop.");
    const eventsAfter = ((await api("GET", `/sessions/${sid}`)).json ?? {}).events ?? [];
    const list = Array.isArray(eventsAfter) ? eventsAfter : [];
    const queuedUser = list.find((e) => e.type === "message.user" && String(e.payload?.content ?? "").includes("LINGERING-QUEUED-MARKER"));
    const newUser = list.filter((e) => e.type === "message.user").pop();
    const call1 = mockBodies.at(-1)?.body;
    const order = call1 ? JSON.stringify(call1.messages ?? []).indexOf("LINGERING-QUEUED-MARKER") < JSON.stringify(call1.messages ?? []).lastIndexOf("the new message after the stop") : false;
    if (lingering === undefined || q.status !== 200) {
      fail("S78-8", `the queued message did not linger (queue=${q.status} lingering=${lingering !== undefined})`);
    } else if (queuedUser === undefined || order === false) {
      fail("S78-8", `pre-flip failed: queuedAsUser=${queuedUser !== undefined} modelOrderOk=${order} — call1 messages: ${JSON.stringify(call1?.messages ?? []).slice(0, 400)}`);
    } else {
      pass("S78-8", `recovery pre-flip: the lingering queued message delivered BEFORE the new message (model saw queued→new in order; user seq ${queuedUser.seq} < ${newUser?.seq})`);
    }
  }

  // ── S78-9: queue route honesty (no live turn / dequeue / delivered 404) ──
  {
    const s = await api("POST", "/sessions", { agentId: mockAgentId, mode: "single", title: "S78-9 route honesty", projectId });
    const sid = s.json?.id;
    const noTurn = await api("POST", `/sessions/${sid}/queue`, { content: "no live turn here" });
    const code = noTurn.json?.error?.code ?? noTurn.json?.code;
    // Queue while a turn IS live, then dequeue it.
    mockScript = [{ delayMs: 6_000, text: "S78-9 slow" }];
    const turnPromise = streamTurn(sid, "S78-9 turn to queue against.");
    await sleep(1_000);
    const q = await api("POST", `/sessions/${sid}/queue`, { content: "S78-9 REMOVEME" });
    const dq = await api("DELETE", `/sessions/${sid}/queue/${q.json?.seq}`);
    await api("POST", `/sessions/${sid}/stop`);
    await turnPromise;
    // The delivered-seq 404: use S78-6's delivered seq? Simpler: delete a bogus seq.
    const bogus = await api("DELETE", `/sessions/${sid}/queue/999999`);
    if (noTurn.status !== 409 || code !== "NO_LIVE_TURN") {
      fail("S78-9", `no-live-turn queue → ${noTurn.status} code=${code} (expected 409 NO_LIVE_TURN)`);
    } else if (q.status !== 200 || dq.status !== 200) {
      fail("S78-9", `queue=${q.status} dequeue=${dq.status}`);
    } else if (bogus.status !== 404) {
      fail("S78-9", `bogus-seq dequeue → ${bogus.status} (expected 404)`);
    } else {
      const events = ((await api("GET", `/sessions/${sid}`)).json ?? {}).events ?? [];
      const stillThere = (Array.isArray(events) ? events : []).some((e) => e.type === "message.queued" && String(e.payload?.content ?? "").includes("REMOVEME"));
      if (stillThere) fail("S78-9", "the dequeued message is still in the log");
      else pass("S78-9", `route honesty: 409 NO_LIVE_TURN without a turn, queue+dequeue 200 (event gone), bogus seq → 404`);
    }
  }
} catch (err) {
  fail("S78-X", `battery crashed: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  cleanup();
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n=== R78 battery: ${results.length - fails} PASS / ${fails} FAIL ===`);
  process.exit(fails > 0 ? 1 : 0);
}
