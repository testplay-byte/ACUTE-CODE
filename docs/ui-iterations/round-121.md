<!-- last-reviewed: 2026-09-23 round-121 -->
# ROUND 121 — the pixels round + the chart-hover ratchet leg

**The owner's standing directive:** "continue and keep on improving and make sure the
things are much better much proper well managed and well handled logics solid
functionality and all of it working as needed."

No device report this round — a self-directed quality round. The two highest-value
in-sandbox-verifiable targets from the carried queues:

## §1 The targets

### A. Attachment image pixels, end-to-end (the standing queue's oldest item)

The carried item (round-115 §4, re-carried by 116/117): "User-sent images still render
as framed thumbnails without pixels (the wire carries no attachment bytes to the
phone — the `attachmentImageUri` hook is the zero-change seam when the model grows)."

The survey found it is BROADER than the phone: **user-sent images render as text chips
(name · size) on every surface** —

| Surface | Today | After this round |
|---|---|---|
| PC composer (staged) | `FileText` icon + name + size chip | a pixel thumbnail rides the chip (the staged `dataBase64` is already on the model — never rendered until now) |
| PC transcript (sent) | text chip inside the bubble | image attachments render as thumbnails (aspect-kept) via the new bytes route |
| Mobile transcript (sent) | the honest image FRAME (icon + name + size — the `UserImageThumb` no-pixels leg) | pixels through the link (`responseBase64` → cache file URI — the proven raster.ts pipeline), tap → the existing full-screen viewer |

The R67 principle holds: **no byte field rides the message wire** — bytes are fetched
on demand from the attachments store, exactly like the raster frames before them.

### B. The usage-chart hover ratchet (the design-law debt leg)

The design audit's R5 baseline sits at 31 JS hover pairs. The MessageTimeline's fix
(R120-j) proved the pointer-owned pattern; the four USAGE CHART components hold 10 of
the remaining pairs in pure chart-tooltip shapes that fit the same law
(`usage/ModelDonut` 4, `dashboard/TokenBarChart` 2, `usage/ModelStackChart` 2,
`usage/UsageActivityChart` 2). Converting them to the pointer-read pattern re-pins
R5 **31 → 21** — the ratchet goes DOWN for everyone after.

NOT converting this round: the menu-timer components (NotificationBell, ModelSelector,
Toaster, ConfirmDialog, ExperimentalLayout, CodebasePanel, ContextDonut's popup legs)
— hover-intent open/close on menus is a distinct a11y pattern; that conversion needs
its own careful round (the R5 law's sanctioned pointer-read applies to charts/panels,
and a blind sweep would regress menu UX).

## §2 The wave plan

- **W1-a (agent-core)**: `GET /api/v1/projects/:id/attachments/bytes?path=<project-relative>`
  in routes/attachments.ts — resolveInsideRoot containment, IMAGE-only extension
  allowlist (png/jpg/jpeg/gif/webp/bmp — no SVG: RN `<Image>` does not raster it and
  the PC `<img>` keeps scripting surfaces out of the transcript), 8MB cap (the upload
  cap's mirror), raw bytes + content-type + private cache headers, honest 400/404
  envelope errors. Device tokens: NOT on the R109 blocklist → the phone reaches it
  (the blocklist is exact/prefix/suffix/infix — none match).
  Tests: `agent-core/tests/r121-attachment-bytes.test.ts`.
- **W1-b (PC)**: `fetchAttachmentBytes` in src/lib/api.ts (the
  fetchComputerFrameRaster pattern, blob) + `AttachmentImageThumb` (lazy-fetch on
  mount, object URL revoked on unmount — the ScreenshotRow lifecycle law) rendering
  inside the user bubble for image attachments; the composer chips gain a staged-byte
  thumbnail (`dataBase64` → data: URI — bytes already in hand, no fetch).
  Tests: AgentChatPanel.test.tsx + AttachmentChips.test.tsx pins.
- **W1-c (mobile)**: `fetchAttachmentImageFile` in features/attachments.ts (the
  raster.ts pattern: `responseBase64` → cache-dir file → URI; content-keyed cache
  name `att-<path-slug>-<size>.<ext>` so re-renders hit the cache) +
  `attachmentImageResolver` prop threaded TranscriptList → UserBubble → UserImageThumb
  (the seam stays: `attachmentImageUri` first, resolver second, the frame last).
  Tests: mobile features/__tests__.
- **W2 (charts)**: the four usage charts to the pointer-owned hover (one
  `onPointerMove` proximity read drives the active segment/tooltip — the grown
  segment and the tooltip can never disagree), re-pin R5 31 → 21 with
  `--update-baseline`, tests per component.
- **W3 (docs + gates)**: IMPLEMENTED-API.md (the new route), the round record, the
  full gate ladder (agent-core tsc+vitest, root tsc+eslint+vitest+design-audit,
  mobile tsc+jest), merge to main, watch CI.

## §3 The seams this round must NOT touch

- The MessageAttachment WIRE SHAPE (shared/src/index.ts) — no byte field, ever.
- The upload route's dedupe/never-overwrite law (a path's bytes are content-stable —
  what makes the cache headers honest).
- The R109 device-token blocklist families (terminal/internal/computer-use/keys).
- The R119/R120 pinned suites' behavior (MessageTimeline, AgentChatPanel rehydrate,
  harness stops, live battery).

