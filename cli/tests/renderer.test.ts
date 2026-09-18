/**
 * ROUND-106 (R106-S3, CLI-DESIGN §6): the RENDERER units — pure frame→string
 * with the recorded fixtures (tests/fixtures/turn-frames.ts). The text
 * renderer's exit-code semantics (done/stopped → 0, error → 1), the tool
 * cards, the meta lines, the approval card + --auto-approve decision POST,
 * the quiet mode, and the NDJSON renderer's verbatim passthrough.
 */
import { describe, expect, it, vi } from "vitest";
import { createTurnRenderer } from "../src/render/turn.js";
import { createJsonRenderer } from "../src/render/json.js";
import { StatusLine, spinnerFrame } from "../src/render/status.js";
import {
  APPROVAL_TURN,
  COLOR_KIT,
  ERROR_TURN,
  META_TURN,
  PLAIN_KIT,
  QUESTION_TURN,
  SIMPLE_TURN,
  SUBAGENT_TURN,
  TOOL_FAIL_TURN,
  TOOL_TURN,
  UNKNOWN_FRAME,
} from "./fixtures/turn-frames.js";

interface Captured {
  out: string;
  err: string;
}

/** Drive a renderer over frames, capturing stdout/stderr. */
function renderFrames(
  frames: readonly unknown[],
  options: Partial<Parameters<typeof createTurnRenderer>[0]> & { kit?: typeof PLAIN_KIT } = {},
): { captured: Captured; codes: Array<number | undefined> } {
  const captured: Captured = { out: "", err: "" };
  const renderer = createTurnRenderer({
    stdout: (s) => {
      captured.out += s;
    },
    stderr: (s) => {
      captured.err += s;
    },
    kit: options.kit ?? PLAIN_KIT,
    plain: true,
    quiet: false,
    stderrTty: false,
    autoApprove: false,
    ...options,
  });
  const codes = frames.map((f) => renderer.handle(f as never));
  renderer.finish();
  return { captured, codes };
}

describe("the text-mode turn renderer (§4 exit-code semantics)", () => {
  it("text deltas flow verbatim; done → the usage line + exit 0", () => {
    const { captured, codes } = renderFrames(SIMPLE_TURN);
    expect(codes).toEqual([undefined, undefined, undefined, undefined, 0]);
    expect(captured.out).toBe("Hello from the sidecar.\n— done · z-ai/glm-5.2:free · 120 in · 8 out\n");
    expect(captured.err).toBe("");
    expect(captured.out).toContain("— done · z-ai/glm-5.2:free · 120 in · 8 out\n");
  });

  it("finish-frame usage is the done-frame fallback (no usage on done → bare line)", () => {
    const { captured, codes } = renderFrames([
      { type: "finish", usage: { inputTokens: 9, outputTokens: 9, totalTokens: 18 } },
      { type: "done" },
    ]);
    expect(codes).toEqual([undefined, 0]);
    expect(captured.out).toContain("— done · 9 in · 9 out\n");
  });

  it("stopped → exit 0 with the dim line; error → exit 1 with the red envelope", () => {
    const stopped = renderFrames([{ type: "stopped" }]);
    expect(stopped.codes).toEqual([0]);
    expect(stopped.captured.out).toContain("— stopped by user");
    const errored = renderFrames(ERROR_TURN);
    expect(errored.codes).toEqual([undefined, 1]);
    expect(errored.captured.err).toContain("stream error CONFLICT: no API key stored for provider 'openrouter'");
  });

  it("the error line renders red in color mode, plain otherwise", () => {
    const color = renderFrames(ERROR_TURN, { kit: COLOR_KIT, plain: false });
    expect(color.captured.err).toContain("\x1b[31mstream error CONFLICT:");
  });

  it("unknown/future frame types are ignored — no output, no exit code", () => {
    const { captured, codes } = renderFrames([UNKNOWN_FRAME, { type: "done" }]);
    expect(codes).toEqual([undefined, 0]);
    expect(captured.out).toBe("— done\n");
  });
});

