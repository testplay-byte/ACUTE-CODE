/**
 * onboarding.ts — the first-run wizard's persistence (R109: "On the very
 * first startup it should go through the setup wizard, ask for all the
 * permissions needed, and then lead to the default home page").
 *
 * ONE flag, honestly stored: acute.onboarding.done = "1". The wizard's
 * connect step is optional (the hub is reachable any time) — completing the
 * wizard means "never show it again", nothing more.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { mobLog } from "@/lib/log";

const ONBOARDING_KEY = "acute.onboarding.done";

/** True when the wizard has been completed (the gate routes past it). */
export async function isOnboarded(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ONBOARDING_KEY)) === "1";
  } catch {
    // A failed read shows the wizard again — the honest default for a
    // first-run gate (better one extra welcome than a skipped setup).
    return false;
  }
}

/** Complete the wizard (the gate never shows it again). */
export async function completeOnboarding(): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_KEY, "1");
    mobLog("onboarding", "completed");
  } catch {
    // Persistence failure is logged honestly; the in-memory decision still
    // routes to the app (the wizard will show once more — acceptable).
    mobLog("onboarding", "completion persist failed");
  }
}

/** Reset (the settings' "replay the setup wizard" affordance). */
export async function resetOnboarding(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ONBOARDING_KEY);
    mobLog("onboarding", "reset");
  } catch {
    mobLog("onboarding", "reset persist failed");
  }
}
