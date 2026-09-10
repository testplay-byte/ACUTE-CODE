/**
 * ROUND-82 LIVE BATTERY (self-supervising — the sandbox reaps background
 * processes when the launching command exits, so the whole battery owns its
 * sidecar + mock gateway):
 *
 *  B82-1  boot: dedicated sidecar on 5299 (scratch DB, real OpenRouter key
 *         + real NVIDIA key + a custom-provider key env var) + a LOCAL mock
 *         OpenRouter-compatible SSE gateway on 5298 (records request bodies,
 *         auth headers, and the baseUrl it was hit on — the routing oracle).
 *  B82-2  per-model test button (the owner's ask): POST /models/:id/test on
 *         the REAL OpenRouter endpoint with the real key → a well-formed
 *         ModelTestResult (ok:boolean, latencyMs, checks{http,auth,
 *         modelAccepted,nonEmptyContent}, scrubbed contentPreview) — ok:true
 *         when the model answers, an honest reason when it doesn't.
 *  B82-3  THE headline fix (custom-provider routing): create provider
 *         prv_livegw pointing at the LOCAL MOCK (baseUrl http://127.0.0.1:
 *         5298/v1), add model mock/model-a under it, send a streamed turn
 *         with body {model, providerId: "prv_livegw"} → the request MUST
 *         land on the MOCK (the mock's own Authorization header — its
 *         custom-provider key), the turn completes with the mock's reply,
 *         and zero requests went anywhere near openrouter (the mock's
 *         record is the ONLY provider call).
 *  B82-4  NVIDIA (NIM) model test: seed a nvidia provider row + a NIM model
 *         id, POST /models/:id/test with the real nvapi key → a well-formed
 *         ModelTestResult with the REAL provider verdict (the R80 finding:
 *         the account's NIM functions are EOL'd server-side — an honest
 *         ok:false + the provider's own reason is a PASS; a crash, a hang,
 *         or a scrub miss is a FAIL).
 *  B82-5  secret-shape scrubbing: a model-test failure path that echoes the
 *         key back is scrubbed (sk-/nvapi- never appears in any response).
 *  B82-6  subagentModel object form round-trip: PUT /settings/orchestration
 *         {subagentModel:{providerId:"prv_livegw",modelId:"mock/model-a"}} →
 *         GET reflects the pair; a bogus providerId → honest 400; null →
 *         cleared.
 *  B82-7  GET /models/configured: lists configured rows across ALL providers
 *         (openrouter + prv_livegw), ordered provider-then-model.
 *  B82-8  tri-state capability wire: POST /providers/:id/models with
 *         supportsTools:true, supportsAudio:null, supportsVideo:false → the
 *         row records true/null/false (null = UNKNOWN, never false — the
 *         INSERT-path conflation the R82-TESTS round found and the close-out
 *         fixed).
 *
 * Usage: node scripts/battery-r82.mjs   (from the repo root)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const REPO = "/home/z/acute-work/ACUTE-CODE";
const PORT = 5299;
const MOCK_PORT = 5298;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const TOKEN = "acute-dev-local";
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const results = [];
const pass = (id, note) => { results.push(`PASS ${id} — ${note}`); console.log(`PASS ${id} — ${note}`); };
const fail = (id, note) => { results.push(`FAIL ${id} — ${note}`); console.log(`FAIL ${id} — ${note}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  // NOTE: /internal/* routes live OUTSIDE the /api/v1 scope (root app) —
  // paths already starting with /internal are passed through verbatim.
  const url = path.startsWith("/internal")
    ? `http://127.0.0.1:${PORT}${path}`
    : `${BASE}${path}`;
  const res = await fetch(url, {
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

/* ── the mock OpenRouter-compatible SSE gateway (the routing oracle) ────── */
const mockHits = []; // { url, auth, body, at }
let mockScript = []; // replies to burn in order; each: {delayMs, text?, echoKey?}
let mockCalls = 0;
const mockServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c.toString(); });
  req.on("end", () => {
    mockCalls += 1;
    const at = mockCalls;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* not json */ }
    mockHits.push({ url: req.url, auth: req.headers.authorization ?? null, body: parsed, at });
    // The /evil/* path is the HOSTILE gateway: it ALWAYS echoes the
    // bearer's key back in a 401 body (the scrub oracle — no script
    // ordering involved).
    if (req.url.startsWith("/evil")) {
      const echoed = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `bad key ${echoed} rejected` } }));
      return;
    }
    const script = mockScript.shift() ?? { delayMs: 150, text: "R82 LIVE GW OK" };
    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    setTimeout(() => {
      try {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const base = { id: `chatcmpl-m${at}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: parsed?.model ?? "mock-model" };
        sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: script.text ?? "" }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
        res.write("data: [DONE]\n\n");
        res.end();
      } catch { /* socket gone — the script is consumed either way */ }
    }, script.delayMs ?? 150);
  });
});

// ── B82-1: boot the dedicated sidecar + mock gateway ────────────────────────
const scratch = `/tmp/r82-battery-${Date.now()}`;
mkdirSync(scratch, { recursive: true });
const mainKey = readFileSync("/home/z/acute-work/openrouter.key", "utf8").trim();
const nvidiaKey = readFileSync("/home/z/acute-work/nvidia.key", "utf8").trim();
const CUSTOM_KEY = "sk-or-v1-batterycustomkey0000000000000000000000000";
spawnSync("pkill", ["-f", `ACUTE_PORT=${PORT}`]);
const sidecar = spawn("node", [join(REPO, "agent-core/dist/main.js")], {
  cwd: REPO,
  env: {
    ...process.env,
    ACUTE_TOKEN: TOKEN,
    ACUTE_DB_PATH: join(scratch, "battery.db"),
    ACUTE_PORT: String(PORT),
    ACUTE_PROVIDER_OPENROUTER: mainKey,
    ACUTE_PROVIDER_NVIDIA: nvidiaKey,
    ACUTE_PROVIDER_PRV_LIVEGW: CUSTOM_KEY,
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
  fail("B82-1", `sidecar never came up on ${PORT}\n${sidecarLog.slice(-600)}`);
  console.log(results.join("\n"));
  process.exit(1);
}
pass("B82-1", `dedicated sidecar up on ${PORT} + mock gateway on ${MOCK_PORT}`);

const cleanup = () => {
  try { sidecar.kill("SIGKILL"); } catch { /* gone */ }
  try { mockServer.close(); } catch { /* gone */ }
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* busy */ }
};

// A project + agent + session for the turn batteries.
const proj = await api("POST", "/projects", { name: "r82-live" });
const projectId = proj.json?.id;
const agentList = await api("GET", "/agents");
// The MAIN agent (providerId set — "Acute"); index 0 may be a template
// sub-agent (no provider config — the B82-3 409 the first run hit).
const agent = (agentList.json?.agents ?? []).find((a) => a.providerId) ?? agentList.json?.agents?.[0];
const session = await api("POST", "/sessions", { projectId, agentId: agent.id, mode: "single" });
const sessionId = session.json?.id;
if (!sessionId) {
  fail("B82-3", `session creation failed: ${session.status} ${session.text.slice(0, 300)}`);
  cleanup();
  console.log(results.join("\n"));
  process.exit(1);
}

// ── B82-2: the per-model test button on the REAL OpenRouter endpoint ───────
{
  // Add a configured model row on the real openrouter provider, then probe.
  const modelRow = await api("POST", "/providers/openrouter/models", {
    modelId: "z-ai/glm-5.2:free",
    displayName: "Z.ai: GLM 5.2 (live)",
  });
  const modelId = modelRow.json?.id;
  if (modelRow.status !== 201 || !modelId) {
    fail("B82-2", `model add failed: ${modelRow.status} ${modelRow.text.slice(0, 200)}`);
  } else {
    const test = await api("POST", `/models/${modelId}/test`, {});
    const t = test.json;
    const shapeOk =
      test.status === 200 && t && typeof t.ok === "boolean" &&
      typeof t.latencyMs === "number" && t.providerId === "openrouter" &&
      t.model === "z-ai/glm-5.2:free" &&
      t.checks && ["http", "auth", "modelAccepted", "nonEmptyContent"].every((k) => k in t.checks);
    if (!shapeOk) {
      fail("B82-2", `ModelTestResult malformed: ${test.status} ${test.text.slice(0, 300)}`);
    } else if (t.ok === true) {
      const previewOk = typeof t.contentPreview === "string" && t.contentPreview.length > 0;
      const usageOk = t.usage === undefined || (typeof t.usage.inputTokens === "number" && typeof t.usage.outputTokens === "number");
      if (previewOk && usageOk) {
        pass("B82-2", `real model test ok:true in ${t.latencyMs}ms (http/auth/model/content all pass${t.usage ? `, usage ${t.usage.inputTokens}+${t.usage.outputTokens}` : ""})`);
      } else {
        fail("B82-2", `ok:true but preview/usage malformed: ${JSON.stringify(t).slice(0, 300)}`);
      }
    } else {
      // An honest NO is a valid probe outcome (quota, model retirement) —
      // the REASON must be present, real, and scrubbed.
      const reasonOk = typeof t.reason === "string" && t.reason.length > 0;
      const scrubbed = !t.reason?.includes("sk-or-");
      if (reasonOk && scrubbed) {
        pass("B82-2", `real model test honest ok:false — "${t.reason.slice(0, 140)}" (scrubbed, no crash)`);
      } else {
        fail("B82-2", `ok:false with a bad reason: ${JSON.stringify(t).slice(0, 300)}`);
      }
    }
  }
}

// ── B82-3: THE custom-provider routing fix (the local mock gateway) ────────
{
  const created = await api("POST", "/providers", {
    id: "prv_livegw",
    name: "R82 Live Gateway",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    apiFormat: "chat-completions",
  });
  if (created.status !== 201 && created.status !== 200) {
    fail("B82-3", `custom provider create failed: ${created.status} ${created.text.slice(0, 200)}`);
  } else {
    const modelRow = await api("POST", "/providers/prv_livegw/models", {
      modelId: "mock/model-a",
      displayName: "Mock Model A",
    });
    if (modelRow.status !== 201 && modelRow.status !== 200) {
      fail("B82-3", `custom model row create failed: ${modelRow.status} ${modelRow.text.slice(0, 200)}`);
    }
    const before = mockHits.length;
    mockScript.push({ delayMs: 150, text: "R82 CUSTOM ROUTING OK" });
    const turn = await streamTurn(sessionId, "Say exactly what your gateway tells you.", {
      model: "mock/model-a",
      providerId: "prv_livegw",
    });
    const done = turn.frames.some((f) => f.type === "done");
    const delivered = mockHits.length - before;
    const hit = mockHits[mockHits.length - 1];
    const authOk = hit?.auth === `Bearer ${CUSTOM_KEY}`;
    if (done && turn.text.includes("R82 CUSTOM ROUTING OK") && delivered === 1 && authOk) {
      pass("B82-3", `custom model routed through prv_livegw (mock hit ${hit.url}, custom key auth, reply delivered, ONE provider call)`);
    } else {
      fail("B82-3", `routing broken: done=${done} text="${turn.text.slice(0, 80)}" mockHits=${delivered} auth=${hit?.auth?.slice(0, 20)} frames=${JSON.stringify(turn.frames.slice(0, 6)).slice(0, 300)}`);
    }
  }
}

// ── B82-4: the NVIDIA (NIM) model test with the real nvapi key ─────────────
{
  // The boot seed creates the nvidia provider row when the key is present.
  const providers = await api("GET", "/providers");
  const nvidia = providers.json?.providers?.find((p) => p.id === "nvidia");
  if (!nvidia) {
    fail("B82-4", "nvidia provider row absent from GET /providers (boot seed)");
  } else {
    const modelRow = await api("POST", "/providers/nvidia/models", {
      modelId: "meta/llama-3.1-70b-instruct",
      displayName: "Llama 3.1 70B (NIM live)",
    });
    const modelId = modelRow.json?.id;
    const test = await api("POST", `/models/${modelId}/test`, {});
    const t = test.json;
    const shapeOk =
      test.status === 200 && t && typeof t.ok === "boolean" &&
      typeof t.latencyMs === "number" && t.providerId === "nvidia" &&
      t.checks && ["http", "auth", "modelAccepted", "nonEmptyContent"].every((k) => k in t.checks);
    if (!shapeOk) {
      fail("B82-4", `NIM ModelTestResult malformed: ${test.status} ${test.text.slice(0, 300)}`);
    } else if (t.ok === true) {
      pass("B82-4", `NIM model test ok:true in ${t.latencyMs}ms — ${JSON.stringify(t.checks)}`);
    } else {
      const scrubbed = !JSON.stringify(t).includes("nvapi-");
      if (typeof t.reason === "string" && t.reason.length > 0 && scrubbed) {
        pass("B82-4", `NIM test honest ok:false — "${t.reason.slice(0, 140)}" (nvapi- scrubbed; the R80 EOL verdict surfaces, no crash)`);
      } else {
        fail("B82-4", `ok:false with a bad/leaky reason: ${JSON.stringify(t).slice(0, 300)}`);
      }
    }
  }
}

// ── B82-5: secret-shape scrubbing on a hostile echo ────────────────────────
{
  // A second custom provider row whose gateway ALWAYS echoes the bearer
  // key back on 401 (the /evil path — no script ordering involved).
  await api("POST", "/providers", {
    id: "prv_evilgw",
    name: "R82 Evil Gateway",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/evil/v1`,
    apiFormat: "chat-completions",
  });
  const modelRow = await api("POST", "/providers/prv_evilgw/models", {
    modelId: "mock/evil-a",
    displayName: "Evil Model A",
  });
  const modelId = modelRow.json?.id;
  // Plant the openrouter key on the keyring for the evil row so the echo
  // exposes a recognizable sk- shape.
  await api("POST", "/internal/providers/keys", { providerId: "prv_evilgw", value: mainKey });
  const test = await api("POST", `/models/${modelId}/test`, {});
  const leaked = JSON.stringify(test.json).includes("sk-or-");
  if (!leaked && test.status === 200) {
    pass("B82-5", `hostile key echo scrubbed from the model-test response (status ${test.status}, reason: ${String(test.json?.reason).slice(0, 100)})`);
  } else {
    fail("B82-5", `key leak or crash: status=${test.status} body=${test.text.slice(0, 300)}`);
  }
}

// ── B82-6: subagentModel object form round-trip + validation ───────────────
{
  const put = await api("PUT", "/settings/orchestration", {
    subagentModel: { providerId: "prv_livegw", modelId: "mock/model-a" },
  });
  if (put.status !== 200) {
    fail("B82-6", `subagentModel PUT rejected: ${put.status} ${put.text.slice(0, 200)}`);
  }
  const get = await api("GET", "/settings/orchestration");
  const roundTrip = get.json?.subagentModel?.providerId === "prv_livegw" &&
    get.json?.subagentModel?.modelId === "mock/model-a";
  const bogus = await api("PUT", "/settings/orchestration", {
    subagentModel: { providerId: "prv_missing", modelId: "whatever" },
  });
  const bogusRejected = bogus.status === 400;
  const cleared = await api("PUT", "/settings/orchestration", { subagentModel: null });
  const get2 = await api("GET", "/settings/orchestration");
  const nullClear = get2.json?.subagentModel === null && cleared.status === 200;
  if (roundTrip && bogusRejected && nullClear) {
    pass("B82-6", "subagentModel object form round-trips, unknown provider 400s, null clears");
  } else {
    fail("B82-6", `subagentModel wire: roundTrip=${roundTrip} bogus=${bogus.status} nullClear=${nullClear} (GET: ${JSON.stringify(get.json).slice(0, 200)})`);
  }
}

// ── B82-7: GET /models/configured across providers ─────────────────────────
{
  const res = await api("GET", "/models/configured");
  const rows = res.json?.models ?? res.json;
  const hasOpenRouter = Array.isArray(rows) && rows.some((m) => m.providerId === "openrouter");
  const hasCustom = Array.isArray(rows) && rows.some((m) => m.providerId === "prv_livegw");
  const ordered = Array.isArray(rows) && rows.every((m, i) => i === 0 || `${rows[i - 1].providerId}${rows[i - 1].modelId}`.localeCompare(`${m.providerId}${m.modelId}`) <= 0);
  if (res.status === 200 && hasOpenRouter && hasCustom) {
    pass("B82-7", `configured rows across providers (openrouter + prv_livegw present${ordered ? ", ordered" : ""})`);
  } else {
    fail("B82-7", `configured rows wrong: status=${res.status} openrouter=${hasOpenRouter} custom=${hasCustom}`);
  }
}

// ── B82-8: tri-state capability wire on INSERT ─────────────────────────────
{
  const modelRow = await api("POST", "/providers/openrouter/models", {
    modelId: "test/tri-live",
    displayName: "Tri-State Live",
    supportsTools: true,
    supportsAudio: null,
    supportsVideo: false,
  });
  const t = modelRow.json;
  const triOk =
    modelRow.status === 201 &&
    t?.supportsTools === true && t?.supportsAudio === null && t?.supportsVideo === false;
  if (triOk) {
    pass("B82-8", "INSERT tri-state wire: true / null(unknown) / false recorded exactly (never null→false)");
  } else {
    fail("B82-8", `tri-state INSERT wrong: ${modelRow.status} ${JSON.stringify(t).slice(0, 250)}`);
  }
}

// ── teardown + verdict ──────────────────────────────────────────────────────
cleanup();
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\nR82 LIVE BATTERY: ${results.length - failed}/${results.length} PASS${failed === 0 ? " — ALL GREEN" : ` — ${failed} FAIL`}`);
if (sidecarLog.includes("nvapi-") || sidecarLog.includes("sk-or-v1-")) {
  console.log("WARNING: sidecar log contains a raw key prefix — investigate");
  failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
