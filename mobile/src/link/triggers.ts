/**
 * triggers.ts — the auto-reconnect wake-up sources (the owner's ruling §1.2:
 * "the phone retries its stored address list whenever the app is foregrounded
 * or the network changes").
 *
 * Kept behind the tiny `ConnectionTriggers` interface so connection.ts stays
 * pure/testable; this file is the only React Native import in the link layer
 * outside the store — the app wires `reactNativeTriggers` in, tests inject
 * fakes.
 */

import { AppState, NativeEventSubscription } from "react-native";
import NetInfo from "@react-native-community/netinfo";

/** Subscription seam — every method returns its unsubscribe. */
export interface ConnectionTriggers {
  /** Fires when the app returns to the foreground. */
  onForeground(callback: () => void): () => void;
  /** Fires when the device's network changes (wifi ↔ cellular ↔ none). */
  onNetworkChange(callback: () => void): () => void;
}

/**
 * The real triggers. NetInfo's "unknown" state is ignored (a transient
 * reading must not fire a spurious probe), and AppState's non-active states
 * are likewise filtered — foreground means ACTIVE.
 */
export const reactNativeTriggers: ConnectionTriggers = {
  onForeground(callback) {
    const sub: NativeEventSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") callback();
    });
    return () => sub.remove();
  },

  onNetworkChange(callback) {
    const unsub = NetInfo.addEventListener((state) => {
      if (state.type !== "unknown") callback();
    });
    return unsub;
  },
};
