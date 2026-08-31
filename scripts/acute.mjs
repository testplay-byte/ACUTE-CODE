#!/usr/bin/env node
/**
 * ACUTE-CODE dev CLI (owner round-8; R58: terminal chat harness): quick,
 * scriptable access to the local agent core so the agent (or the owner) can
 * test the system from a terminal without curl acrobatics. Talks to the dev
 * sidecar (pnpm dev:full) at 127.0.0.1:5178 with the loopback dev token — no
 * secrets involved.
 *
 * Usage: node scripts/acute.mjs <command> [args]
 *   health                          sidecar health + version
 *   providers                       provider rows (hasKey flags, no keys)
 *   models <providerId> [filter]    model catalog (optional substring filter)
 *   test <providerId> [model]       REAL connection probe (key + model)
 *   agents [--all]                  agent registry (templates with --all)
 *   sessions                        recent sessions
 *   usage [days]                    usage summary (default 14 days)
 *   raw <METHOD> <path> [jsonBody]  authenticated raw request (escape hatch;
 *                                   status -> stderr, JSON body -> stdout)
 *
 * Chat harness (R58 — drive real agent sessions from the terminal, no UI):
 *   chat:new [--agent <id>] [--project <id>] [--title "T"]
 *                                   create a session (202; session JSON ->
 *                                   stdout, status line -> stderr; --agent
 *                                   defaults to the first registry agent)
 *   chat:sessions [--project <id>] [--limit N]
 *                                   compact list: id, title, status, updatedAt
 *   chat <sessionId> <message...>   SYNC whole turn: assistant reply on
 *         [--model <id>]            stdout, usage line on stderr (--json for
 *         [--thinking L]            the raw response). Thinking levels are
 *         [--json]                  default|low|high|max (the sidecar's set).
 *   chat:stream <sessionId> <message...>
 *                                   LIVE SSE turn: text deltas stream to
 *         [--model <id>]            stdout, thinking as an overwritten
 *         [--thinking L]            one-line stderr status, tool calls as
 *         [--quiet]                 "[tool] name(args) … ok" lines with live
 *         [--raw]                   tool-output, a final usage summary line.
 *         [--auto-approve]          --quiet: text only; --raw: every frame as
 *                                   JSON lines; --auto-approve: decide
 *                                   approval.requested frames "approved".
 *                                   SIGINT -> POST /sessions/:id/stop, waits
 *                                   for the stopped/done frame, exit 0.
 *   chat:stop <sessionId>           POST /sessions/:id/stop
 *   chat:events <sessionId> [--limit 40]
 *                                   compact tail of the session event log
 *   chat:ctx <sessionId>            context-window usage (tokens, %)
 *   approvals [--status S]          approval rows (pending by default)
 *   approve <id> | deny <id>        decide a pending approval
 *
 * Env: ACUTE_BASE_URL (default http://127.0.0.1:5178), ACUTE_TOKEN (default
 * acute-dev-local), NO_COLOR (disable the chat harness's ANSI colors).
 * See docs/runbooks/CLI-HARNESS.md for the long-session recipes.
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

// ── R58 chat harness helpers ────────────────────────────────────────────────
// Minimal ANSI (no deps): only the chat commands colorize; the legacy
// commands stay plain. NO_COLOR or a non-TTY stdout disables everything.

const USE_COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const ansi = (open, close) => (s) => (USE_COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const bold = ansi(1, 22);
const dim = ansi(2, 22);
const red = ansi(31, 39);
const green = ansi(32, 39);
const yellow = ansi(33, 39);
const cyan = ansi(36, 39);

/** One-line error for the API's {error:{code,message}} envelope (401/404/409…). */
function fail(status, json) {
  const envelope =
    json !== null && typeof json === "object" && !Array.isArray(json) ? json.error : undefined;
  const code =
    envelope !== undefined && typeof envelope.code === "string" ? envelope.code : `HTTP_${status}`;
  const message =
    envelope !== undefined && typeof envelope.message === "string"
      ? envelope.message
      : typeof json === "string"
        ? trunc(json, 200)
        : JSON.stringify(json);
  die(`${red(`${status} ${code}`)}: ${message}`);
}

