// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the attachments domain (ROUND-50 R50-c1 + ROUND-67 R67-A).
//
// Registers, in the original server.ts registration order: POST
// /attachments/read (the composer's text heads) and POST /attachments/upload
// (the R67 ingestion — the owner's #1 v0.66.0 field report fix).
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. The R67-A ingestion constants
// (MAX_ATTACHMENT_UPLOAD_BYTES / ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES /
// ATTACHMENT_SUFFIX_CAP + attachmentSuffixName) moved with the domain; they
// are this domain's private gates.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProject } from "../storage/projects.js";
import { resolveInsideRoot } from "../tools/index.js";
import { errorBody } from "./helpers.js";

// ── ROUND-67 (R67-A): attachment INGESTION constants ──────────────────────────

/**
 * ROUND-67 (R67-A): decoded-byte ceiling for a single uploaded attachment —
 * deliberately the SAME 8MB analyze_image enforces (tools/plugins/vision.ts
 * MAX_IMAGE_BYTES): a file the vision tool would refuse is not worth landing
 * in the project.
 */
const MAX_ATTACHMENT_UPLOAD_BYTES = 8 * 1024 * 1024;
/**
 * ROUND-67 (R67-A): per-route body cap for POST /attachments/upload. 8MB of
 * file bytes rides as ~10.7MB of base64 JSON — far above fastify's 1MB
 * default, which would 413 the request before the handler ever ran.
 */
const ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES = 12 * 1024 * 1024;
/** ROUND-67 (R67-A): how many -2/-3… dedupe variants one name may mint. */
const ATTACHMENT_SUFFIX_CAP = 100;

/**
 * ROUND-67 (R67-A): the dedupe-suffixed form of an attachment name —
 * "photo.png" → "photo-2.png" (the EXTENSION survives so analyze_image's
 * extension gate still passes); extension-less names just append. Conservative
 * and honest: the counter starts at 2 and counts from the ORIGINAL name.
 */
