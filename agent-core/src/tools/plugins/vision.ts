/**
 * ROUND-66 (R66-2-b, owner directive B5): the GENERAL image-analysis tool —
 * the owner: "without using the computer use skill, the agent can just
 * generally use [image analysis]". `analyze_image` takes a LOCAL file path
 * or an http(s) URL, loads the bytes (≤8MB, png/jpg/jpeg/webp/gif/bmp for
 * paths), and describes them through the GLOBAL vision configuration
 * (storage/vision.ts — Settings → Image Analysis), riding the exact same
 * relay as the computer-use and embedded-browser screenshot descriptions
 * (relayVision from plugins/computer-use.ts): one vision configuration,
 * one honest failure story.
 *
 * Honest by construction — the tool NEVER throws:
 *   · ROUND-114 (R114-b): "off" is RETIRED — the relay always uses the
 *     BEST path it honestly has (the fully-configured separate vision
 *     model, else the main model when its row is marked supports_vision,
 *     with a chosen-but-unconfigured separate picker falling back to
 *     main). The refusal is reserved for NEITHER path working, and its
 *     guidance points at BOTH fixes (mark the model in Models & Providers,
 *     or pick the separate vision model in Settings → Image Analysis)
 *   · missing/oversized/wrong-extension file, bad URL, HTTP failure,
 *     non-image response → ok:false with the exact reason
 *
 * Read-only analysis — NO approval channel (it observes a file/URL the
 * model already reached through the sandboxed filesystem/web surfaces; the
 * only egress is the image bytes + instruction to the CONFIGURED vision
 * model). Registered for EVERY turn with a database (unlike computer use
 * there is no master switch — the honest refusal IS the switch, so the
 * model can always ASK and be told the truth). Bare/test builds
 * (no toolDeps.db) and the declaration catalog (db:null) get NOTHING —
 * the fail-closed convention of the computer-use plugin.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { jsonSchema } from "ai";
import type { PluginDefinition, ToolDefinition, ToolResult } from "../registry.js";
import { relayVision } from "./computer-use.js";

/** The same UA as tools/web.ts (kept local — web.ts does not export it). */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Image fetch/download caps (the mission's honest ceiling). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Local-path extension gate (case-insensitive). */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/** The default instruction (mission-specified). */
const DEFAULT_INSTRUCTION =
  "Describe this image precisely: subjects, text content, UI elements if any, and anything actionable.";

function refusal(error: string): ToolResult {
  return { ok: false, output: JSON.stringify({ error }) };
}

function dataResult(data: Record<string, unknown>): ToolResult {
  return { ok: true, output: JSON.stringify(data) };
}

/** Read a local image file (path-gated, size-gated) — never throws. */
async function readLocalImage(
  root: string,
  rawPath: string,
): Promise<{ ok: true; base64: string; bytes: number } | { ok: false; error: string }> {
  const trimmed = rawPath.trim();
  if (trimmed === "") {
    return { ok: false, error: "path must be a non-empty string" };
  }
  if (!IMAGE_EXT_RE.test(trimmed)) {
    return {
      ok: false,
      error: `analyze_image only reads image files (png, jpg, jpeg, webp, gif, bmp) — '${trimmed}' has an unsupported extension`,
    };
  }
  // Relative paths resolve against the project root (shell semantics);
  // absolute paths pass through — the tool is read-only analysis.
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(root, trimmed);
  let buffer: Buffer;
  try {
    buffer = await readFile(absolute);
  } catch (error) {
    return {
      ok: false,
      error: `analyze_image could not read '${trimmed}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `analyze_image refuses files over 8MB (${(buffer.byteLength / (1024 * 1024)).toFixed(1)}MB) — downscale or crop the image first`,
    };
  }
  if (buffer.byteLength === 0) {
    return { ok: false, error: `analyze_image: '${trimmed}' is empty (0 bytes)` };
  }
  return { ok: true, base64: buffer.toString("base64"), bytes: buffer.byteLength };
}

/** Fetch a remote image over http(s) (size-gated) — never throws. */
async function fetchRemoteImage(
  rawUrl: string,
): Promise<{ ok: true; base64: string; bytes: number; contentType: string } | { ok: false; error: string }> {
  const trimmed = (rawUrl ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `analyze_image: '${trimmed}' is not a valid URL` };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, error: `analyze_image refuses scheme '${parsed.protocol}' — http(s) only` };
  }
  let response: Response;
  try {
    response = await fetch(trimmed, {
      headers: { "user-agent": BROWSER_UA, accept: "image/*,*/*;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      error: `analyze_image: request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    return { ok: false, error: `analyze_image: HTTP ${response.status} for ${trimmed}` };
  }
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `analyze_image refuses downloads over 8MB (${(raw.byteLength / (1024 * 1024)).toFixed(1)}MB) — link a smaller image`,
    };
  }
  if (raw.byteLength === 0) {
    return { ok: false, error: `analyze_image: the URL returned an empty body` };
  }
  return {
    ok: true,
    base64: raw.toString("base64"),
    bytes: raw.byteLength,
    contentType: response.headers.get("content-type") ?? "(unknown content-type)",
  };
}