describe("the tool cards (§4)", () => {
  it("tool-call → `▸ name(args)` + live output + ` ok` + dim 140-char summary", () => {
    const { captured, codes } = renderFrames(TOOL_TURN);
    expect(codes[codes.length - 1]).toBe(0);
    expect(captured.out).toContain("▸ run_command(command: curl weather) ");
    expect(captured.out).toContain("sunny 22C");
    expect(captured.out).toContain(" ok\n");
    expect(captured.out).toContain("      sunny 22C\n");
  });

  it("a FAILING tool result renders FAIL in red", () => {
    const { captured } = renderFrames(TOOL_FAIL_TURN, { kit: COLOR_KIT, plain: false });
    expect(captured.out).toContain("\x1b[31mFAIL\x1b[39m\n");
    // the summary is whitespace-folded + truncated at 140 chars
    expect(captured.out).toContain("EACCES: permission denied, open '/nope/x.txt'");
  });

  it("tool-input-start/-delta drive the status line (stderr, TTY only)", () => {
    const { captured } = renderFrames(
      [
        { type: "tool-input-start", toolCallId: "t1", toolName: "write_file" },
        { type: "tool-input-delta", toolCallId: "t1", inputTextDelta: '{"path":"a.txt"' },
        { type: "done" },
      ],
      { stderrTty: true },
    );
    expect(captured.err).toContain("\r\x1b[2K▸ write_file · preparing arguments…");
    expect(captured.err).toContain("\r\x1b[2K▸ preparing arguments: {\"path\":\"a.txt\"");
    // every real output clears the status line first (the §4 rule)
    expect(captured.err.endsWith("\r\x1b[2K")).toBe(true);
  });

  it("thinking-delta → ONE overwritten dim stderr line with the running count", () => {
    const { captured } = renderFrames(
      [
        { type: "thinking-delta", delta: "abc" },
        { type: "thinking-delta", delta: "defghij" },
        { type: "done" },
      ],
      { stderrTty: true },
    );
    expect(captured.err).toContain("thinking… (3 chars)");
    expect(captured.err).toContain("thinking… (10 chars)");
  });

  it("non-TTY stderr: thinking counts only — nothing written", () => {
    const { captured } = renderFrames([
      { type: "thinking-delta", delta: "abc" },
      { type: "done" },
    ]);
    expect(captured.err).toBe("");
  });
});

describe("the meta + subagent lines (§4)", () => {
  it("each meta frame renders its dim status line", () => {
    const { captured } = renderFrames(META_TURN);
    expect(captured.out).toContain("— continuing (iteration 2 · tool result)");
    expect(captured.out).toContain("— retrying (2/6 · rate_limit) in 3s · 429 Too Many Requests");
    expect(captured.out).toContain("— key pool: swapping to pool key 2 (attempt 2/3)");
    expect(captured.out).toContain("— resuming with your queued message (1 left)");
    expect(captured.out).toContain("— context overflow auto-compacted — retrying");
    expect(captured.out).toContain("— context compacted: 12000 tokens saved, 18 messages dropped");
    expect(captured.out).toContain("— context limit reached (190000 of 200000 tokens)");
    expect(captured.out).toContain("— request limit reached (60 of 60)");
    expect(captured.out).toContain("— outer loop cap reached (5 iterations)");
  });

  it("subagent-status → `[A1] running · role · task`; the wrapped inner frames are ignored", () => {
    const { captured, codes } = renderFrames(SUBAGENT_TURN);
    expect(captured.out).toContain("[A1] running · investigator · grep the logs for ECONNREFUSED");
    expect(captured.out).not.toContain("found 3 matches"); // subagent-event: no render
    expect(codes[0]).toBeUndefined();
  });
});

