/**
 * ROUND-87 (R87): the ask-user plugin — `ask_user`, the agent's mid-task
 * question tool. The owner: "giving it the ability to ask the user questions
 * midway through. It will ask questions and the user can select from the
 * options or maybe he can type in a custom response and such. He can answer
 * multiple questions this way."
 *
 * Mechanics live in agent-question.ts (the browser-checkpoint pattern: the
 * pending-ask registry + the SSE frame pair + the REST resolve route). This
 * plugin is the tool surface: normalize the input questions, gate on the
 * live-stream channel, wait for the owner, and format the answers back to
 * the model as an honest Q&A block.
 */
import { jsonSchema } from "ai";
import { askUser, normalizeQuestions } from "../../agent-question.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const askUserPlugin: PluginDefinition = {
  id: "core-ask-user",
  name: "Ask User",
  version: "1.0.0",
  description: "The mid-task interactive question tool (options + custom answers).",
  category: "planning",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    if (toolDeps === undefined) return [];
    return [
      {
        name: "ask_user",
        description:
          "Ask the user QUESTIONS mid-task and WAIT for the answers — the chat renders a question card and the turn pauses until the user answers, the 10-minute timeout passes, or the turn is stopped. Use it whenever the task is ambiguous or a decision belongs to the user: which approach to take, which files to touch, how to handle a trade-off, confirming a destructive step. Ask EARLY (before building on assumptions) and ask TOGETHER (batch related questions into one call — each call opens one card). Each question: {question, options? (2-8 preset answers as short pills — include them whenever the plausible answers are enumerable; a sensible default first), allowCustom? (default true — may the user type a free-text answer instead), placeholder? (hint for the custom input)}. Keep questions short and specific; never ask what you can determine yourself from the project. The result is the user's answers verbatim, or an honest timeout/cancelled note — state your assumption and proceed when unanswered.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  question: { type: "string", description: "What to ask (one short, specific question)" },
                  options: {
                    type: "array",
                    items: { type: "string" },
                    description: "2-8 preset answers the user can pick as pills",
                  },
                  allowCustom: {
                    type: "boolean",
                    description: "May the user type a free-text answer (default true)",
                  },
                  placeholder: {
                    type: "string",
                    description: "Hint shown in the custom-answer input",
                  },
                },
                required: ["question"],
              },
              description: "The questions to ask (batched; one card, one wait)",
            },
          },
          required: ["questions"],
        }),
        execute: async (input) => {
          const normalized = normalizeQuestions(input.questions);
          if (!normalized.ok) {
            return { ok: false, output: `ask_user: ${normalized.reason}` };
          }
          // The live-stream gate: no interactive channel means no one to
          // ask — fail closed with the honest note (never a silent hang).
          if (toolDeps.interactiveApprovals !== true || toolDeps.emit === undefined) {
            return {
              ok: false,
              output:
                "ask_user: no live chat stream in this context — there is no one to ask. Proceed with your best judgment and state the assumption in the reply.",
            };
          }
          const result = await askUser(
            {
              emit: toolDeps.emit,
              signal: toolDeps.signal,
              db: toolDeps.db,
              sessionId: toolDeps.sessionId,
              agentId: toolDeps.agentId,
            },
            { sessionId: toolDeps.sessionId, agentId: toolDeps.agentId, questions: normalized.questions },
          );
          if (result.resolution === "answered") {
            const lines = normalized.questions.map((question, index) => {
              const answer = result.answers[index] ?? "";
              return `Q: ${question.question}\nA: ${answer}`;
            });
            return {
              ok: true,
              output: `The user answered all ${normalized.questions.length} question(s):\n\n${lines.join("\n\n")}`,
            };
          }
          if (result.resolution === "timeout") {
            return {
              ok: true,
              output:
                "The user did not answer within 10 minutes. Proceed with your best judgment, clearly state the assumption you made, and offer to redo the affected part if the user disagrees.",
            };
          }
          return {
            ok: true,
            output:
              "The turn was stopped before the user answered. Do not assume an answer; wrap up cleanly.",
          };
        },
      },
    ];
  },
};
