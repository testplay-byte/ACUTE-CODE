// ROUND-95 (R95): the Linux LIVE-FIRE test against the REAL OpenRouter API
// with the REAL free Nemotron models (the owner's directive: "perform the
// tests properly using the API keys which I have provided and utilizing
// the free models. From OpenRouter you can utilize the NemoTron 3.5 Super
// or the NemoTron 3.5 flash model"). Unlike r94-live-fire.mjs (whose
// provider is a local fake), this harness routes the sidecar through a
// RECORDING PROXY that forwards to https://openrouter.ai/api/v1 — so the
// exact wire traffic (outgoing request bodies incl. the system prompt +
// reasoning parameters; incoming response bodies incl. usage) is captured
// and asserted while the model is REAL.
//
// Proves on Linux, end-to-end on the wire:
//   1. THE SKILLS SECTION (R95-H): the system prompt sent to the provider
//      contains the "## SKILLS" section with the enabled skills' names +
//      one-line descriptions (progressive disclosure — R61's contract,
//      verified live for the first time).
//   2. MODEL-AWARE REASONING (R95-E): a model row carrying
//      reasoningSupport {supported:true, efforts:["low","medium"]} +
//      thinkingLevel "high" sends reasoning.effort "medium" (the nearest
//      supported rung) + the reasoning.max_tokens budget — never a raw
//      "high" that the model would reject.
//   3. REASONING OFF (R95-E): a model row with reasoningSupport
//      {supported:false} + any thinkingLevel sends NO reasoning key.
//   4. TOKEN USAGE TRUTH (R95-H): the turn's persisted usage (the sidecar's
//      usage accounting) matches the provider-reported usage in the
//      response body — the owner's "app vs actual API usage" deviation ask.
//   5. THE LOCAL-FILE BROWSER ROUTE (R95-C): the sidecar's
//      /browser/local-file route serves a real local HTML file, and
//      POST /browser/navigate accepts a file:// URL (the R95-C wire half).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const REPO_ROOT = "/home/z/repos/acute-code";
const MAIN_JS = join(REPO_ROOT, "agent-core", "dist", "main.js");
const TOKEN = "r95-live-fire-token";
const OPENROUTER_KEY = (await import("node:fs")).readFileSync("/home/z/.secrets/openrouter.key", "utf8").trim();
if (!existsSync(MAIN_JS)) {
  console.error("agent-core/dist/main.js missing — run pnpm build first");
  process.exit(1);
}

// ── the recording proxy: sidecar → here → https://openrouter.ai/api/v1 ────
const UPSTREAM = "https://openrouter.ai/api/v1";
const realCaptured = { requests: [], responses: [] };
const recProxy = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* not json */ }
    realCaptured.requests.push({ url: req.url, method: req.method, body: parsed ?? body, raw: body });
    // The provider baseUrl ends in /v1, so incoming paths look like
    // /v1/chat/completions — strip that prefix before joining the upstream
    // (https://openrouter.ai/api/v1 + /chat/completions).
    const upstreamPath = req.url.replace(/^\/v1(?=\/|$)/, "");
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    delete headers.connection;
    fetch(`${UPSTREAM}${upstreamPath}`, {
      method: req.method,
      headers,
      ...(body.length > 0 && req.method !== "GET" ? { body } : {}),
    })
      .then(async (up) => {
        const text = await up.text();
        let parsedRes = null;
        try {
          parsedRes = JSON.parse(text);
        } catch {
          // SSE stream — parse the data: chunks so usage (which rides the
          // final chunks under stream_options.include_usage) is visible.
          const chunks = [];
          for (const line of text.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") continue;
            try { chunks.push(JSON.parse(payload)); } catch { /* keepalive */ }
          }
          if (chunks.length > 0) parsedRes = { __sse: true, chunks };
        }
        realCaptured.responses.push({ url: req.url, status: up.status, body: parsedRes, text });
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
        res.end(text);
      })
      .catch((err) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      });
  });
});
await new Promise((r) => recProxy.listen(0, "127.0.0.1", r));
const proxyPort = recProxy.address().port;
console.log(`[proxy] recording proxy on :${proxyPort} → ${UPSTREAM}`);

