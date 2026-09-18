# acute-net

The ACUTE companion's native networking floor — a **local Expo module**
(autolinked from `mobile/modules/`, never installed from a registry).

## Why it exists (R3 §1.9)

v1 mandates TOFU certificate pinning on the desktop's self-signed TLS
certificate, and React Native's `fetch` can neither stream response bodies
(SSE) nor pin certificates. One small Kotlin module carries **both**:

| Function | Purpose |
|---|---|
| `request(options) → Promise<{status, headers, bodyText}>` | ordinary request + response |
| `openSse(options) → eventId` + `closeSse(eventId)` | long-lived SSE stream; frames delivered as module events |

## TLS discipline

- `pinSha256` present (64 hex chars, no colons) ⇒ a **per-call**
  `X509TrustManager` accepts EXACTLY a leaf certificate whose DER SHA-256
  equals the pin (constant-time compare; mismatch = hard TLS failure).
  Hostname checking is subsumed by the pin.
- `pinSha256` absent ⇒ OkHttp's **default** verification (standard CAs —
  the Cloudflare-tunnel path, R3 §4).
- Never a global trust-all. HTTP/2 stays as negotiated; SSE is unbuffered;
  gzip is transparent.

## The JS surface (`index.ts`)

```ts
import { request, openSse, NetError } from "../../modules/acute-net";

await request({ url: "https://192.168.1.4:53411/health", pinSha256: "aabb…", timeoutMs: 3000 });

const stream = openSse({ url, method: "POST", headers, bodyText: JSON.stringify({...}), pinSha256 });
stream.addEventListener("data", ({ event, data }) => …)   // one parsed SSE frame
  .addEventListener("error", ({ kind, message }) => …)     // "tls" | "network" | "http" | "canceled"
  .addEventListener("close", () => …);                      // server ended the stream
stream.close(); // cancel (no "close" fires — caller-initiated)
```

`openSse` returns a small EventSource-like handle — the same spelling the
desktop's browser client uses, so `src/link/connection.ts` can expose it almost
verbatim. Reconnect/backoff logic does **not** live here or in Kotlin —
`src/link/connection.ts` owns it. Kotlin just streams + reports errors.