describe("the approval card (§4)", () => {
  it("without --auto-approve or a prompt: the yellow card + the raw escape-hatch hint", () => {
    const { captured } = renderFrames(APPROVAL_TURN);
    expect(captured.err).toContain("── approval requested ──");
    expect(captured.err).toContain("run_command(command: rm -rf /tmp/scratch)");
    expect(captured.err).toContain("category destructive · approval id apr_123");
    expect(captured.err).toContain("acute raw POST /approvals/apr_123/decision");
    expect(captured.err).toContain("— approval apr_123 approved (remember once)");
  });

  it("--auto-approve decides approved via POST /approvals/:id/decision", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const { captured } = renderFrames([APPROVAL_TURN[0]], { autoApprove: true, decideApproval: decide });
    expect(captured.err).toContain("--auto-approve: deciding approved …");
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("apr_123", "approved"));
    await vi.waitFor(() => expect(captured.err).toContain("approval apr_123 approved"));
  });

  it("a promptApproval ask resolves y/n through the decision POST", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const { captured } = renderFrames([APPROVAL_TURN[0]], {
      decideApproval: decide,
      promptApproval: async () => "denied",
    });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith("apr_123", "denied"));
    expect(captured.err).toContain("── approval requested ──");
  });
});

describe("the agent-question card (ROUND-107 F2 — ask_user stops hanging)", () => {
  it("without a prompt: the yellow card + the raw escape-hatch hint (piped contract)", () => {
    const { captured, codes } = renderFrames(QUESTION_TURN);
    expect(codes[codes.length - 1]).toBe(0);
    expect(captured.err).toContain("── agent question ──");
    expect(captured.err).toContain("1/2: Deploy to which environment?");
    expect(captured.err).toContain("  1) staging");
    expect(captured.err).toContain("  2) production");
    expect(captured.err).toContain("2/2: What should the release tag be?");
    expect(captured.err).toContain("(free text)");
    expect(captured.err).toContain("question id ask_1");
    expect(captured.err).toContain(
      "acute raw POST /agent-questions/ask_1/resolve '{\"answers\":[\"…\"]}'",
    );
    expect(captured.err).toContain("— question ask_1 answered · staging, v2.0");
  });

  it("a promptQuestion ask resolves through the resolve POST with sources", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const { captured } = renderFrames([QUESTION_TURN[0]], {
      decideQuestion: decide,
      promptQuestion: async () => ({ answers: ["staging", "v2.0"], sources: ["option", "custom"] }),
    });
    expect(captured.err).toContain("── agent question ──");
    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith("ask_1", ["staging", "v2.0"], ["option", "custom"]),
    );
    await vi.waitFor(() => expect(captured.err).toContain("question ask_1 answered"));
  });

  it("a NULL prompt answer leaves the ask open (no resolve POST)", async () => {
    const decide = vi.fn();
    const { captured } = renderFrames([QUESTION_TURN[0]], {
      decideQuestion: decide,
      promptQuestion: async () => null,
    });
    await vi.waitFor(() => expect(captured.err).toContain("no answer — the question stays open"));
    expect(decide).not.toHaveBeenCalled();
  });

  it("the resolved line is quiet-gated; the card renders yellow under a color kit", () => {
    const quiet = renderFrames([QUESTION_TURN[1]], { quiet: true });
    expect(quiet.captured.err).toBe("");
    const color = renderFrames([QUESTION_TURN[0]], { kit: COLOR_KIT, plain: false });
    expect(color.captured.err).toContain("\x1b[33m\x1b[1m── agent question ──\x1b[22m\x1b[39m");
  });
});

describe("quiet mode (§4: assistant text + terminal errors only)", () => {
  it("drops every meta/card/status line, keeps the text + exit semantics", () => {
    const { captured, codes } = renderFrames([...META_TURN.slice(0, -1), TOOL_TURN[2]], { quiet: true });
    expect(captured.out).toBe("");
    expect(captured.err).toBe("");
    expect(codes.every((c) => c === undefined)).toBe(true);
    const quiet = renderFrames(SIMPLE_TURN, { quiet: true });
    expect(quiet.captured.out).toBe("Hello from the sidecar.\n");
    expect(quiet.captured.out).not.toContain("— done");
    const qerr = renderFrames(ERROR_TURN, { quiet: true });
    expect(qerr.captured.err).toContain("stream error CONFLICT:");
  });
});

