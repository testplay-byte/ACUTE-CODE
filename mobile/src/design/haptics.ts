/**
 * haptics.ts — the ONE touch of physical feedback (R1 §6: "approval card
 * slide-up + haptic on decision"). expo-haptics is the SDK-bundled carrier;
 * the wrapper stays fail-open — a haptic is decoration and must never break
 * a decision (unavailable module, missing permission, test environment).
 */

import * as Haptics from "expo-haptics";

/** The decision tap (Approve/Deny) — a light impact, once. */
export async function decisionHaptic(): Promise<void> {
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    // Haptics are decoration — an unavailable engine is never an error.
  }
}
