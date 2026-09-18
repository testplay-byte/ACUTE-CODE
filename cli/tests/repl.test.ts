/**
 * ROUND-107 (R107-c-impl, F5): the REPL's slash re-prompt — every COMPLETED
 * slash command (success AND error) must re-render `acute> `. Before the
 * fix only the error path re-prompted, so users typed blind after any
 * successful /help, /model, /sessions, …
 *
 * The readline streams are injected (PassThrough pairs); the session
 * bootstrap rides a stubbed fetch (agents + POST /sessions). /help needs no
 * fetch at all — the cleanest success-path probe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { colorKitFor } from "../src/color.js";
import type { Connection } from "../src/connection.js";
import type { CliContext } from "../src/context.js";
import { runRepl } from "../src/commands/repl.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PLAIN_KIT = colorKitFor(false, {});

const CONN: Connection = {
  baseUrl: "http://127.0.0.1:4604",
  token: "repl-token",
  source: "env",
  ownsSidecar: false,
  portalFile: null,
  port: 4604,
  spawned: null,
};

/** The REPL's session bootstrap: GET /agents + POST /sessions. */
function stubBootstrap(): void {
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (String(url).includes("/api/v1/agents")) {
        return new Response(
          JSON.stringify({
            agents: [
              {
                id: "a1",
                name: "default",
                role: "worker",
                providerId: null,
                model: null,
                isTemplate: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith("/api/v1/sessions") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "s1",
            projectId: null,
            agentId: "a1",
            mode: "single",
            status: "idle",
            title: null,
            createdAt: "2026-09-18T00:00:00.000Z",
            updatedAt: "2026-09-18T00:00:00.000Z",
          }),
          { status: 202 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  );
}

/** A REPL harness over PassThrough streams — write() feeds stdin lines,
 * end() is the Ctrl-D EOF, output accumulates the prompt stream verbatim. */
async function makeRepl(): Promise<{
  write: (line: string) => void;
  end: () => void;
  outputText: () => string;
  repl: Promise<number>;
  errText: () => string;
}> {
  stubBootstrap();
  const input = new PassThrough();
  const output = new PassThrough();
  let err = "";
  const ctx: CliContext = {
    stdout: () => {},
    stderr: (s) => {
      err += s;
    },
    kit: PLAIN_KIT,
    plain: true,
    quiet: false,
    json: false,
    autoApprove: false,
    config: {},
    flags: {},
    repoRoot: "/repo",
    conn: CONN,
  };
  const repl = runRepl(ctx, { input, output });
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  // wait for the FIRST prompt before returning (the REPL is live)
  await vi.waitFor(() => expect(text).toContain("acute> "));
  return {
    write: (line: string) => {
      input.write(`${line}\n`);
    },
    end: () => {
      input.end();
    },
    outputText: () => text,
    repl,
    errText: () => err,
  };
}

describe("the REPL slash-command re-prompt (F5)", () => {
  it("a SUCCESSFUL /help re-prompts — the prompt appears twice before /exit", async () => {
    const h = await makeRepl();
    h.write("/help");
    await vi.waitFor(() => {
      // initial prompt + the post-slash re-prompt (F5: success re-prompts)
      expect(h.outputText().split("acute> ").length - 1).toBeGreaterThanOrEqual(2);
    });
    expect(h.errText()).toContain("/model [id]");
    h.write("/exit");
    expect(await h.repl).toBe(0);
  });

  it("an UNKNOWN slash command still errors AND re-prompts (the old behavior kept)", async () => {
    const h = await makeRepl();
    h.write("/bogus");
    await vi.waitFor(() => expect(h.errText()).toContain("unknown slash command: /bogus"));
    await vi.waitFor(() => {
      expect(h.outputText().split("acute> ").length - 1).toBeGreaterThanOrEqual(2);
    });
    h.write("/exit");
    expect(await h.repl).toBe(0);
  });

  it("a FAILING slash command (dead sidecar) prints the error and re-prompts", async () => {
    const h = await makeRepl();
    // /sessions hits GET /sessions — replace the stub with a dead one
    vi.stubGlobal(
      "fetch",
      async (): Promise<Response> => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      },
    );
    h.write("/sessions");
    await vi.waitFor(() => expect(h.errText()).toContain("unreachable http://127.0.0.1:4604"));
    await vi.waitFor(() => {
      expect(h.outputText().split("acute> ").length - 1).toBeGreaterThanOrEqual(2);
    });
    h.write("/exit");
    expect(await h.repl).toBe(0);
  });

  it("EOF (Ctrl-D) after a successful slash command still exits cleanly", async () => {
    const h = await makeRepl();
    h.write("/help");
    await vi.waitFor(() => {
      expect(h.outputText().split("acute> ").length - 1).toBeGreaterThanOrEqual(2);
    });
    await vi.waitFor(() => expect(h.errText()).toContain("/model [id]"));
    h.end(); // Ctrl-D — readline 'close' → the REPL resolves 0
    expect(await h.repl).toBe(0);
  });
});