/** call() with a clear message when the sidecar is unreachable. */
async function callChecked(method, path, body) {
  try {
    return await call(method, path, body);
  } catch (err) {
    die(`${red("unreachable")} ${BASE} — ${errCause(err)} (is the sidecar running?)`);
  }
}

function errCause(err) {
  if (err instanceof Error) {
    const cause = err.cause;
    if (cause !== undefined && cause !== null) {
      const detail = cause.code ?? cause.message;
      if (detail !== undefined && detail !== null) return String(detail);
    }
    return err.message;
  }
  return String(err);
}

function trunc(value, max) {
  const str = String(value ?? "");
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

/** Split argv into `--flag value` pairs (value = next non-flag arg) and
 * positionals; bare flags become `true`. `--` pushes the rest positional. */
function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[token.slice(2)] = next;
        i++;
      } else {
        flags[token.slice(2)] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function flagStr(flags, name) {
  const value = flags[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The sidecar's ThinkingLevel set (shared/src THINKING_LEVELS) — there is no
 * "medium"; validating client-side avoids a wasted 400 turn. */
const THINKING_LEVELS = ["default", "low", "high", "max"];

function thinkingFlag(flags) {
  const value = flagStr(flags, "thinking");
  if (value === undefined) return undefined;
  if (!THINKING_LEVELS.includes(value)) {
    die(`--thinking must be one of ${THINKING_LEVELS.join("|")} (the sidecar accepts no "medium")`);
  }
  return value === "default" ? undefined : value;
}

/** "model · N in · N out · $cost" from a UsageRecord (sync route / done frame)
 * or a finish frame's {inputTokens,outputTokens}. */
function usageLine(usage) {
  if (usage === null || typeof usage !== "object") return "";
  const parts = [];
  if (typeof usage.model === "string" && usage.model !== "") parts.push(usage.model);
  if (typeof usage.inputTokens === "number") parts.push(`${usage.inputTokens} in`);
  if (typeof usage.outputTokens === "number") parts.push(`${usage.outputTokens} out`);
  if (typeof usage.costUsd === "number" && usage.costUsd > 0) parts.push(`$${usage.costUsd}`);
  return parts.join(" · ");
}

/** POST /sessions/:id/messages/stream rendered LIVE to the terminal.
 * Terminal frames (done|stopped|error) decide the exit code; SIGINT posts the
 * stop route and waits for the terminal frame before exiting. */
async function runStreamedTurn(sessionId, content, flags) {
  const quiet = flags.quiet === true;
  const rawMode = flags.raw === true;
  const autoApprove = flags["auto-approve"] === true;
  const body = { content };
  const model = flagStr(flags, "model");
  const thinking = thinkingFlag(flags);
  if (model !== undefined) body.model = model;
  if (thinking !== undefined) body.thinkingLevel = thinking;

  // SIGINT (Ctrl-C): POST /sessions/:id/stop, then keep reading — the server
  // aborts the turn and flushes a {type:"stopped"} frame; exit 0 on it. A
  // second SIGINT exits immediately (130) like a normal CLI.
  const errOut = (s) => process.stderr.write(s);
  const out = (s) => process.stdout.write(s);
  let sigints = 0;
  let giveUpTimer = null;
  const onSigint = () => {
    sigints++;
    if (sigints > 1) {
      errOut("\n" + red("— second SIGINT — exiting now") + "\n");
      process.exit(130);
    }
    errOut("\n" + yellow(`— SIGINT — POSTing /sessions/${sessionId}/stop …`) + "\n");
    call("POST", `/sessions/${sessionId}/stop`)
      .then(({ status, json }) => {
        errOut(dim(`stop -> ${status} ${JSON.stringify(json)}`) + "\n");
      })
      .catch((err) => {
        errOut(red(`stop POST failed: ${errCause(err)}`) + "\n");
      });
    // If no terminal frame lands within 10s of the stop, give up honestly.
    giveUpTimer = setTimeout(() => {
      errOut(red("— no stopped/done frame within 10s of the stop POST — exiting") + "\n");
      process.exit(1);
    }, 10_000);
    giveUpTimer.unref();
  };
  process.on("SIGINT", onSigint);

  let res;
  try {
    res = await fetch(`${BASE}/api/v1/sessions/${sessionId}/messages/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    process.off("SIGINT", onSigint);
    die(`${red("unreachable")} ${BASE} — ${errCause(err)} (is the sidecar running?)`);
  }
  if (!res.ok || !res.body) {
    process.off("SIGINT", onSigint);
    // Non-2xx: the error envelope is JSON, not SSE (same contract as the UI).
    const text = await res.text().catch(() => "");
    let json = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep the raw body */
    }
    fail(res.status, json);
  }

  // ── live render state ──
  const interactiveErr = process.stderr.isTTY === true; // \r status lines need a TTY
  let thinkingChars = 0;
  let thinkingLine = false; // an overwritten "thinking…" status sits on stderr
  let needNl = false; // stdout ended mid-line (text deltas) — newline first
  let finishUsage = null; // finish frame's usage, the done-frame fallback
  const clearThinking = () => {
    if (thinkingLine) {
      errOut("\r\x1b[2K");
      thinkingLine = false;
    }
  };
  const startLine = () => {
    clearThinking();
    if (needNl) {
      out("\n");
      needNl = false;
    }
  };

  const decideAuto = (approvalId) => {
    callChecked("POST", `/approvals/${approvalId}/decision`, { decision: "approved" })
      .then(({ status, json }) => {
        if (status === 200) {
          errOut(green(`  auto-approved ${approvalId}`) + "\n");
        } else {
          errOut(red(`  auto-approve failed: ${status} ${JSON.stringify(json)}`) + "\n");
        }
      })
      .catch((err) => {
        errOut(red(`  auto-approve failed: ${errCause(err)}`) + "\n");
      });
  };

  const renderFrame = (ev) => {
    switch (ev.type) {
      case "text-delta": {
        // battery/panel contract: `delta` live, `text` for step snapshots.
        const delta =
          typeof ev.delta === "string" ? ev.delta : typeof ev.text === "string" ? ev.text : "";
        if (delta === "") break;
        clearThinking();
        out(delta);
        needNl = !delta.endsWith("\n");
        break;
      }
      case "thinking-delta": {
        thinkingChars += typeof ev.delta === "string" ? ev.delta.length : 0;
        if (quiet || !interactiveErr) break;
        // Collapsed one-line status, overwritten in place (padded to clear).
        errOut(`\r${dim(`thinking… (${thinkingChars} chars)`).padEnd(48)}`);
        thinkingLine = true;
        break;
      }
      case "tool-call": {
        if (quiet) break;
        startLine();
        out(`${cyan("[tool]")} ${ev.toolName}(${ev.argsSummary ?? ""}) …`);
        break;
      }
      case "tool-output": {
        if (quiet) break; // live chunks under the active tool line
        if (typeof ev.chunk === "string") out(ev.chunk);
        break;
      }
      case "tool-result": {
        if (quiet) break;
        out(` ${ev.ok === false ? red("FAIL") : green("ok")}\n`);
        if (typeof ev.outputSummary === "string" && ev.outputSummary !== "") {
          out(`${dim(`      ${trunc(ev.outputSummary, 140)}`)}\n`);
        }
        break;
      }
      case "meta.continuation": {
        if (quiet) break;
        startLine();
        out(
          dim(`— continuing (iteration ${ev.iteration}${typeof ev.reason === "string" ? ` · ${ev.reason}` : ""})`) +
            "\n",
        );
        break;
      }
      case "subagent-status": {
        if (quiet) break;
        startLine();
        out(dim(`— subagent ${ev.code ?? "?"} ${ev.status}: ${trunc(ev.task ?? "", 70)}`) + "\n");
        break;
      }
      case "approval.requested": {
        startLine();
        errOut("\n" + yellow(bold("── approval requested ──")) + "\n");
        errOut(`${yellow(`${ev.toolName}(${ev.argsSummary ?? ""})`)}\n`);
        errOut(`  category ${ev.category ?? "?"} · approval id ${bold(ev.approvalId ?? "?")}\n`);
        if (autoApprove) {
          errOut(dim("  --auto-approve: deciding approved …") + "\n");
          if (typeof ev.approvalId === "string") decideAuto(ev.approvalId);
        } else {
          errOut(
            `  decide in another terminal: ${bold(`node scripts/acute.mjs approve ${ev.approvalId ?? "<id>"}`)}\n`,
          );
          errOut(dim("  the stream stays open until the approval resolves\n"));
        }
        break;
      }
      case "approval.resolved": {
        startLine();
        errOut(
          dim(
            `— approval ${ev.approvalId ?? "?"} ${ev.decision ?? "?"}` +
              `${typeof ev.remember === "string" ? ` (remember ${ev.remember})` : ""}`,
          ) + "\n",
        );
        break;
      }
      case "finish": {
        finishUsage = ev.usage ?? null;
        break;
      }
      case "done": {
        startLine();
        const line = usageLine(ev.usage ?? finishUsage);
        out(`${dim(line === "" ? "— done" : `— done · ${line}`)}\n`);
        break;
      }
      case "stopped": {
        startLine();
        out(`${dim("— stopped by user")}\n`);
        break;
      }
      case "error": {
        startLine();
        errOut(
          red(`stream error ${typeof ev.code === "string" ? `${ev.code}: ` : ""}${ev.message ?? ""}`) + "\n",
        );
        break;
      }
      default:
        break; // subagent-event inner frames + future types: ignored
    }
  };

  const handle = (ev) => {
    if (rawMode) out(JSON.stringify(ev) + "\n");
    else renderFrame(ev);
    if (ev.type === "done" || ev.type === "stopped") return 0;
    if (ev.type === "error") return 1;
    return undefined;
  };

  // SSE reader loop (same partial-chunk buffering as src/lib/api.ts: split on
  // blank lines, parse each `data: ` line, tolerate malformed frames).
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let exitCode;
  readLoop: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue; // skip malformed frame
        }
        const code = handle(ev);
        if (code !== undefined) {
          exitCode = code;
          break readLoop;
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
  process.off("SIGINT", onSigint);
  if (giveUpTimer !== null) clearTimeout(giveUpTimer);
  await reader.cancel().catch(() => {});
  if (exitCode === undefined) {
    // A well-formed stream ALWAYS ends with done|error|stopped (R43 rule).
    startLine();
    errOut(
      "\n" + red("stream ended without a terminal frame — the sidecar died or the connection dropped") + "\n",
    );
    exitCode = 1;
  }
  process.exitCode = exitCode;
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
      console.log(
        `${a.id.padEnd(16)} ${a.name.padEnd(16)} ${a.role ?? ""} ${a.providerId ?? ""} ${a.model ?? ""}`,
      );
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
    // Pipe-safe (owner round-10 fix): the HTTP status goes to STDERR so the
    // JSON body on stdout can be piped straight into jq without post-processing.
    const [method, path, body] = args;
    if (!method || !path) die("usage: raw <METHOD> <path> [jsonBody]");
    const { status, json } = await call(method, path, body ? JSON.parse(body) : undefined);
    console.error(`${status} ${BASE}/api/v1${path}`);
    console.log(JSON.stringify(json, null, 1));
    break;
  }

  // ── R58 chat harness ─────────────────────────────────────────────────────
  case "chat:new": {
    const { flags } = parseArgs(args);
    let agentId = flagStr(flags, "agent");
    if (agentId === undefined) {
      const { status, json } = await callChecked("GET", "/agents?includeTemplates=false");
      if (status !== 200) fail(status, json);
      const list = Array.isArray(json.agents) ? json.agents : [];
      if (list.length === 0) die("no agents in the registry — pass --agent <id> (see: agents)");
      agentId = list[0].id;
      console.error(dim(`(no --agent given — using the first agent: ${list[0].name} ${agentId})`));
    }
    const body = { mode: "single", agentId };
    const project = flagStr(flags, "project");
    const title = flagStr(flags, "title");
    if (project !== undefined) body.projectId = project;
    if (title !== undefined) body.title = title;
    // Pipe-safe like `raw`: status -> stderr, session JSON -> stdout.
    const { status, json } = await callChecked("POST", "/sessions", body);
    if (status !== 202) fail(status, json);
    console.error(`${status} ${BASE}/api/v1/sessions — ${json.id}`);
    console.log(JSON.stringify(json, null, 1));
    break;
  }
  case "chat:sessions": {
    const { flags } = parseArgs(args);
    const limitRaw = Number(flagStr(flags, "limit") ?? 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 20;
    const { status, json } = await callChecked("GET", `/sessions?limit=${limit}`);
    if (status !== 200) fail(status, json);
    let list = Array.isArray(json.sessions) ? json.sessions : [];
    const project = flagStr(flags, "project");
    if (project !== undefined) list = list.filter((s) => s.projectId === project);
    console.log(`${list.length} session(s)${project !== undefined ? ` · project ${project}` : ""}`);
    for (const s of list) {
      console.log(
        `${s.id}  ${trunc(s.title ?? "(untitled)", 32).padEnd(32)}  ${String(s.status).padEnd(9)}  ${s.updatedAt}`,
      );
    }
    break;
  }
  case "chat": {
    const { flags, positionals } = parseArgs(args);
    const [sessionId, ...words] = positionals;
    const content = words.join(" ");
    if (!sessionId || content.trim() === "") {
      die("usage: chat <sessionId> <message> [--model <id>] [--thinking default|low|high|max] [--json]");
    }
    const body = { content };
    const model = flagStr(flags, "model");
    const thinking = thinkingFlag(flags);
    if (model !== undefined) body.model = model;
    if (thinking !== undefined) body.thinkingLevel = thinking;
    const { status, json } = await callChecked("POST", `/sessions/${sessionId}/messages`, body);
    if (status !== 200) fail(status, json);
    if (flags.json === true) {
      console.log(JSON.stringify(json, null, 1));
      break;
    }
    // Pipe-safe: the reply on stdout, the usage line on stderr.
    const text = typeof json.assistantMessage?.content === "string" ? json.assistantMessage.content : "";
    if (text !== "") console.log(text);
    const line = usageLine(json.usage);
    if (line !== "") console.error(dim(`— ${line}`));
    break;
  }
  case "chat:stream": {
    const { flags, positionals } = parseArgs(args);
    const [sessionId, ...words] = positionals;
    const content = words.join(" ");
    if (!sessionId || content.trim() === "") {
      die(
        "usage: chat:stream <sessionId> <message> [--model <id>] [--thinking default|low|high|max] " +
          "[--quiet] [--raw] [--auto-approve]",
      );
    }
    await runStreamedTurn(sessionId, content, flags);
    break;
  }
  case "chat:stop": {
    const { positionals } = parseArgs(args);
    const sessionId = positionals[0];
    if (!sessionId) die("usage: chat:stop <sessionId>");
    const { status, json } = await callChecked("POST", `/sessions/${sessionId}/stop`);
    if (status !== 200) fail(status, json);
    console.log(
      json.stopped === true
        ? `stop ${sessionId} — live turn aborted`
        : `stop ${sessionId} — no live turn (nothing to stop)`,
    );
    break;
  }
  case "chat:events": {
    const { flags, positionals } = parseArgs(args);
    const sessionId = positionals[0];
    if (!sessionId) die("usage: chat:events <sessionId> [--limit 40]");
    const limitRaw = Number(flagStr(flags, "limit") ?? 40);
    const limit = Number.isFinite(limitRaw) ? Math.max(Math.trunc(limitRaw), 1) : 40;
    const { status, json } = await callChecked("GET", `/sessions/${sessionId}`);
    if (status !== 200) fail(status, json);
    const events = Array.isArray(json.events) ? json.events : [];
    const tail = events.slice(-limit);
    console.error(
      dim(`${json.id} · ${json.title ?? "(untitled)"} · ${json.status} · ${events.length} events (showing last ${tail.length})`),
    );
    for (const e of tail) {
      console.log(`${String(e.seq).padStart(4)}  ${String(e.type).padEnd(18)} ${shortPayload(e)}`);
    }
    break;
  }
  case "chat:ctx": {
    const { positionals } = parseArgs(args);
    const sessionId = positionals[0];
    if (!sessionId) die("usage: chat:ctx <sessionId>");
    const { status, json } = await callChecked("GET", `/sessions/${sessionId}/context`);
    if (status !== 200) fail(status, json);
    const windowTokens = typeof json.contextWindow === "number" ? json.contextWindow : 0;
    const used = typeof json.usedTokens === "number" ? json.usedTokens : 0;
    const pct = windowTokens > 0 ? `${((used / windowTokens) * 100).toFixed(1)}%` : "?";
    console.log(`${json.model} (${json.providerId}) · window ${windowTokens.toLocaleString()} tokens`);
    console.log(`used ${used.toLocaleString()} (${pct} of window)`);
    const b = json.breakdown ?? {};
    console.log(
      dim(
        `  system ${b.systemPrompt ?? 0} · tools ${b.systemTools ?? 0} · memory ${b.memory ?? 0} · ` +
          `messages ${b.messages ?? 0} · meta ${b.meta ?? 0} · mcp ${b.mcpTools ?? 0}`,
      ),
    );
    const t = json.sessionTotals ?? {};
    console.log(
      dim(
        `  session: ${t.requests ?? 0} requests · ${t.inputTokens ?? 0} in · ${t.outputTokens ?? 0} out · $${t.costUsd ?? 0}`,
      ),
    );
    const u = json.usage;
    if (u !== null && typeof u === "object" && u.subagents !== undefined) {
      console.log(
        dim(
          `  sub-agents: ${u.subagents.requests ?? 0} requests · ${u.subagents.inputTokens ?? 0} in · ` +
            `${u.subagents.outputTokens ?? 0} out · $${u.subagents.costUsd ?? 0}`,
        ),
      );
      console.log(
        dim(
          `  combined: ${u.combined.requests ?? 0} requests · ${u.combined.inputTokens ?? 0} in · ` +
            `${u.combined.outputTokens ?? 0} out`,
        ),
      );
    }
    break;
  }
  case "approvals": {
    const { flags } = parseArgs(args);
    const statusFilter = flagStr(flags, "status") ?? "pending";
    const { status, json } = await callChecked(
      "GET",
      `/approvals?status=${encodeURIComponent(statusFilter)}`,
    );
    if (status !== 200) fail(status, json);
    const list = Array.isArray(json.approvals) ? json.approvals : [];
    if (list.length === 0) {
      console.log(`no ${statusFilter} approvals`);
      break;
    }
    for (const a of list) {
      console.log(
        `${a.id}  ${String(a.status).padEnd(9)} ${String(a.category).padEnd(12)} ${trunc(a.toolCall, 60)}  ${a.createdAt}`,
      );
    }
    break;
  }
  case "approve":
  case "deny": {
    const { positionals } = parseArgs(args);
    const id = positionals[0];
    if (!id) die(`usage: ${cmd} <approvalId>`);
    const { status, json } = await callChecked("POST", `/approvals/${id}/decision`, {
      decision: cmd === "approve" ? "approved" : "denied",
    });
    if (status !== 200) fail(status, json);
    console.log(
      `${cmd === "approve" ? green("approved") : red("denied")} ${id}` +
        `${json.remember ? dim(` (remember ${json.remember})`) : ""}`,
    );
    break;
  }
  default:
    die("unknown command — see the usage header in scripts/acute.mjs");
}

/** Compact one-line payload for chat:events rows. */
function shortPayload(e) {
  const p = e.payload;
  if (p !== null && typeof p === "object") {
    if (typeof p.content === "string") return trunc(p.content.replace(/\s+/g, " "), 90);
    if (typeof p.toolName === "string") {
      return `${p.toolName}(${p.argsSummary ?? ""}) ${p.ok === false ? "FAIL" : "ok"}`;
    }
    if (typeof p.message === "string") {
      return trunc(`${typeof p.code === "string" ? `${p.code}: ` : ""}${p.message}`, 90);
    }
  }
  return trunc(JSON.stringify(p), 90);
}
