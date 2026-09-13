/**
 * ROUND-95 (R95-C) — local-path → file:// URL normalization for the native
 * browser.
 *
 * The owner's report: "I gave it a file path for a local HTML file and after
 * giving it that, it gave me this error: 'Native browser unavailable. Only
 * HTTP/HTTPS URLs are supported by the embedded browser.'" The Rust gate now
 * accepts file:// (src-tauri/src/browser.rs `parse_web_url`), and THIS helper
 * is the frontend's half of the contract: whatever the user (or the agent)
 * types into the address bar that is a LOCAL PATH gets normalized into the
 * file:// URL the whole chain understands.
 *
 * The agent-core sidecar carries its own twin of this logic (the tool cannot
 * import frontend code — agent-core/src/tools/plugins/browser.ts's
 * `normalizeLocalFileUrl`); keep the two in behavioral lockstep (the tests
 * here + browser-tool.test.ts pin the same shapes).
 */

/** What `normalizeBrowserUrl` decided about an input. */
export type BrowserUrlNormalization = { url: string } | { error: string };

/** `C:\…` or `C:/…` — a Windows drive-qualified path (either slash style). */
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
/** A leading `\\` — a UNC path (`\\server\share\…`). */
const UNC_PREFIX = "\\\\";
/** A relative path that names a local page-ish file (`demo.html`, `docs/pic.svg`). */
const RELATIVE_LOCAL_FILE_RE = /^[^?#]*\.(?:html?|xhtml|svg|md|txt|json|css|js|mjs)(?:[?#]|$)/i;
/** Any URL scheme prefix (`https:`, `file:`, `about:`…). */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Normalizes a browser address into a URL the native chain understands.
 *
 *  - a `file:` URL is canonicalized through the WHATWG URL parser and
 *    returned;
 *  - a Windows drive path (`C:\Users\me\page.html`, either slash style) and a
 *    POSIX absolute path (`/home/me/page.html`) become `file:///…` URLs (the
 *    URL parser folds backslashes and percent-encodes spaces/non-ASCII);
 *  - a UNC path (`\\server\share\page.html`) becomes `file://server/share/…`;
 *    a query/hash riding after the path survives;
 *  - a RELATIVE path that names a local file (`demo.html`) is refused
 *    honestly — there is no base to resolve it against here;
 *  - an http(s) URL passes through UNCHANGED (the panel's own legacy
 *    normalization — https://-prefixing, search fallback — stays the
 *    authority for those, so this helper never rewrites them);
 *  - anything else (a bare domain, a search query, another scheme) returns
 *    `null`: not this helper's call — the caller's legacy handling applies.
 */
export function normalizeBrowserUrl(input: string): BrowserUrlNormalization | null {
  const trimmed = input.trim();
  if (trimmed === "") return { error: "the address is empty" };

  // An explicit file: URL — canonicalize (encoding, structure) so the whole
  // chain sees ONE shape. Unparseable → honest error.
  if (/^file:\/\//i.test(trimmed) || /^file:\/$/i.test(trimmed)) {
    try {
      return { url: new URL(trimmed).toString() };
    } catch {
      return { error: `'${trimmed}' is not a valid file:// URL` };
    }
  }

  // Local-path shapes FIRST — a Windows drive prefix (`C:`) also looks like a
  // URL scheme to a naive regex, so the drive/UNC/absolute checks must win.
  if (WINDOWS_DRIVE_RE.test(trimmed)) {
    // C:\Users\me\page.html or C:/Users/me/page.html → file:///C:/Users/me/page.html
    return { url: toFileUrl(`/${trimmed.replace(/\\/g, "/")}`) };
  }
  if (trimmed.startsWith(UNC_PREFIX)) {
    // \\server\share\page.html → file://server/share/page.html (the host
    // lowercases, like every URL host). Only BACKSLASH-led strings count —
    // `//host/x` stays a scheme-relative URL shape the legacy path owns.
    const parts = trimmed.slice(2).replace(/\\/g, "/").split("/").filter((p) => p !== "");
    if (parts.length === 0) {
      return { error: `'${trimmed}' is not a complete UNC path (expected \\\\server\\share\\file)` };
    }
    const [host, ...pathParts] = parts;
    const pathSuffix = pathParts.length > 0 ? `/${pathParts.join("/")}` : "";
    return { url: toFileUrl(`//${host.toLowerCase()}${pathSuffix}`) };
  }
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    // POSIX absolute path: /home/me/page.html → file:///home/me/page.html.
    return { url: toFileUrl(trimmed) };
  }

  // An explicit http(s) URL passes through UNCHANGED; other schemes are not
  // local paths either — `null` for both decisions the caller owns (the
  // legacy https://-prefixing for bare domains, the search fallback, the
  // any-scheme pass-through).
  if (SCHEME_RE.test(trimmed)) {
    if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
    return null;
  }

  // A RELATIVE path that names a local file — no base to resolve against
  // here, so refuse honestly instead of guessing.
  if (RELATIVE_LOCAL_FILE_RE.test(trimmed)) {
    return {
      error: `'${trimmed}' is a relative local path — give an absolute path (C:\\Users\\me\\page.html or /home/me/page.html)`,
    };
  }

  // A bare domain, a search query, anything else — the caller's call.
  return null;
}

/**
 * Builds a canonical file:// URL from a slash-normalized path part. The
 * WHATWG parser does the real work — backslash folding, per-segment
 * percent-encoding (spaces → %20, non-ASCII → UTF-8), query/hash splitting.
 * `slashedPath` starts with ONE slash (a local path: `/C:/…`, `/home/…`) or
 * TWO (a UNC path: `//server/share/…`).
 */
function toFileUrl(slashedPath: string): string {
  const parseFrom = slashedPath.startsWith("//") ? `file:${slashedPath}` : `file://${slashedPath}`;
  try {
    return new URL(parseFrom).toString();
  } catch {
    // A path the parser truly refuses (control chars, spaces in the host of
    // a UNC path…) — hand back a best-effort literal so the honest failure
    // surfaces downstream (the Rust gate or the route), never a crash here.
    return `file://${slashedPath}`;
  }
}

/**
 * ROUND-95 (R95-C): the inverse — a file:// URL back to the LOCAL PATH the
 * sidecar's `/browser/local-file` route takes (`?path=`). `null` when the
 * input is not a file URL or does not carry a local path.
 *
 * Browser-side re-implementation of Node's `fileURLToPath` (this module runs
 * in the webview, where `node:url` is unavailable): an empty host + a
 * drive-letter first segment → the Windows path (`C:/…`), an empty host
 * otherwise → the POSIX path, a non-empty host → the UNC path
 * (`\\server\share\…`). Percent-escapes are decoded per segment.
 */
export function fileUrlToLocalPath(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") return null;

  const decodeSegment = (segment: string): string => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment; // a lone '%' — hand it through untouched rather than throw
    }
  };
  const decodedSegments = parsed.pathname.split("/").map(decodeSegment);

  if (parsed.hostname === "") {
    const joined = decodedSegments.join("/");
    // file:///C:/x → C:/x (the drive letter's leading slash comes off).
    if (/^\/[a-zA-Z]:\//.test(joined)) return joined.slice(1);
    return joined; // file:///home/x → /home/x
  }
  // file://server/share/x → \\server\share\x
  return `\\\\${parsed.hostname}${decodedSegments.join("\\")}`;
}