// ── boot the sidecar ───────────────────────────────────────────────────────
const tempDir = mkdtempSync(join(tmpdir(), "acute-r95-live-"));
const child = spawn(process.execPath, [MAIN_JS], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    ACUTE_TOKEN: TOKEN,
    ACUTE_DB_PATH: join(tempDir, "live.db"),
    ACUTE_PROVIDER_LIVETEST: OPENROUTER_KEY,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("sidecar not ready in 15s")), 15000);
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const line = buffer.split("\n").find((l) => l.startsWith("ACUTE_READY"));
    if (line) {
      clearTimeout(timer);
      resolve(JSON.parse(line.slice("ACUTE_READY ".trim().length)).port);
    }
  });
  child.once("exit", (code) => reject(new Error(`sidecar exited early (code ${code})`)));
});
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`[sidecar] ready on :${port}`);

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204s */ }
  return { status: res.status, json };
}

const MODEL_ID = "nvidia/nemotron-3-super-120b-a12b:free";
const NO_REASON_MODEL_ID = "nvidia/nemotron-3.5-lightning:free";

// The provider pointed at the recording proxy (a custom OpenAI-compatible
// provider whose key rides ACUTE_PROVIDER_LIVETEST).
const providerRes = await api("POST", "/providers", {
  name: "R95 Live OpenRouter",
  id: "livetest",
  baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
  apiFormat: "chat-completions",
});
assert.equal(providerRes.status, 201, `provider create: ${providerRes.status} ${JSON.stringify(providerRes.json)}`);

// Model rows: the reasoning-capable Nemotron Super (efforts low|medium per
// OpenRouter's catalog) and the no-reasoning-config Lightning.
const modelA = await api("POST", "/providers/livetest/models", {
  modelId: MODEL_ID,
  reasoningSupport: { supported: true, efforts: ["low", "medium"] },
});
assert.equal(modelA.status, 201, `model A create: ${modelA.status} ${JSON.stringify(modelA.json)}`);
const modelB = await api("POST", "/providers/livetest/models", {
  // The ladder-less shape: lightning supports reasoning but names no
  // discrete efforts — the max_tokens budget is its only knob.
  modelId: NO_REASON_MODEL_ID,
  reasoningSupport: { supported: true, efforts: [] },
});
assert.equal(modelB.status, 201, `model B create: ${modelB.status} ${JSON.stringify(modelB.json)}`);

const agentRes = await api("POST", "/agents", { name: "R95 Live Agent", providerId: "livetest", model: MODEL_ID });
assert.equal(agentRes.status, 201);
const agentId = agentRes.json.id;
const projectRes = await api("POST", "/projects", { name: "R95 Live Fire", rootPath: tempDir });
assert.equal(projectRes.status, 201, `project create: ${projectRes.status}`);
const projectId = projectRes.json.id ?? projectRes.json.project?.id;
const newSession = (title) => api("POST", "/sessions", { agentId, mode: "single", title, projectId });

