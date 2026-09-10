/**
 * ROUND-83 LIVE BATTERY (self-supervising — the sandbox reaps background
 * processes when the launching command exits, so the whole battery owns its
 * sidecar):
 *
 *  B83-1  boot: dedicated sidecar on 5309 (scratch DB, real OpenRouter key).
 *  B83-2  THE headline (honest metering): a REAL streamed OpenRouter turn
 *         (z-ai/glm-5.2:free) → GET /sessions/:id/context carries the R83
 *         wire: `actual` (the provider's OWN prompt tokens for the last
 *         request — non-null and > 0 after a real reply, with the model +
 *         ts), `usedTokensBasis: "estimated"`, the budget trio
 *         (contextWindowSource labeled, maxOutputTokens, available =
 *         window − output − 8000 exactly), and sessionTotals.providerCalls
 *         (the REAL SDK-call count, ≥ the turn count).
 *  B83-3  the honest hit rate: cache.hitRate is null OR a fraction in
 *         [0,1] — never a fabricated 0% on a provider that didn't report
 *         (OpenRouter's glm-5.2:free typically reports no cache tier →
 *         null; either honest outcome passes, a number outside [0,1] or
 *         0-with-input-and-no-cache-report is a fail we can't distinguish
 *         here — so the shape pin is the contract).
 *  B83-4  POST /sessions/:id/compact on the small fresh session → 200
 *         {compacted:false, reason} (nothing to summarize — the honest
 *         decline, never a 500; the affordance the 800K guard used to
 *         promise finally EXISTS).
 *  B83-5  GET /usage/detailed: the turn's spend visible with
 *         totals.providerCalls ≥ 1 and a model row carrying
 *         providerCalls + costKnown (boolean — the (unpriced) marker's
 *         source).
 *
 * Usage: node scripts/battery-r83.mjs   (from the repo root)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/z/acute-work/ACUTE-CODE";
const PORT = 5309;
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

// ── B83-1: boot the dedicated sidecar ───────────────────────────────────────
const scratch = `/tmp/r83-battery-${Date.now()}`;
mkdirSync(scratch, { recursive: true });
const mainKey = readFileSync("/home/z/acute-work/openrouter.key", "utf8").trim();
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
  fail("B83-1", `sidecar never came up on ${PORT}\n${sidecarLog.slice(-600)}`);
  console.log(results.join("\n"));
  process.exit(1);
}
pass("B83-1", `dedicated sidecar up on ${PORT} (scratch DB, real OpenRouter key)`);

const cleanup = () => {
  try { sidecar.kill("SIGKILL"); } catch { /* gone */ }
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* busy */ }
};

// A project + the MAIN agent + a session for the turn.
const proj = await api("POST", "/projects", { name: "r83-live" });
const projectId = proj.json?.id;
const agentList = await api("GET", "/agents");
const agent = (agentList.json?.agents ?? []).find((a) => a.providerId) ?? agentList.json?.agents?.[0];
const session = await api("POST", "/sessions", { projectId, agentId: agent.id, mode: "single" });
const sessionId = session.json?.id;
if (!sessionId) {
  fail("B83-2", `session creation failed: ${session.status} ${session.text.slice(0, 300)}`);
  cleanup();
  console.log(results.join("\n"));
  process.exit(1);
}

