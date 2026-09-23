#!/usr/bin/env node
/**
 * ROUND-120 (R120-H, §2 Track H): the LIVE BATTERY — one real project task,
 * end-to-end, through the real sidecar + a real provider key. This is the
 * harness Wave 4 drives; its law is item 43's: a turn ends ONLY on (a) a real
 * final answer, (b) a user abort (labeled), or (c) a surfaced error. The
 * battery exits NON-ZERO on a silent stop — a stream that closes without a
 * terminal frame, or a `done` frame over zero text and zero tool calls.
 *
 *   S1  boot/reuse: probe the sidecar at http://127.0.0.1:${PORT}/api/v1 —
 *       a healthy answer reuses it; anything else boots a DEDICATED sidecar
 *       (agent-core/dist/main.js, scratch DB, ACUTE_TOKEN) that this process
 *       owns and kills on exit (the battery-r79 self-supervising precedent).
 *   S2  the world: a scratch PROJECT (real files on disk), the battery
 *       PROVIDER (openai-compatible, chat-completions, your base URL + key),
 *       the battery AGENT (your model), a fresh SESSION.
 *   S3  THE TASK (real, small, verifiable): "Create notes/a.txt with the
 *       line 'hello', then read it back and tell me its exact content."
 *       Streamed over SSE with per-frame arrival timestamps.
 *   S4  the verdict: how the turn ended, WHICH exit path, the tool calls,
 *       the durations — and the hard checks: a terminal frame arrived, the
 *       answer names the file's exact content, the file exists on disk with
 *       the right bytes.
 *
 * Env:
 *   ACUTE_BATTERY_KEY       REQUIRED for a live run — the provider API key
 *                           (OpenRouter / NVIDIA / any openai-compatible).
 *   ACUTE_BATTERY_BASE_URL  the provider's API base (default
 *                           https://openrouter.ai/api/v1 — e.g.
 *                           https://integrate.api.nvidia.com/v1 for NVIDIA).
 *   ACUTE_BATTERY_MODEL     the model id (default openai/gpt-4o-mini).
 *   ACUTE_BATTERY_TOKEN     the sidecar bearer token for a BOOTED sidecar
 *                           (default r120-battery-token; a REUSED sidecar
 *                           must share it).
 *   ACUTE_BATTERY_PORT      the sidecar port (default 5199).
 *   ACUTE_BATTERY_TIMEOUT_MS  the turn guard (default 300000).
 *   ACUTE_BATTERY_TASK      override the task text (default: the S3 task).
 *
 * Usage:  node agent-core/scripts/live-battery.mjs
 *         node agent-core/scripts/live-battery.mjs --help   (dry-run, no key
 *         needed — exits 0 after printing this contract)
 * Missing ACUTE_BATTERY_KEY → the dry-run explanation, exit 2 (never a
 * half-live run that would look like a silent stop).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_CORE = resolve(HERE, "..");
const DIST_MAIN = join(AGENT_CORE, "dist", "main.js");
const PORT = Number(process.env.ACUTE_BATTERY_PORT ?? 5199);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;
const TOKEN = process.env.ACUTE_BATTERY_TOKEN ?? "r120-battery-token";
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const KEY = process.env.ACUTE_BATTERY_KEY ?? "";
const PROVIDER_BASE_URL = process.env.ACUTE_BATTERY_BASE_URL ?? "https://openrouter.ai/api/v1";
const MODEL = process.env.ACUTE_BATTERY_MODEL ?? "openai/gpt-4o-mini";
const TURN_TIMEOUT_MS = Number(process.env.ACUTE_BATTERY_TIMEOUT_MS ?? 300_000);
const TASK =
  process.env.ACUTE_BATTERY_TASK ??
  "Create notes/a.txt with the line 'hello', then read it back and tell me its exact content";
const PROVIDER_ID = "battery";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the help / missing-env dry-run paths (no key, no sidecar) ───────────── */
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    [
      "R120-H live battery — one real project task through the real sidecar + a real provider key.",
      "",
      "  node agent-core/scripts/live-battery.mjs",
      "",
      "Env:",
      "  ACUTE_BATTERY_KEY         REQUIRED — the provider API key (OpenRouter / NVIDIA / compatible)",
      `  ACUTE_BATTERY_BASE_URL    the provider API base (default ${PROVIDER_BASE_URL})`,
      `  ACUTE_BATTERY_MODEL       the model id (default ${MODEL})`,
      `  ACUTE_BATTERY_TOKEN       the sidecar token (default ${TOKEN})`,
      `  ACUTE_BATTERY_PORT        the sidecar port (default ${PORT})`,
      "  ACUTE_BATTERY_TIMEOUT_MS  the turn guard (default 300000)",
      "  ACUTE_BATTERY_TASK        override the task text",
      "",
      "Exit codes: 0 pass · 1 silent stop / failed assertion · 2 config (missing key/build)",
    ].join("\n"),
  );
  process.exit(0);
}
if (KEY === "") {
  console.error(
    [
      "R120-H live battery: ACUTE_BATTERY_KEY is not set — refusing to run half-live.",
      "A battery without a real provider key would end in a provider error that looks",
      "like a harness failure; set the key and re-run:",
      "",
      "  ACUTE_BATTERY_KEY=sk-... ACUTE_BATTERY_MODEL=<model> \\",
      `    ACUTE_BATTERY_BASE_URL=${PROVIDER_BASE_URL} \\`,
      "    node agent-core/scripts/live-battery.mjs",
      "",
      "(--help prints the full contract; exit 2 = config, not a silent stop)",
    ].join("\n"),
  );
  process.exit(2);
}
if (!existsSync(DIST_MAIN)) {
  console.error(`agent-core/dist/main.js is missing — run the build first (cd agent-core && pnpm build)`);
  process.exit(2);
}