/** Opens the SSE turn and collects every frame. */
async function streamTurn(sessionId, content, extra = {}) {
  const res = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ content, ...extra }),
  });
  assert.equal(res.status, 200, `stream open: ${res.status}`);
  const events = [];
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString();
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine === undefined) continue;
      try { events.push(JSON.parse(dataLine.slice(5).trim())); } catch { /* keepalive */ }
    }
  }
  return events;
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${err?.stack ?? err}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── scenario 1: reasoning-capable model + thinkingLevel high ──────────────
console.log("\n── scenario 1: SKILLS section + mapped reasoning effort + usage truth ──");
{
  const sess = await newSession("r95-reasoning-live");
  const sid = sess.json.id ?? sess.json.session?.id;
  const events = await streamTurn(sid, "Reply with exactly: ACUTE-LIVE-FIRE-OK and nothing else.", { thinkingLevel: "high" });
  await sleep(500);
  const req = realCaptured.requests.find((r) => r.url.includes("/chat/completions") && r.body?.model === MODEL_ID);
  check("the request reached the real OpenRouter upstream (captured)", () => assert.ok(req, "no captured request for " + MODEL_ID));
  check("reasoning.effort mapped high→medium (the model's ladder caps at medium)", () => {
    assert.ok(req, "request missing");
    assert.equal(req.body.reasoning?.effort, "medium", `reasoning=${JSON.stringify(req.body.reasoning)}`);
  });
  check("NO reasoning.max_tokens alongside the effort (OpenRouter refuses the pair — R95-G live-fire)", () => {
    assert.ok(req, "request missing");
    assert.equal(req.body.reasoning?.max_tokens, undefined, `reasoning=${JSON.stringify(req.body.reasoning)}`);
  });
  check("the system prompt carries the SKILLS section (names + descriptions)", () => {
    assert.ok(req, "request missing");
    const sys = req.body.messages?.find((m) => m.role === "system");
    assert.ok(sys, "no system message");
    const text = typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);
    assert.ok(text.includes("## SKILLS"), "no SKILLS heading");
    assert.ok(text.includes("read_skill"), "skills must teach read_skill");
    assert.ok(/- \*\*[\w-]+\*\* — /.test(text), "no '- **name** — description' list lines");
  });
  check("the turn completed with assistant text", () => {
    const text = events.filter((e) => e.type === "text-delta").map((e) => e.delta ?? "").join("");
    assert.ok(text.trim().length > 0, `no text; events=${JSON.stringify(events.slice(0, 8))}`);
  });
  // ── usage truth: our accounting vs the provider's own numbers ──
  const usageResp = realCaptured.responses.find((r) => {
    if (!r.url.includes("/chat/completions")) return false;
    if (typeof r.body?.usage === "object" && r.body.usage !== null) return true;
    // SSE: the usage rides one of the stream chunks (include_usage).
    return r.body?.__sse === true && Array.isArray(r.body.chunks) && r.body.chunks.some((c) => c.usage && typeof c.usage === "object");
  });
  check("the provider reported usage", () => assert.ok(usageResp, "no captured usage"));
  if (usageResp) {
    const providerUsage = usageResp.body?.__sse === true && Array.isArray(usageResp.body.chunks)
      ? usageResp.body.chunks.find((c) => c.usage && typeof c.usage === "object").usage
      : usageResp.body.usage;
    // The app's own measured number: the R83 context report's `actual`
    // (the provider-reported prompt size for the LAST request — the same
    // wire the ContextDonut renders) + the usage screen's totals.
    const ctx = await api("GET", `/sessions/${sid}/context`);
    const appIn = ctx.json?.actual?.inputTokens ?? undefined;
    const usageDetail = await api("GET", "/usage/detailed");
    const row = (usageDetail.json?.rows ?? usageDetail.json?.usage ?? []).find?.(
      (r) => r.sessionId === sid,
    );
    const appOut = row?.outputTokens ?? undefined;
    const appOutFromCtx = ctx.json?.actual?.outputTokens ?? undefined;
    check("app-recorded input tokens match the provider's number (R83 actual)", () =>
      assert.equal(appIn, providerUsage.prompt_tokens, `app=${appIn} provider=${providerUsage.prompt_tokens}`));
    check("app-recorded output tokens match the provider's number", () =>
      assert.equal(appOut ?? appOutFromCtx, providerUsage.completion_tokens, `app=${appOut ?? appOutFromCtx} provider=${providerUsage.completion_tokens}`));
    console.log(`    [usage] provider: in=${providerUsage.prompt_tokens} out=${providerUsage.completion_tokens} (reasoning=${providerUsage.completion_tokens_details?.reasoning_tokens ?? "?"}) | app: in=${appIn} out=${appOut ?? appOutFromCtx}`);
  }
}

