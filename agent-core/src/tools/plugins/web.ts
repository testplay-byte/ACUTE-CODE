/**
 * ROUND-52 (R52-f): the WEB plugin — web_fetch / web_search, moved VERBATIM
 * from tools/index.ts buildProjectTools (host-gated fetch + DuckDuckGo
 * search with secret-scrubbed queries).
 */
import { jsonSchema } from "ai";
import { webFetch, webSearch, scrubSearchQuery } from "../web.js";
import { requestWebFetchApproval } from "../../approvals.js";
import { buildApprovalDeps } from "../approval-deps.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const webPlugin: PluginDefinition = {
  id: "core-web",
  name: "Web",
  version: "1.0.0",
  description: "Host-gated web fetch + real web search (DuckDuckGo chain).",
  category: "web",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    return [
      {
        name: "web_fetch",
        description:
          "Fetch a public http(s) URL and return its content as readable text. Documentation and source hosts (github.com, raw.githubusercontent.com, npmjs.com, developer.mozilla.org, react.dev, vitejs.dev, typescriptlang.org, nodejs.org, tauri.app, docs.rs, crates.io, pypi.org, docs.python.org, stackoverflow.com and more) fetch without friction; any OTHER host asks the owner for permission first (they can always-allow the host for the project). Use this to read documentation pages, RFCs, GitHub raw files, blog posts, and any public web page. HTML is stripped to readable text (scripts/styles removed); non-HTML content is returned raw. Response is capped at 16KB.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            url: { type: "string", description: "The absolute http(s) URL to fetch" },
          },
          required: ["url"],
        }),
        execute: async (input) => {
          const url = typeof input.url === "string" ? input.url : "";
          // ROUND-45 (P0-5): every outbound fetch is host-gated. No approval
          // channel at all (bare/test builds) = fail-closed.
          if (toolDeps === undefined) {
            return { ok: false, output: "web_fetch unavailable: no approval channel in this context" };
          }
          const approvalDeps = buildApprovalDeps(toolDeps);
          const gate = await requestWebFetchApproval(approvalDeps, url);
          if (!gate.allowed) {
            return { ok: false, output: `web_fetch blocked: ${gate.note}` };
          }
          return webFetch(url);
        },
      },
      {
        name: "web_search",
        description:
          "Search the REAL web for a query and return ranked results (title, url, snippet) via DuckDuckGo — no API key needed, no approval friction (it only talks to DuckDuckGo/Wikipedia, and the query is secret-scrubbed before it leaves). Use to find documentation, API references, library usage examples, GitHub issues, changelogs, or explanations of technical concepts. Returns up to 8 results. If both DuckDuckGo endpoints are unavailable it falls back to encyclopedia (Wikipedia) results and says so in the output — for reading a specific known URL, use web_fetch instead.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: { type: "string", description: "The search query (a few words works best)" },
          },
          required: ["query"],
        }),
        execute: async (input) => {
          const query = typeof input.query === "string" ? input.query : "";
          // ROUND-45 (P0-5): the query is the only model-controlled part that
          // leaves the machine — scrub keyring values + key-shaped strings.
          const secrets = toolDeps?.keyring !== undefined ? toolDeps.keyring.list() : [];
          return webSearch(scrubSearchQuery(query, secrets));
        },
      },
    ];
  },
};
