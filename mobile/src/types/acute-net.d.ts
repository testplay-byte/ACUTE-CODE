/**
 * The typed surface of modules/acute-net, aliased for the whole src/ tree —
 * `import type { HttpResponse } from "@/types/acute-net"`.
 *
 * The runtime module lives OUTSIDE src/ (mobile/modules/acute-net — the local
 * Expo module, autolinked), so it cannot ride the `@/*` alias directly; this
 * declaration file re-exports its public type surface so the link layer (and
 * anything after it) consumes one stable specifier. Type-only: nothing here
 * touches the native bridge at runtime.
 */

export type {
  HttpRequestOptions,
  HttpResponse,
  NativeNetOptions,
  NetError,
  NetErrorKind,
  SseCloseListener,
  SseDataListener,
  SseError,
  SseErrorListener,
  SseEvent,
  SseOptions,
  SseStream,
} from "../../modules/acute-net";
