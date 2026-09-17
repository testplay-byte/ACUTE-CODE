<!-- last-reviewed: 2026-09-17 round-102 -->
# ATTACHMENTS — the chat attachment pipeline + the live screenshot rasters (owner's guide)

**Status:** normative · **Established:** round-50 (the composer's Add
Context surface), grown round-67 (real ingestion: dropped/pasted/picked
files become files ON DISK the model can analyze) · **Audience:** the owner
attaching images and files in chat, and any agent maintaining the pipeline

A chat attachment used to be a NAME the model was told about — the owner's
0.66.0 report: *"I uploaded an image directly in chat and the agent said
the image doesn't exist. It does not actually upload the image, it just
shows the path."* R67 closed that loop end to end: an image you drop,
paste, or pick becomes a real file at `<project>/attachments/<name>`, the
message's attachment carries that project-relative path, and the
model-facing history renders the exact `analyze_image` call with it. The
same round added the live screenshot THUMBNAILS (a related but separate
ephemeral store, covered at the bottom).

## The four composer sources

| Source | How it gets in | What happens to it |
|---|---|---|
| **Drag & drop** | A file dragged onto the composer | Binary ≤8 MB: the bytes ride the chip (base64) and upload on SEND; text files keep their 128 KB text head (the R50 behavior) |
| **Paste** | An image copied to the clipboard, pasted into the composer (Ctrl+V) | Same as drop — clipboard files are binary blobs without paths, so the bytes upload on send; a text-only paste stays a native text paste |
| **OS picker** | The composer's Add Context → file picker | The file is read server-side; a BINARY ≤8 MB with an absolute path is INGESTED immediately (the sidecar copies it into `attachments/`); project-relative reads need nothing (already inside) |
| **@ mention / project files** | Typing `@` in the composer picks a project file | Server-side read of a file already inside the project — text head on the chip; no copy, no upload |

Caps: at most **20 files per message**; text attachments keep their
128 KB head; binary uploads are capped at **8 MB decoded** (deliberately
the same ceiling `analyze_image` enforces — a file the vision tool would
refuse is not worth landing).

## The upload route (`POST /attachments/upload`)

One route serves both byte modes — same bearer wall as the sibling
`/attachments/read`:

- **Body**: `{projectId, name, dataBase64? | absolutePath?}` — EXACTLY ONE
  source (both or neither → 400). `dataBase64` carries the composer's
  dropped/pasted bytes; `absolutePath` carries a picker file for the
  sidecar to copy in (must be absolute — the same trust the read route
  applies — and readable; a directory or a missing file is an honest 400).
