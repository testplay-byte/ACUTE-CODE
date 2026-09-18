/**
 * ROUND-106 (R106-S3, CLI-DESIGN §6 M1/M2 test contract): RECORDED frame
 * fixtures — realistic wire shapes captured from the sidecar's SSE stream
 * (the desktop StreamTurnEvent union's spelling), fed to the PURE
 * frame→string renderer units. No I/O, no server — the renderers are pure
 * functions of the frames + a color kit.
 */
import type { TurnFrame } from "../../src/frames.js";
import { colorKitFor, type ColorKit } from "../../src/color.js";

/** A plain-text kit (NO_COLOR semantics) for byte-exact assertions. */
export const PLAIN_KIT: ColorKit = colorKitFor(false, {});

/** A color kit as a TTY would get (for the ANSI-escape assertions). */
export const COLOR_KIT: ColorKit = colorKitFor(true, {});

/** A simple greeting turn: text deltas → finish → done. */
export const SIMPLE_TURN: readonly TurnFrame[] = [
  { type: "text-delta", delta: "Hello" },
  { type: "text-delta", delta: " from " },
  { type: "text-delta", delta: "the sidecar.\n" },
  { type: "finish", usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 } },
  {
    type: "done",
    usage: { model: "z-ai/glm-5.2:free", inputTokens: 120, outputTokens: 8, costUsd: 0 },
  },
];

/** A markdown-bearing turn (bold/italic/code/heading/fence). */
export const MARKDOWN_TURN: readonly TurnFrame[] = [
  { type: "text-delta", delta: "## Plan\n\n" },
  { type: "text-delta", delta: "Use **acute** with *care*.\n\n" },
  { type: "text-delta", delta: "Run `acute status` to check.\n\n" },
  { type: "text-delta", delta: "```\nconst x = 1;\n```\n" },
  {
    type: "done",
    usage: { model: "z-ai/glm-5.2:free", inputTokens: 90, outputTokens: 40, costUsd: 0 },
  },
];

/** A tool-bearing turn: input preview → call → live output → result. */
export const TOOL_TURN: readonly TurnFrame[] = [
  { type: "thinking-delta", delta: "The user wants the weather." },
  { type: "text-delta", delta: "Checking the weather.\n\n" },
  { type: "tool-input-start", toolCallId: "tc_1", toolName: "run_command" },
  { type: "tool-input-delta", toolCallId: "tc_1", inputTextDelta: '{"command":"curl weather"}' },
  { type: "tool-call", toolName: "run_command", argsSummary: "command: curl weather" },
  { type: "tool-output", toolName: "run_command", chunk: "sunny 22C" },
  {
    type: "tool-result",
    toolName: "run_command",
    argsSummary: "command: curl weather",
    ok: true,
    outputSummary: "sunny 22C",
  },
  { type: "text-delta", delta: "It is sunny and 22C.\n" },
  {
    type: "done",
    usage: { model: "z-ai/glm-5.2:free", inputTokens: 300, outputTokens: 60, costUsd: 0.0004 },
  },
];

/** A FAILING tool result (the FAIL verdict leg). */
export const TOOL_FAIL_TURN: readonly TurnFrame[] = [
  { type: "tool-call", toolName: "write_file", argsSummary: "path: /nope/x.txt" },
  {
    type: "tool-result",
    toolName: "write_file",
    argsSummary: "path: /nope/x.txt",
    ok: false,
    outputSummary: "EACCES: permission denied, open '/nope/x.txt'",
  },
  { type: "stopped" },
];

/** The meta ladder: continuation, retry, key pool, queue, compaction, caps. */
export const META_TURN: readonly TurnFrame[] = [
  { type: "meta.continuation", iteration: 2, reason: "tool result" },
  {
    type: "meta.retry",
    attempt: 2,
    totalAttempts: 6,
    waitMs: 4000,
    remainingMs: 3000,
    retryAt: 1726000000000,
    errorClass: "rate_limit",
    rateLimitReason: "rate",
    classMessage: "Provider rate limit",
    message: "Retrying in 3s",
    providerError: "429 Too Many Requests",
  },
  { type: "meta.key", key: { attempt: 2, totalKeys: 3, reason: "rate_limit" }, message: "swapping to pool key 2" },
  { type: "meta.queue_continue", count: 1, recovery: true },
  { type: "meta.overflow_recovery", message: "context overflow auto-compacted — retrying" },
  { type: "meta.compaction", tokensSaved: 12000, droppedMessages: 18, throughSeq: 42 },
  { type: "meta.context_limit", tokens: 190000, limit: 200000 },
  { type: "meta.request_limit", requests: 60, limit: 60 },
  { type: "meta.continuation_complete", iterations: 5 },
  { type: "done", usage: { model: "m", inputTokens: 1, outputTokens: 2, costUsd: 0 } },
];

/** A sub-agent delegation turn. */
export const SUBAGENT_TURN: readonly TurnFrame[] = [
  {
    type: "subagent-status",
    sessionId: "child-1",
    parentSessionId: "parent-1",
    status: "running",
    task: "grep the logs for ECONNREFUSED",
    role: "investigator",
    code: "A1",
  },
  {
    type: "subagent-event",
    sessionId: "child-1",
    parentSessionId: "parent-1",
    inner: { type: "text-delta", delta: "found 3 matches" },
  },
  { type: "done", usage: { model: "m", inputTokens: 10, outputTokens: 20, costUsd: 0 } },
];

/** An approval-bearing turn (the yellow card + resolution). */
export const APPROVAL_TURN: readonly TurnFrame[] = [
  {
    type: "approval.requested",
    approvalId: "apr_123",
    toolName: "run_command",
    argsSummary: "command: rm -rf /tmp/scratch",
    category: "destructive",
  },
  { type: "approval.resolved", approvalId: "apr_123", decision: "approved", remember: "once" },
  { type: "done", usage: { model: "m", inputTokens: 5, outputTokens: 5, costUsd: 0 } },
];

/** ROUND-107 (R107-c-impl, F2): an ask_user turn — the agent-question frame
 * (two questions: numbered options + free text) and its resolution. */
export const QUESTION_TURN: readonly TurnFrame[] = [
  {
    type: "agent-question",
    sessionId: "s1",
    questionId: "ask_1",
    questions: [
      { question: "Deploy to which environment?", options: ["staging", "production"] },
      { question: "What should the release tag be?" },
    ],
  },
  {
    type: "agent-question.resolved",
    sessionId: "s1",
    questionId: "ask_1",
    resolution: "answered",
    answers: ["staging", "v2.0"],
    sources: ["option", "custom"],
  },
  { type: "done", usage: { model: "m", inputTokens: 5, outputTokens: 5, costUsd: 0 } },
];

/** The terminal error frame (exit 1). */
export const ERROR_TURN: readonly TurnFrame[] = [
  { type: "text-delta", delta: "Trying.\n" },
  { type: "error", status: 409, code: "CONFLICT", message: "no API key stored for provider 'openrouter'" },
];

/** An unknown future frame type (version skew — ignored, never an error). */
export const UNKNOWN_FRAME: TurnFrame = {
  type: "meta.some_future_thing",
  payload: { whatever: true },
} as unknown as TurnFrame;