describe("the NDJSON renderer (§2 --mode json)", () => {
  it("sidecar frames pass through VERBATIM, one per line, with exit codes", () => {
    const lines: string[] = [];
    const renderer = createJsonRenderer({
      stdout: (s) => {
        lines.push(s.trimEnd());
      },
    });
    const codes = SIMPLE_TURN.map((f) => renderer.handle(f));
    renderer.exit(0);
    expect(codes).toEqual([undefined, undefined, undefined, undefined, 0]);
    expect(lines).toHaveLength(SIMPLE_TURN.length + 1);
    for (const frame of SIMPLE_TURN) {
      expect(lines).toContain(JSON.stringify(frame));
    }
    expect(lines[lines.length - 1]).toBe(JSON.stringify({ type: "cli.exit", code: 0 }));
  });

  it("agent-question frames pass through verbatim too (the NDJSON consumer's channel)", () => {
    const lines: string[] = [];
    const renderer = createJsonRenderer({
      stdout: (s) => {
        lines.push(s.trimEnd());
      },
    });
    const codes = QUESTION_TURN.map((f) => renderer.handle(f));
    expect(codes).toEqual([undefined, undefined, 0]);
    expect(lines[0]).toBe(JSON.stringify(QUESTION_TURN[0]));
    expect(lines[1]).toBe(JSON.stringify(QUESTION_TURN[1]));
  });

  it("error frames → exit 1; lifecycle events emit verbatim", () => {
    const lines: string[] = [];
    const renderer = createJsonRenderer({
      stdout: (s) => {
        lines.push(s.trimEnd());
      },
    });
    renderer.lifecycle({ type: "cli.session", sessionId: "s1" });
    expect(renderer.handle({ type: "error", code: "X", message: "boom" })).toBe(1);
    renderer.exit(1);
    expect(lines[0]).toBe(JSON.stringify({ type: "cli.session", sessionId: "s1" }));
    expect(lines[1]).toBe(JSON.stringify({ type: "error", code: "X", message: "boom" }));
    expect(lines[2]).toBe(JSON.stringify({ type: "cli.exit", code: 1 }));
  });

  it("exit without a terminal frame marks terminal:false (the honest marker)", () => {
    const lines: string[] = [];
    const renderer = createJsonRenderer({
      stdout: (s) => {
        lines.push(s.trimEnd());
      },
    });
    renderer.exit(1);
    expect(JSON.parse(lines[0])).toEqual({ type: "cli.exit", code: 1, terminal: false });
  });
});

describe("the StatusLine + spinner (§4)", () => {
  it("set writes `\\r\\x1b[2K` + text; clear erases; non-TTY no-ops everything", () => {
    const writes: string[] = [];
    const line = new StatusLine((s) => writes.push(s), true);
    line.set("working…");
    expect(writes).toEqual(["\r\x1b[2Kworking…"]);
    line.clear();
    expect(writes).toEqual(["\r\x1b[2Kworking…", "\r\x1b[2K"]);
    line.clear(); // idempotent — no ghost clears
    expect(writes).toHaveLength(2);

    const disabled = new StatusLine(() => writes.push("NEVER"), false);
    disabled.set("x");
    disabled.clear();
    disabled.message("y");
    expect(writes).toHaveLength(2);
  });

  it("message clears any active line first, then writes text + newline", () => {
    const writes: string[] = [];
    const line = new StatusLine((s) => writes.push(s), true);
    line.set("a");
    line.message("done");
    expect(writes).toEqual(["\r\x1b[2Ka", "\r\x1b[2K", "done\n"]);
  });

  it("spinnerFrame cycles its 4 frames at 200ms", () => {
    expect([spinnerFrame(0), spinnerFrame(200), spinnerFrame(400), spinnerFrame(600)]).toEqual([
      "·  ",
      "·· ",
      "···",
      " ··",
    ]);
    expect(spinnerFrame(800)).toBe("·  ");
  });
});
