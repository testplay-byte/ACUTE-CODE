/**
 * The app's ONE connection manager — built lazily on first use with the real
 * store, the real native transport, and the real foreground/network triggers.
 * Screens consume it via useLink() (use-link.ts), never directly.
 */

import { hostStore } from "./host-store";
import { ConnectionManager } from "./connection";
import { acuteNetTransport } from "./native-transport";
import { reactNativeTriggers } from "./triggers";

let instance: ConnectionManager | null = null;

export function getLinkManager(): ConnectionManager {
  if (instance === null) {
    instance = new ConnectionManager({
      store: hostStore,
      net: acuteNetTransport,
      triggers: reactNativeTriggers,
    });
  }
  return instance;
}