// ── scenario 2: the ladder-less budget + the supported:false gate ─────────
console.log("\n── scenario 2: ladder-less budget-only + supported:false gating ──");
{
  // 2a: ladder-less (lightning) — the budget rides ALONE (no effort key).
  const agent2 = await api("POST", "/agents", { name: "R95 Ladderless Agent", providerId: "livetest", model: NO_REASON_MODEL_ID });
  const sid2 = (await api("POST", "/sessions", { agentId: agent2.json.id, mode: "single", title: "r95-ladderless", projectId })).json.id;
  await streamTurn(sid2, "Reply with exactly: LADDERLESS-OK and nothing else.", { thinkingLevel: "high" });
  await sleep(500);
  const req2 = realCaptured.requests.filter((r) => r.body?.model === NO_REASON_MODEL_ID).pop();
  check("request captured for the ladder-less model", () => assert.ok(req2, "no captured request for " + NO_REASON_MODEL_ID));
  check("ladder-less: the max_tokens budget rides with NO effort key", () => {
    assert.ok(req2, "request missing");
    assert.equal(req2.body.reasoning?.effort, undefined, `reasoning=${JSON.stringify(req2.body.reasoning)}`);
    assert.ok(typeof req2.body.reasoning?.max_tokens === "number" && req2.body.reasoning.max_tokens > 0, `reasoning=${JSON.stringify(req2.body.reasoning)}`);
  });
  const reqsBefore = realCaptured.requests.length;

  // 2b: flip the row to supported:false — a NEW turn must send NO reasoning.
  const modelBId = modelB.json?.id ?? modelB.json?.model?.id;
  const flip = await api("PATCH", `/models/${modelBId}`, { reasoningSupport: { supported: false, efforts: [] } });
  check("PATCH /models/:id flips the stored reasoning support", () => {
    assert.ok(flip.status === 200 || flip.status === 204, `patch: ${flip.status} ${JSON.stringify(flip.json)}`);
  });
  const sid3 = (await api("POST", "/sessions", { agentId: agent2.json.id, mode: "single", title: "r95-gated", projectId })).json.id;
  await streamTurn(sid3, "Reply with exactly: GATED-OK and nothing else.", { thinkingLevel: "high" });
  await sleep(500);
  const req3 = realCaptured.requests.slice(reqsBefore).filter((r) => r.body?.model === NO_REASON_MODEL_ID).pop();
  check("supported:false row sends NO reasoning key (capability-gated)", () => {
    assert.ok(req3, "no captured gated request");
    assert.equal(req3.body.reasoning, undefined, `reasoning=${JSON.stringify(req3.body.reasoning)}`);
  });
}

// ── scenario 3: the local-file browser route + file:// navigate ───────────
console.log("\n── scenario 3: local HTML file over the browser wire ──");
{
  const htmlPath = join(tempDir, "demo.html");
  writeFileSync(htmlPath, "<!doctype html><html><head><title>ACUTE Live Demo</title></head><body><h1>Hello local file</h1></body></html>");
  const bs = await api("POST", "/browser/session", {});
  assert.equal(bs.status, 200, `browser session: ${bs.status}`);
  const ticket = bs.json.ticket;
  const sessionId = bs.json.sessionId;
  const nav = await api("POST", "/browser/navigate", { sessionId, url: "file://" + htmlPath });
  check("POST /browser/navigate accepts the file:// URL", () => {
    assert.equal(nav.status, 200, `nav: ${nav.status} ${JSON.stringify(nav.json)}`);
    assert.equal(nav.json.ok !== false, true);
    assert.equal(nav.json.entry?.url, "file://" + htmlPath);
  });
  const lf = await fetch(`${baseUrl}/api/v1/browser/local-file?path=${encodeURIComponent(htmlPath)}&sessionId=${encodeURIComponent(sessionId)}&bt=${encodeURIComponent(ticket)}`);
  const lfBody = await lf.text();
  check("GET /browser/local-file serves the local HTML (ticket-gated)", () => {
    assert.equal(lf.status, 200, `local-file: ${lf.status}`);
    assert.ok(lfBody.includes("Hello local file"), `body=${lfBody.slice(0, 120)}`);
    assert.ok((lf.headers.get("content-type") ?? "").includes("text/html"), `ct=${lf.headers.get("content-type")}`);
  });
  const noTicket = await fetch(`${baseUrl}/api/v1/browser/local-file?path=${encodeURIComponent(htmlPath)}&sessionId=${encodeURIComponent(sessionId)}`);
  check("the local-file route refuses without a ticket (auth wall)", () => assert.equal(noTicket.status, 401, `status=${noTicket.status}`));
}

// ── teardown ───────────────────────────────────────────────────────────────
child.kill("SIGTERM");
recProxy.close();
await sleep(300);
try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* windows-ish */ }
console.log(failures === 0 ? "\nR95 LIVE-FIRE: ALL CHECKS PASSED" : `\nR95 LIVE-FIRE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