## §3 Verification

**The gate ladder (the r121 branch, fresh at the close):**
- agent-core `npx tsc --noEmit` clean · `npx vitest run` — **150 files / 2799 passed** (baseline 148/2789; +1 file / +10 tests, all in r121-attachment-bytes.test.ts)
- root `npx tsc --noEmit` clean · `npx eslint .` 0 · `npx vitest run` — **261 files / 4609 passed + 15 environment-skips** (the fresh clone's sidecar-dist e2e pair + the cli handshake — honest conditional skips, zero failures; the W1 additions: AgentChatPanel 78/78 incl. 3 new pixels pins, AttachmentChips 5/5 new)
- mobile `npx tsc --noEmit` clean · `CI=1 npx jest --silent` — **43 suites / 959 passed** (baseline 43/952; +7 tests in attachments.test.ts) · eslint 0 on every touched file
- `node scripts/design-audit.mjs` clean at the RE-PINNED baseline — **R5 31 → 21, R4 18 → 16, R2 1591 → 1588** (the ratchet went DOWN on every rule)
- `docs:check` + the version gate at close (unchanged at 0.114.0 — this round ships no release; the pixels round rides v0.115.0)

**The pixels round's own pins (what the tests prove):**
- The ROUTE: raw bytes with the right content-type/length/cache headers; case-insensitive extensions; the full allowlist with svg + extension-less refused; `../` and absolute paths refused; the 8MB cap; the directory refusal; unknown project/file/param → 404/400; and the upload→path→SAME-bytes round-trip (the R67 pipeline closed).
- The PC: the image attachment fetches lazily and renders the pixel `<img>` (object URL); the non-image stays a chip (ONE fetch, not two); a fetch failure keeps the honest placeholder frame; unmount REVOKES the object URL (the ScreenshotRow law); the staged chip renders its own dataBase64 pixels; path-only and non-image chips keep the glyph.
- The mobile: the base64 comes back raw over `responseBase64`; 404 = permanent miss; transport = retryable; non-image/svg/extension-less never fetch (the client-side allowlist mirror); the cache name is content-keyed and separator-safe.

**W2 scoping note (honest):** the plan's chart-hover leg shipped for the four usage charts (ModelDonut + the three bar charts, 10 pairs) with the baseline re-pinned 31 → 21. The remaining 21 pairs live in the menu-timer components (NotificationBell, ModelSelector, Toaster, ConfirmDialog, ExperimentalLayout, CodebasePanel, ContextDonut's popup legs) — hover-intent open/close on MENUS is a distinct a11y pattern whose conversion needs its own careful round (the R5 law's sanctioned pointer-read applies to charts/panels; a blind sweep would regress menu UX). Recorded here so the next round inherits the exact remaining surface.

## §4 Close-out

**The live proof (the route on a REAL server):** agent-core's dist built and booted on a
scratch DB (:5199) — project created, a real 68-byte PNG uploaded through
POST /attachments/upload (`attachments/live.png`), then GET
/projects/:id/attachments/bytes answered `200` with `content-type: image/png`,
`content-length: 68`, `cache-control: private, max-age=300`, `etag: W/"att-68-png"` —
and the fetched bytes are an EXACT byte match with the uploaded PNG (the R67 pipeline
closed live). The negative legs live too: a `.log` path → 400 (not a displayable
image), a `../../` escape → 400. The rendering surfaces are pinned at the DOM level
(AgentChatPanel 78/78 incl. the three pixels pins — the `<img>` with the object URL,
the failure frame, the unmount revoke; AttachmentChips 5/5; mobile 959).

**Shipped:** W1 (the pixels round end-to-end — the display route + the PC thumbnails +
the composer's staged preview + the mobile resolver), W2 (the four usage charts'
pointer-owned hover + the ratchet re-pin R5 31→21 / R4 18→16 / R2 1591→1588), the docs
(IMPLEMENTED-API.md's route row, this record). **Deferred honestly:** the menu-timer
hover components (the §3 W2 note carries the exact remaining surface for the next
round); the release — this round ships no version bump (the pixels round rides
v0.115.0 with whatever lands next).

Merged to main at the close; CI + Mobile APK watched to green.
