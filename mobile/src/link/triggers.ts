/**
 * triggers.ts — the auto-reconnect wake-up sources (the owner's ruling §1.2:
 * "the phone retries its stored address list whenever the app is foregrounded
 * or the network changes").
 *
 * Kept behind the tiny `ConnectionTriggers` interface so connection.ts stays
 * pure/testable; this file is the only React Native import in the link layer
 * outside the store — the app wires `reactNativeTriggers` in, tests inject
 * fakes.
 *
 * R110 #1c (v0.106.0): the network trigger now reports the REACHABILITY
 * verdict (a boolean) instead of firing blindly on every callback — the
 * debounce + transition gating lives in connection.ts (pure, tested) where
 * the injected clock is available. The foreground wake stays immediate
 * (the owner's ruling; the user is looking at the app).
 */

import { AppState, NativeEventSubscription } from "react-native";
import NetInfo from "@react-native-community/netinfo";

/** What a network event tells the link layer — the reachability verdict. */
export interface NetworkChangeEvent {
  /**
   * NetInfo's internet-reachability read collapsed to one boolean
   * (`isInternetReachable`, falling back to `isConnected`). "unknown"
   * readings are swallowed here — a transient probe of the OS's own state
   * must not fire anything. The debounce + transition gating itself lives
   * in connection.ts (pure, tested) where the injected clock is available.
   */
  reachable: boolean;
}

/** Subscription seam — every method returns its unsubscribe. */
export interface ConnectionTriggers {
  /** Fires when the app returns to the foreground. */
  onForeground(callback: () => void): () => void;
  /** Fires on network changes, carrying the reachability verdict. */
  onNetworkChange(callback: (event: NetworkChangeEvent) => void): () => void;
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
      // "unknown" is a transient OS reading — never a reachability verdict.
      if (state.type === "unknown") return;
      // Every remaining shape carries isConnected; isInternetReachable can
      // still be null while NetInfo re-checks — fall back to the interface's
      // own connected verdict (the "none" shape reads false there).
      const reachable = state.isInternetReachable ?? state.isConnected;
      callback({ reachable });
    });
    return unsub;
  },
};
