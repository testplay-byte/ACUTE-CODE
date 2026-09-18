/**
 * The REAL transport — the single runtime import of the acute-net native
 * module inside src/. Everything under test imports the NetTransport
 * interface instead; only the app's runtime wiring (runtime.ts) touches this
 * file, so no test ever loads the native bridge.
 */

import { openSse, request } from "../../modules/acute-net";
import type { NetTransport } from "./net";

export const acuteNetTransport: NetTransport = { request, openSse };