export const visionPlugin: PluginDefinition = {
  id: "core-vision",
  name: "Image Analysis",
  version: "1.0.0",
  description:
    "General image analysis: describe a local image file or an http(s) image URL through the globally configured vision model (Settings → Image Analysis) — works without computer use.",
  category: "vision",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    // ROUND-66 close-out: analyze_image is ALWAYS-REGISTERED vocabulary
    // (TOOL_NAMES + migration 0026 — a general capability like web_fetch),
    // so the DECLARATION context (db:null — the catalog's pure ctx) still
    // declares it; the missing-db case is handled honestly at EXECUTE time
    // below (the same refusal the vision-off path returns).
    if (toolDeps === undefined) {
      return [];
    }
    return [
      {
        name: "analyze_image",
        description:
          "Describe ANY image — a local file (png/jpg/jpeg/webp/gif/bmp, ≤8MB, relative paths resolve against the project root) or an http(s) URL (≤8MB) — through the configured vision model. Image attachments from chat are saved into the project at attachments/<name> — analyze them with the path EXACTLY as rendered in the user message ('saved in the project at <path>'), never a guessed one. Use it whenever you need to SEE image content: screenshots the user mentions, figures/diagrams in the project, web images. A session with no vision path (main model unmarked and no separate vision model configured) returns an honest refusal pointing at Models & Providers or Settings → Image Analysis.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            path: { type: "string", description: "local image file path (relative to the project root or absolute)" },
            url: { type: "string", description: "http(s) image URL" },
            instruction: {
              type: "string",
              description: "what to look for (default: a precise description of subjects, text, UI elements, and anything actionable)",
            },
          },
        } as never),
        execute: async (input): Promise<ToolResult> => {
          const path = typeof input["path"] === "string" ? (input["path"] as string) : undefined;
          const url = typeof input["url"] === "string" ? (input["url"] as string) : undefined;
          const rawInstruction = input["instruction"];
          const instruction =
            typeof rawInstruction === "string" && rawInstruction.trim() !== ""
              ? rawInstruction.slice(0, 500)
              : DEFAULT_INSTRUCTION;
          const hasPath = path !== undefined && path.trim() !== "";
          const hasUrl = url !== undefined && url.trim() !== "";
          if (!hasPath && !hasUrl) {
            return refusal("analyze_image needs exactly one of 'path' (a local image file) or 'url' (an http(s) image URL)");
          }
          if (hasPath && hasUrl) {
            return refusal("analyze_image accepts 'path' OR 'url' — pass one, not both");
          }
          // ROUND-66 close-out: the declaration context (db:null) declares
          // this tool; without a real db the vision settings are unreadable —
          // refuse BEFORE fetching any bytes.
          if (toolDeps.db === null || toolDeps.db === undefined) {
            return refusal(
              "analyze_image: no database in this context — the vision settings are unreadable (Settings → Image Analysis)",
            );
          }
          // 1. Obtain the bytes (honest failures, never a throw).
          let source: { base64: string; detail: string };
          if (hasPath) {
            const file = await readLocalImage(ctx.root, path as string);
            if (!file.ok) return refusal(file.error);
            source = { base64: file.base64, detail: `${(path as string).trim()} (${file.bytes} bytes)` };
          } else {
            const remote = await fetchRemoteImage(url as string);
            if (!remote.ok) return refusal(remote.error);
            source = {
              base64: remote.base64,
              detail: `${(url as string).trim()} (${remote.bytes} bytes, ${remote.contentType})`,
            };
          }
          // 2. Relay through the GLOBAL vision settings (relayVision's
          //    R114-b routing ladder: the fully-configured separate vision
          //    model, else the turn's main model when marked supports_vision,
          //    with separate-unconfigured falling back to main; the honest
          //    refusal names both fixes).
          const vision = await relayVision(
            toolDeps.db,
            toolDeps.keyring,
            toolDeps.mainModel,
            source.base64,
            instruction,
          );
          if (!vision.ok) {
            return refusal(vision.error);
          }
          return dataResult({
            source: source.detail,
            description: vision.text,
            model: vision.model,
            mode: vision.mode,
            ms: vision.ms,
          });
        },
      },
    ];
  },
};

export default visionPlugin;