- **The name is sanitized** to a plain filename: no path separators, no
  `..` (conservatively anywhere — `x..y.png` is rejected too, never the
  traversal vector), no control characters, ≤200 chars. The EXTENSION
  survives (the vision tool's extension gate keeps working).
- **Validation**: strict base64 (alphabet + length %4 + round-trip decoded
  length) and the 8 MB decoded cap; the ROUTE itself has a 12 MB body
  limit (8 MB of bytes rides as ~10.7 MB of base64 — the default 1 MB
  would reject the request before the handler ran).
- **Dedupe, never overwrite**: the file lands at
  `<project-root>/attachments/<name>`; IDENTICAL content (size AND bytes)
  reuses the incumbent file, DIFFERENT content under the same name mints
  `-2`, `-3`… before the extension (`photo.png` → `photo-2.png`; the
  extension survives; the cap is 100 variants → 409). Nothing you attach
  can ever clobber an existing file.
- **Reply**: `200 {path: "attachments/<final-name>", name, size}` — the
  path is PROJECT-RELATIVE (forward slashes), exactly what the message's
  attachment and the model-facing history carry.

A failed upload never blocks the send: the message goes out with the old
honest no-path attachment plus a per-file toast ("File could not be
uploaded"). Bytes never ride the chat wire or the event log — they go
straight to this route, and only the resulting PATH is persisted.

## What the model sees (the analyze_image contract)

`renderAttachments` (the model-facing history builder) turns a
path-bearing attachment into an instruction the model can follow blindly:

```text
--- attached image: photo.png (saved in the project at attachments/photo.png) ---
Use analyze_image with path "attachments/photo.png" to view it.
```

An image with a path and no text gets the exact call above; an image that
also has text keeps the text plus the path line; any other path-bearing
file keeps its text render plus `(file saved at <path>)`; path-less
attachments (inline text, legacy rows) render exactly as before. On top of
that, the system prompt's tool-use rules teach the model: the file EXISTS
at the rendered path — call `analyze_image` with it EXACTLY as rendered,
never guess an absolute path, never ask the user to re-attach. The
`analyze_image` tool description repeats the contract
(`attachments/<name>`, the path EXACTLY as rendered). The loop is closed
at both ends: the message teaches the call, the tool accepts the path.

## The picker's 512 KB caveat (honest limitation)

The picker path rides the server-side READ route
(`POST /attachments/read`) BEFORE the ingest — and that route still caps
reads at **512 KB** per file (the R50 cap; text heads are 128 KB). A
picker file above 512 KB fails at the read with an honest per-file toast
and is never ingested. Dropped and pasted files are unaffected (their
bytes never ride the read route). A future round can relax the read cap
for ≤8 MB binaries; until then, big images belong in the composer via
drag-drop or paste.

## The ephemeral screenshot rasters (a separate store)

The live screenshot THUMBNAILS in chat (R67-D) look like attachments but
are a deliberately SEPARATE, EPHEMERAL pipeline:

- Every successful agent capture — the computer-use `screenshot` / `zoom`
  / `get_app_state includeScreenshot` tools AND the embedded browser's
  `screenshot` action — copies its PNG into an in-memory registry keyed by
  the capture's frame id (browser captures mint `bs_<base36>` ids) and
  emits a `{type:"screenshot"}` SSE frame.
- The live turn collects the ids (newest last, **cap 8**) and the chat
  renders the thumbnail strip below the working section while the agent
  is still thinking: each tile lazy-fetches
  **`GET /computer-use/frames/:frameId/raster`** (bearer-authed,
  `image/png`, `no-store`), shows the capturing tool as its caption, and
  clicks open into a dialog with the full image + timestamp.
- **The limits are the honesty**: the registry is in-memory only (a
  restarted engine serves 404s; a reloaded chat shows no screenshot
  history — the folded turn owns none by design), capped at **12 entries**
  (LRU — the oldest thumbnails evict), and every entry dies after
  **10 minutes** (the quiet "expired" tile after that, never a spinner).
  Rasters are never persisted, never fed to the model — the model-facing
  tool result is unchanged (metadata + the optional vision text).

## Troubleshooting

- **"Image not found" / the agent refuses the image** — check that the
  message's attachment shows a `attachments/<name>` path (the copy
  succeeded); a failed upload shows the per-file toast and the agent never
  got a path at all. Re-attaching via drop/paste is the fix.
- **A picker file over 512 KB refuses to attach** — the read cap above;
  drag-drop or paste the same file instead (≤8 MB lands fine).
- **Two different files with the same name** — both survive: the second
  lands as `<name>-2.<ext>` (identical content is deduplicated to ONE
  file, never overwritten).
- **A screenshot tile shows "expired"** — the 10-minute TTL (or the LRU
  evicted it, or the engine restarted). This is the design; the capture's
  TEXT (tool result + vision description) persists in the transcript.

## See also

- [EMBEDDED-BROWSER](EMBEDDED-BROWSER.md) — the browser screenshot action
  that also publishes thumbnails
- [COMPUTER-USE](COMPUTER-USE.md) — the capture tools (screenshot/zoom/
  get_app_state) whose rasters feed the strip
- [DEBUG-MODE](DEBUG-MODE.md) — the post-turn analyst that reads the same
  transcript the attachments render into
- Code map: the route `agent-core/src/server.ts` (`POST
  /attachments/upload` + the read route's 512 KB cap), the model-facing
  renderer `agent-core/src/agents/runtime.ts` (`renderAttachments`), the
  API clients `src/lib/api.ts` (`uploadAttachmentBytes` /
  `ingestAttachmentPath` / `fetchComputerFrameRaster`), the composer
  `src/components/project-chat/composer/Composer.tsx` + `composer-utils.ts`
  (the drop/paste/pick staging), the raster registry
  `agent-core/src/computer/raster-cache.ts` + the route (server.ts), the
  strip `src/components/project-chat/ScreenshotStrip.tsx`, the wire type
  `shared/src/index.ts` (`MessageAttachment.path`).
