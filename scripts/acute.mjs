#!/usr/bin/env node
/**
 * ACUTE-CODE dev CLI (owner round-8): quick, scriptable access to the local
 * agent core so the agent (or the owner) can test the system from a terminal
 * without curl acrobatics. Talks to the dev sidecar (pnpm dev:full) at
 * 127.0.0.1:5178 with the loopback dev token — no secrets involved.
 *
 * Usage: node scripts/acute.mjs <command> [args]
 *   health                          sidecar health + version
 *   providers                       provider rows (hasKey flags, no keys)
 *   models <providerId> [filter]    model catalog (optional substring filter)
 *   test <providerId> [model]       REAL connection probe (key + model)
 *   agents [--all]                  agent registry (templates with --all)
 *   sessions                        recent sessions
 *   usage [days]                    usage summary (default 14 days)
 *   raw <METHOD> <path> [jsonBody]  authenticated raw request (escape hatch)
 */
const BASE = process.env.ACUTE_BASE_URL ?? "http://127.0.0.1:5178";
const TOKEN = process.env.ACUTE_TOKEN ?? "acute-dev-local";

async function call(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function die(msg) {
  console.error(String(msg));
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "health": {
    const res = await fetch(`${BASE}/health`);
    console.log(res.status, JSON.stringify(await res.json()));
    break;
  }
  case "providers": {
    const { status, json } = await call("GET", "/providers");
    if (status !== 200) die(JSON.stringify(json));
    for (const p of json.providers) {
      console.log(
        `${p.hasKey ? "●" : "○"} ${p.id.padEnd(16)} ${p.name.padEnd(14)} ${p.baseUrl ?? ""}`,
      );
    }
    break;
  }
  case "models": {
    const [providerId, filter] = args;
    if (!providerId) die("usage: models <providerId> [filter]");
    const { status, json } = await call("GET", `/providers/${providerId}/models`);
    if (status !== 200) die(JSON.stringify(json));
    const models = filter
      ? json.models.filter((m) => m.id.toLowerCase().includes(filter.toLowerCase()))
      : json.models;
    console.log(`${models.length} models${json.cached ? " (cached)" : ""}`);
    for (const m of models) console.log(`  ${m.id}${m.name ? `  — ${m.name}` : ""}`);
    break;
  }
  case "test": {
    const [providerId, model] = args;
    if (!providerId) die("usage: test <providerId> [model]");
    const { status, json } = await call("POST", `/providers/${providerId}/test`, model ? { model } : {});
    console.log(status, JSON.stringify(json, null, 1));
    if (typeof json === "object" && json.ok === false) process.exitCode = 2;
    break;
  }
  case "agents": {
    const includeAll = args.includes("--all");
    const { status, json } = await call("GET", `/agents${includeAll ? "" : "?includeTemplates=false"}`);
    if (status !== 200) die(JSON.stringify(json));
    for (const a of json.agents) {
      console.log(`${a.id.padEnd(16)} ${a.name.padEnd(16)} ${a.role ?? ""} ${a.modelId ?? ""}`);
    }
    break;
  }
  case "sessions": {
    const { status, json } = await call("GET", "/sessions");
    if (status !== 200) die(JSON.stringify(json));
    for (const s of json.sessions) {
      console.log(`${s.id.slice(0, 10)}  ${String(s.title ?? "").padEnd(28)} ${s.status} ${s.mode}`);
    }
    break;
  }
  case "usage": {
    const days = args[0] ?? "14";
    const { status, json } = await call("GET", `/usage/summary?days=${days}`);
    if (status !== 200) die(JSON.stringify(json));
    console.log(JSON.stringify(json, null, 1));
    break;
  }
  case "raw": {
    const [method, path, body] = args;
    if (!method || !path) die("usage: raw <METHOD> <path> [jsonBody]");
    const { status, json } = await call(method, path, body ? JSON.parse(body) : undefined);
    console.log(status, JSON.stringify(json, null, 1));
    break;
  }
  default:
    die("unknown command — see the usage header in scripts/acute.mjs");
}