function attachmentSuffixName(name: string, counter: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${counter}${name.slice(dot)}` : `${name}-${counter}`;
}


export function registerAttachmentRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
  // ── ROUND-50 (R50-c1): reading attachment content ──────────────────────
  // POST /attachments/read — body { paths: string[], projectId? } → the
  // text heads the composer attaches. Per-file outcomes (NEVER a 500):
  //   - relative paths resolve ONLY inside the given project's root
  //     (escape / missing project → per-file error entry);
  //   - absolute paths read as-is (user-picked files; local-first app,
  //     user-initiated read);
  //   - files > 512KB are refused; text = the first 128KB head
  //     (truncated: true when longer);
  //   - a NUL byte in the first 8KB marks binary → text: null.
  scope.post("/attachments/read", async (request, reply) => {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    if (!Array.isArray(raw.paths) || raw.paths.some((p) => typeof p !== "string")) {
      return reply.code(400).send(
        errorBody("VALIDATION", "paths must be an array of strings", {
          field: "body.paths",
        }),
      );
    }
    const paths = raw.paths as string[];
    if (paths.length > 20) {
      return reply.code(400).send(
        errorBody("VALIDATION", "at most 20 paths per request", { field: "body.paths" }),
      );
    }
    if (raw.projectId !== undefined && typeof raw.projectId !== "string") {
      return reply.code(400).send(
        errorBody("VALIDATION", "projectId must be a string", { field: "body.projectId" }),
      );
    }
    const projectId = typeof raw.projectId === "string" ? raw.projectId : undefined;
    const project = projectId !== undefined ? getProject(db, projectId) : undefined;

    const MAX_READABLE_BYTES = 512 * 1024;
    const TEXT_HEAD_BYTES = 128 * 1024;
    const BINARY_SNIFF_BYTES = 8 * 1024;

    const files = paths.map((path): Record<string, unknown> => {
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      const errorEntry = (error: string): Record<string, unknown> => ({
        path,
        name,
        size: 0,
        text: null,
        truncated: false,
        error,
      });

      // Resolve: absolute (user-picked) vs project-relative.
      let abs: string;
      const isAbsoluteLike = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
      if (isAbsoluteLike) {
        abs = path;
      } else {
        if (project === undefined) {
          return errorEntry(
            projectId !== undefined
              ? `project ${projectId} not found — relative paths need a valid project`
              : "relative paths need a projectId",
          );
        }
        const resolved = resolveInsideRoot(project.rootPath, path);
        if ("error" in resolved) return errorEntry(resolved.error);
        abs = resolved.abs;
      }

      try {
        const stats = statSync(abs);
        if (stats.isDirectory()) {
          return errorEntry(`'${path}' is a directory, not a file`);
        }
        if (stats.size > MAX_READABLE_BYTES) {
          return errorEntry(
            `file is ${stats.size} bytes — above the 512KB attachment read limit`,
          );
        }
        const head = readFileSync(abs);
        const sniff = head.subarray(0, BINARY_SNIFF_BYTES);
        if (sniff.includes(0)) {
          // Binary (a NUL byte in the first 8KB) — no text, honest size.
          return { path, name, size: stats.size, text: null, truncated: false };
        }
        const text = head.subarray(0, TEXT_HEAD_BYTES).toString("utf8");
        return {
          path,
          name,
          size: stats.size,
          text,
          truncated: stats.size > TEXT_HEAD_BYTES,
        };
      } catch {
        return errorEntry(`cannot read '${path}': no such file or unreadable`);
      }
    });

    return reply.code(200).send({ files });
  });

  // ── ROUND-67 (R67-A): attachment INGESTION ────────────────────────────
  // POST /attachments/upload — body { projectId, name, dataBase64? |
  // absolutePath? }, EXACTLY ONE source. The owner's #1 v0.66.0 field
  // report: "I uploaded an image directly in chat and the agent said the
  // image doesn't exist. It does not actually upload the image, it just
  // shows the path." — dropped/pasted bytes died in the BROWSER (the
  // composer's NUL-sniff read the ArrayBuffer only to discard it), the
  // wire attachment never carried bytes, and renderAttachments showed the
  // model a.name only, so analyze_image guessed at paths and ENOENT'd.
  // This route is the missing half of the pipeline:
  //   - dataBase64   → the composer's dropped/pasted bytes (≤8MB decoded,
  //                    base64-validated with a round-trip length check),
  //                    written to <root>/attachments/<sanitized-name>;
  //   - absolutePath → an OS-picker file the SIDECAR copies in (fs
  //                    copyFile — the picker returns trusted absolute
  //                    paths, the same trust POST /attachments/read reads
  //                    them with).
  // The target is DEDUPED: an identical file (same size AND content) is
  // reused; a DIFFERENT file under the same name gets a -2/-3… suffix
  // before the extension — NEVER an overwrite. Containment follows the
  // resolveInsideRoot convention (fs-ops.ts): the name is sanitized to a
  // single plain filename, then joined under <root>/attachments/. Reply:
  // 200 { path: "attachments/<final-name>" (PROJECT-RELATIVE, forward
  // slashes), name, size } — the composer threads `path` back onto the
  // chip, onto message.user, and renderAttachments renders it as the
  // exact analyze_image instruction. Per-route bodyLimit: 8MB of bytes
  // rides as ~10.7MB of base64 JSON, far above fastify's 1MB default.
  scope.post(
    "/attachments/upload",
    { bodyLimit: ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const body: unknown = request.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return reply
          .code(400)
          .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
      }
      const raw = body as Record<string, unknown>;

      // Project → whose attachments/ dir receives the file.
      if (typeof raw.projectId !== "string" || raw.projectId.trim() === "") {
        return reply.code(400).send(
          errorBody("VALIDATION", "projectId must be a non-empty string", {
            field: "body.projectId",
          }),
        );
      }
      const project = getProject(db, raw.projectId);
      if (project === undefined) {
        return reply
          .code(404)
          .send(errorBody("NOT_FOUND", `no project with id ${raw.projectId}`));
      }

      // Name → the on-disk filename. Sanitized to a PLAIN filename: no
      // path separators, no '..' (conservatively anywhere — also rejects
      // harmless 'x..y.png', never the traversal vector), no control
      // characters, ≤200 chars (the readComposerSendFields caps). The
      // EXTENSION survives (the dedupe suffix keeps it too).
      if (typeof raw.name !== "string" || raw.name.trim() === "" || raw.name.length > 200) {
        return reply.code(400).send(
          errorBody("VALIDATION", "name must be a non-empty string (≤200 chars)", {
            field: "body.name",
          }),
        );
      }
      const name = raw.name;
      if (/[\\/]/.test(name) || name.includes("..") || /[\u0000-\u001f\u007f]/.test(name)) {
        return reply.code(400).send(
          errorBody(
            "VALIDATION",
            "name must be a plain filename — no path separators, '..', or control characters",
            { field: "body.name" },
          ),
        );
      }

      // EXACTLY ONE source of bytes (typed checks keep the error honest
      // for junk values, not just absence).
      if (raw.dataBase64 !== undefined && typeof raw.dataBase64 !== "string") {
        return reply.code(400).send(
          errorBody("VALIDATION", "dataBase64 must be a base64 string", {
            field: "body.dataBase64",
          }),
        );
      }
      if (raw.absolutePath !== undefined && typeof raw.absolutePath !== "string") {
        return reply.code(400).send(
          errorBody("VALIDATION", "absolutePath must be a string", {
            field: "body.absolutePath",
          }),
        );
      }
      const hasData = typeof raw.dataBase64 === "string";
      const hasPath = typeof raw.absolutePath === "string";
      if (hasData && hasPath) {
        return reply.code(400).send(
          errorBody("VALIDATION", "pass dataBase64 OR absolutePath — one, not both", {
            field: "body",
          }),
        );
      }
      if (!hasData && !hasPath) {
        return reply.code(400).send(
          errorBody(
            "VALIDATION",
            "exactly one of dataBase64 (base64 file bytes) or absolutePath (a file to copy) is required",
            { field: "body" },
          ),
        );
      }

      // Obtain the bytes. dataBase64: strict base64 (regex + length %4 +
      // round-trip decoded length) and the 8MB cap. absolutePath: the
      // same absolute-path trust the read route applies, then stat + read
      // (the read is needed for the dedupe comparison; the write itself
      // uses copyFile).
      let bytes: Buffer;
      let copyFrom: string | null = null;
      if (hasData) {
        const dataBase64 = raw.dataBase64 as string;
        const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
        const expectedBytes = (dataBase64.length / 4) * 3 - padding;
        if (
          dataBase64 === "" ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) ||
          dataBase64.length % 4 !== 0
        ) {
          return reply.code(400).send(
            errorBody("VALIDATION", "dataBase64 is not a valid base64 string", {
              field: "body.dataBase64",
            }),
          );
        }
        bytes = Buffer.from(dataBase64, "base64");
        if (bytes.length !== expectedBytes) {
          return reply.code(400).send(
            errorBody("VALIDATION", "dataBase64 is not a valid base64 string", {
              field: "body.dataBase64",
            }),
          );
        }
        if (bytes.length > MAX_ATTACHMENT_UPLOAD_BYTES) {
          return reply.code(400).send(
            errorBody(
              "VALIDATION",
              `attachment is ${bytes.length} bytes — above the ${MAX_ATTACHMENT_UPLOAD_BYTES / (1024 * 1024)}MB upload limit`,
              { field: "body.dataBase64" },
            ),
          );
        }
      } else {
        const absolutePath = (raw.absolutePath as string).trim();
        const absoluteLike = absolutePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(absolutePath);
        if (absolutePath === "" || !absoluteLike) {
          return reply.code(400).send(
            errorBody("VALIDATION", `absolutePath must be an ABSOLUTE path (got '${raw.absolutePath}')`, {
              field: "body.absolutePath",
            }),
          );
        }
        try {
          const stats = statSync(absolutePath);
          if (stats.isDirectory()) {
            return reply.code(400).send(
              errorBody("VALIDATION", `'${absolutePath}' is a directory, not a file`, {
                field: "body.absolutePath",
              }),
            );
          }
          bytes = readFileSync(absolutePath);
          copyFrom = absolutePath;
        } catch {
          return reply.code(400).send(
            errorBody("VALIDATION", `cannot read '${absolutePath}': no such file or unreadable`, {
              field: "body.absolutePath",
            }),
          );
        }
      }

      // Persist INSIDE the project (fs-ops writeFile style: sync fs,
      // mkdir with parents, try/catch, honest envelope).
      try {
        const attachmentsDir = join(project.rootPath, "attachments");
        mkdirSync(attachmentsDir, { recursive: true });
        let finalName = name;
        let reused = false;
        for (let counter = 2; ; counter++) {
          const candidate = join(attachmentsDir, finalName);
          if (!existsSync(candidate)) break;
          let identical = false;
          try {
            const existing = readFileSync(candidate);
            identical = existing.length === bytes.length && existing.equals(bytes);
          } catch {
            // Unreadable incumbent — treat as a different file (never a
            // silent reuse of something we could not verify).
          }
          if (identical) {
            reused = true;
            break;
          }
          if (counter > ATTACHMENT_SUFFIX_CAP) {
            return reply.code(409).send(
              errorBody(
                "CONFLICT",
                `attachments/${name} already has ${ATTACHMENT_SUFFIX_CAP} different variants — refusing to mint more`,
              ),
            );
          }
          finalName = attachmentSuffixName(name, counter);
        }
        const target = join(attachmentsDir, finalName);
        if (!reused) {
          if (copyFrom !== null) copyFileSync(copyFrom, target);
          else writeFileSync(target, bytes);
        }
        const size = statSync(target).size;
        return reply.code(200).send({
          path: `attachments/${finalName}`,
          name: finalName,
          size,
        });
      } catch (error) {
        return reply.code(500).send(
          errorBody(
            "INTERNAL",
            `could not persist attachment '${name}': ${error instanceof Error ? error.message : "unknown error"}`,
          ),
        );
      }
    },
  );
}