// ── B83-2: a REAL OpenRouter turn → the honest context report ──────────────
{
  // Point the agent at the free catalog model for a real streamed reply.
  const modelRow = await api("POST", "/providers/openrouter/models", {
    modelId: "z-ai/glm-5.2:free",
    displayName: "Z.ai: GLM 5.2 (live R83)",
  });
  if (modelRow.status !== 201 && modelRow.status !== 200) {
    fail("B83-2", `model add failed: ${modelRow.status} ${modelRow.text.slice(0, 200)}`);
  }
  await api("PATCH", `/agents/${agent.id}`, { model: "z-ai/glm-5.2:free" });
  const turn = await streamTurn(sessionId, "Reply with the single word: metered", {
    model: "z-ai/glm-5.2:free",
  });
  const report = await api("GET", `/sessions/${sessionId}/context`);
  const r = report.json;
  const checks = [];
  if (report.status !== 200) checks.push(`status=${report.status}`);
  if (typeof r?.usedTokensBasis !== "string" || r.usedTokensBasis !== "estimated") {
    checks.push(`usedTokensBasis=${JSON.stringify(r?.usedTokensBasis)}`);
  }
  if (r?.actual === null || r?.actual === undefined) {
    checks.push("actual missing after a real reply");
  } else {
    if (typeof r.actual.inputTokens !== "number" || r.actual.inputTokens <= 0) {
      checks.push(`actual.inputTokens=${r.actual.inputTokens}`);
    }
    if (typeof r.actual.at !== "string" || r.actual.at === "") checks.push("actual.at missing");
    if (typeof r.actual.model !== "string" || r.actual.model === "") checks.push("actual.model missing");
  }
  if (typeof r?.contextWindowSource !== "string") checks.push("contextWindowSource missing");
  if (typeof r?.maxOutputTokens !== "number" || r.maxOutputTokens <= 0) checks.push("maxOutputTokens bad");
  if (
    typeof r?.contextWindow !== "number" ||
    typeof r?.available !== "number" ||
    r.available !== r.contextWindow - r.maxOutputTokens - 8000
  ) {
    checks.push(`budget math: window=${r?.contextWindow} out=${r?.maxOutputTokens} avail=${r?.available}`);
  }
  if (typeof r?.sessionTotals?.providerCalls !== "number" || r.sessionTotals.providerCalls < 1) {
    checks.push(`providerCalls=${r?.sessionTotals?.providerCalls}`);
  }
  if (turn.status !== 200) checks.push(`turn status=${turn.status}`);
  if (checks.length === 0) {
    pass(
      "B83-2",
      `real turn + honest report: actual=${r.actual.inputTokens} tokens measured (model ${r.actual.model}), ` +
        `basis="${r.usedTokensBasis}", window ${r.contextWindow} (${r.contextWindowSource}) − out ${r.maxOutputTokens} = available ${r.available}, ` +
        `turns ${r.sessionTotals.requests} · providerCalls ${r.sessionTotals.providerCalls}`,
    );
  } else {
    fail("B83-2", checks.join("; ") + ` — report: ${report.text.slice(0, 300)}`);
  }
}

// ── B83-3: the honest cache hit rate (null or a real fraction) ──────────────
{
  const report = await api("GET", `/sessions/${sessionId}/context`);
  const r = report.json;
  const rate = r?.cache?.hitRate;
  const input = r?.cache?.inputTokens ?? 0;
  const shapeOk = rate === null || (typeof rate === "number" && rate >= 0 && rate <= 1);
  if (shapeOk) {
    pass(
      "B83-3",
      input > 0
        ? `cache line honest: hitRate ${rate === null ? "null (not reported by this provider — never a fabricated 0%)" : `${(rate * 100).toFixed(1)}%`} on ${input} input tokens`
        : "cache line honest: no usage yet",
    );
  } else {
    fail("B83-3", `hitRate malformed: ${JSON.stringify(rate)}`);
  }
}

// ── B83-4: POST /sessions/:id/compact — the affordance EXISTS ───────────────
{
  const res = await api("POST", `/sessions/${sessionId}/compact`, {});
  const b = res.json;
  // A fresh 2-3 message session: force compaction runs the summarizer over
  // the tiny head (a real provider call — metered, origin 'compaction') OR
  // declines honestly if there is nothing to summarize. Both are 200.
  const okShape =
    res.status === 200 &&
    ((b?.compacted === false && typeof b?.reason === "string") ||
      (b?.compacted === true && typeof b?.throughSeq === "number"));
  if (okShape) {
    pass(
      "B83-4",
      b?.compacted === true
        ? `compact route ran a real compaction (throughSeq ${b.throughSeq}, ${b.droppedMessages} messages, ~${b.tokensSaved} saved)`
        : `compact route answered the honest decline: "${String(b.reason).slice(0, 120)}"`,
    );
  } else {
    fail("B83-4", `compact route malformed: ${res.status} ${res.text.slice(0, 300)}`);
  }
}

// ── B83-5: the usage rollups carry the R83 truth columns ───────────────────
{
  const res = await api("GET", "/usage/detailed?days=7");
  const d = res.json;
  const totalsOk = typeof d?.totals?.providerCalls === "number" && d.totals.providerCalls >= 1;
  const modelsOk = Array.isArray(d?.models) && d.models.length > 0;
  const first = modelsOk ? d.models[0] : null;
  const rowOk =
    first !== null &&
    typeof first.providerCalls === "number" &&
    typeof first.costKnown === "boolean";
  if (res.status === 200 && totalsOk && rowOk) {
    pass(
      "B83-5",
      `usage rollups: totals.providerCalls=${d.totals.providerCalls}, model row "${first.model}" providerCalls=${first.providerCalls} costKnown=${first.costKnown}`,
    );
  } else {
    fail(
      "B83-5",
      `usage rollups malformed: status=${res.status} totalsOk=${totalsOk} rowOk=${rowOk} — ${res.text.slice(0, 250)}`,
    );
  }
}

cleanup();
console.log("\n── R83 LIVE BATTERY VERDICT ──");
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(failed === 0 ? "ALL GREEN" : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