/* ── S1: boot or reuse the sidecar ───────────────────────────────────────── */
let sidecar = null;
let scratch = null;
let reused = false;
async function probe() {
  try {
    const res = await fetch(`${API}/projects`, { headers: H });
    return res.status;
  } catch {
    return 0;
  }
}
{
  const status = await probe();
  if (status === 200) {
    reused = true;
    console.log(`S1  sidecar REUSED at ${BASE} (token accepted)`);
  } else {
    scratch = mkdtempSync(join(tmpdir(), "acute-r120-battery-"));
    sidecar = spawn("node", [DIST_MAIN], {
      cwd: AGENT_CORE,
      env: {
        ...process.env,
        ACUTE_TOKEN: TOKEN,
        ACUTE_DB_PATH: join(scratch, "battery.db"),
        ACUTE_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    sidecar.stdout.on("data", (d) => (log += d.toString()));
    sidecar.stderr.on("data", (d) => (log += d.toString()));
    let up = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(500);
      if ((await probe()) === 200) {
        up = true;
        break;
      }
      if (sidecar.exitCode !== null) break;
    }
    if (!up) {
      console.error(`sidecar never came up on ${PORT}\n${log.slice(-800)}`);
      process.exit(1);
    }
    console.log(`S1  sidecar BOOTED at ${BASE} (scratch DB ${scratch})`);
  }
}
const cleanup = () => {
  if (sidecar !== null) {
    try { sidecar.kill("SIGKILL"); } catch { /* gone */ }
  }
  if (scratch !== null) {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* busy */ }
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
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

/* ── S2: the world (project + provider + agent + session) ────────────────── */
let projectRoot = null;
let sessionId = null;
try {
  projectRoot = join(scratch ?? tmpdir(), `r120-battery-${Date.now()}`, "site");
  mkdirSync(projectRoot, { recursive: true });
  const project = await api("POST", "/projects", { name: `R120-battery-${Date.now()}`, rootPath: projectRoot });
  if (project.status >= 400) throw new Error(`project create failed: ${project.status} ${project.text.slice(0, 200)}`);

  // The battery provider — create-or-reuse (a re-run against a live sidecar
  // finds it standing), then ALWAYS (re)put the key so this run's key wins.
  let prov = await api("POST", "/providers", {
    id: PROVIDER_ID,
    name: "R120 Live Battery",
    baseUrl: PROVIDER_BASE_URL,
    apiFormat: "chat-completions",
    enabled: true,
  });
  if (prov.status >= 400) {
    const existing = ((await api("GET", "/providers")).json ?? {}).providers ?? [];
    if (!existing.some((p) => p.id === PROVIDER_ID)) {
      throw new Error(`provider create failed: ${prov.status} ${prov.text.slice(0, 200)}`);
    }
  }
  const keyPut = await api("PUT", `/providers/${PROVIDER_ID}/key`, { value: KEY });
  if (keyPut.status >= 400) throw new Error(`provider key put failed: ${keyPut.status} ${keyPut.text.slice(0, 200)}`);

  const agent = await api("POST", "/agents", {
    name: "R120 Live Battery Agent",
    systemPrompt: "You are a helpful coding agent. Complete the user's task with real tool calls, then give a short final answer.",
    providerId: PROVIDER_ID,
    model: MODEL,
    temperature: 0.2,
    maxTurns: 8,
  });
  if (agent.status >= 400 || !agent.json?.id) throw new Error(`agent create failed: ${agent.status} ${agent.text.slice(0, 200)}`);
  const session = await api("POST", "/sessions", { agentId: agent.json.id, mode: "single", title: "R120 live battery", projectId: project.json?.id });
  if (session.status >= 400 || !session.json?.id) throw new Error(`session create failed: ${session.status} ${session.text.slice(0, 200)}`);
  sessionId = session.json.id;
  console.log(`S2  world ready — provider ${PROVIDER_ID} (${PROVIDER_BASE_URL}) · model ${MODEL} · session ${sessionId}`);
  console.log(`    task: ${TASK}`);

  /* ── S3: the streamed turn (SSE with arrival timestamps) ──────────────── */
  const startedAt = Date.now();
  const frames = [];
  const times = [];
  const toolCalls = [];
  let text = "";
  const readerAbort = new AbortController();
  const guard = setTimeout(() => readerAbort.abort(), TURN_TIMEOUT_MS, "timeout");
  let readerError = null;
  const res = await fetch(`${API}/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ content: TASK, thinkingLevel: "default" }),
    signal: readerAbort.signal,
  }).catch((err) => {
    readerError = String(err?.message ?? err);
    return null;
  });
  if (res !== null && res.status !== 200) {
    const body = await res.text().catch(() => "");
    readerError = `stream POST answered ${res.status}: ${body.slice(0, 200)}`;
  }
  if (res !== null && res.status === 200) {
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
            let frame = null;
            try { frame = JSON.parse(line.slice(6)); } catch { /* partial */ }
            if (frame === null) continue;
            frames.push(frame);
            times.push(Date.now());
            const rel = times[times.length - 1] - startedAt;
            if (frame.type === "text-delta" && typeof frame.delta === "string") text += frame.delta;
            if (frame.type === "tool-call") toolCalls.push(`${frame.toolName}(${frame.argsSummary ?? ""})`);
            const note =
              frame.type === "text-delta" ? "" :
              frame.type === "tool-call" ? ` ${frame.toolName}(${frame.argsSummary ?? ""})` :
              frame.type === "tool-result" ? ` ${frame.toolName} ok=${frame.ok}` :
              frame.type === "error" ? ` ${frame.code} ${String(frame.message ?? "").slice(0, 120)}` :
              frame.type === "done" ? " (terminal)" :
              frame.type === "stopped" ? " (terminal)" :
              "";
            console.log(`    +${String(rel).padStart(6)}ms  ${frame.type}${note}`);
          }
        }
      }
    } catch (err) {
      if (readerAbort.signal.aborted === true) readerError = `turn guard fired at ${TURN_TIMEOUT_MS}ms`;
      else readerError = String(err?.message ?? err);
    }
  }
  clearTimeout(guard);
  const turnMs = Date.now() - startedAt;

  // A timeout with no terminal frame: best-effort stop so nothing keeps burning.
  const terminal = frames.find((f) => f.type === "done" || f.type === "error" || f.type === "stopped") ?? null;
  if (terminal === null && readerError !== null && readerError.startsWith("turn guard")) {
    await api("POST", `/sessions/${sessionId}/stop`, {}).catch(() => undefined);
  }

  /* ── S4: the verdict ───────────────────────────────────────────────────── */
  const firstTextIdx = frames.findIndex((f) => f.type === "text-delta");
  const ttft = firstTextIdx >= 0 ? times[firstTextIdx] - startedAt : -1;
  let ended;
  let exitPath;
  if (terminal?.type === "done") {
    ended = "done";
    exitPath = text.trim() !== "" || toolCalls.length > 0 ? "final answer" : "SILENT STOP (done over zero text + zero tools)";
  } else if (terminal?.type === "error") {
    ended = "error";
    exitPath = `surfaced error (${terminal.code ?? "?"})`;
  } else if (terminal?.type === "stopped") {
    ended = "stopped";
    exitPath = "user abort (labeled)";
  } else {
    ended = readerError !== null ? "stream broken" : "stream closed";
    exitPath = `SILENT STOP (no terminal frame${readerError !== null ? ` — ${readerError}` : ""})`;
  }
  const fileRel = "notes/a.txt";
  const fileAbs = join(projectRoot, fileRel);
  let fileVerdict = "MISSING";
  if (existsSync(fileAbs)) {
    const bytes = readFileSync(fileAbs, "utf8");
    fileVerdict = bytes.includes("hello") ? `ok (${JSON.stringify(bytes.trim().slice(0, 60))})` : `WRONG CONTENT (${JSON.stringify(bytes.slice(0, 60))})`;
  }
  const answerOk = text.trim() !== "" && /hello/i.test(text);
  const toolLine = toolCalls.length > 0 ? toolCalls.join(" · ") : "(none)";
  const frameCounts = frames.reduce((acc, f) => {
    acc[f.type] = (acc[f.type] ?? 0) + 1;
    return acc;
  }, {});
  const frameLine = Object.entries(frameCounts).map(([t, n]) => `${t}×${n}`).join(" ") || "(none)";

  const silent = exitPath.startsWith("SILENT STOP");
  const pass =
    !silent && terminal?.type === "done" && answerOk && fileVerdict.startsWith("ok");
  const rows = [
    ["task", TASK],
    ["model", `${MODEL} via ${PROVIDER_BASE_URL}`],
    ["sidecar", `${reused ? "reused" : "booted"} ${BASE} · session ${sessionId}`],
    ["turn ended", ended],
    ["exit path", exitPath],
    ["tool calls", toolLine],
    ["frames", frameLine],
    ["ttft / turn", `${ttft >= 0 ? `${ttft}ms` : "—"} / ${turnMs}ms`],
    ["file on disk", `${fileRel}: ${fileVerdict}`],
    ["final answer", answerOk ? `ok — “…${text.trim().slice(-80)}”` : `FAILED — ${text.trim() === "" ? "(no text)" : `“${text.trim().slice(0, 120)}”`}`],
    ["VERDICT", pass ? "PASS — the turn ended on a real final answer" : silent ? "FAIL — SILENT STOP" : "FAIL — the task did not complete honestly"],
  ];
  console.log("\n┌─ R120-H LIVE BATTERY VERDICT " + "─".repeat(40));
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  for (const [label, value] of rows) {
    console.log(`│ ${label.padEnd(labelWidth)}  ${value}`);
  }
  console.log("└" + "─".repeat(labelWidth + 42));
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.error(`battery crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
} finally {
  cleanup();
}
