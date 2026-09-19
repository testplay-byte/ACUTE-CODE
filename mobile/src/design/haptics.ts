/**
 * haptics.ts — the touch of physical feedback (DESIGN.md §7). expo-haptics
 * is the SDK-bundled carrier; every wrapper stays fail-open — a haptic is
 * decoration and must never break a decision (unavailable module, missing
 * permission, test environment).
 *
 * The vocabulary (§7): selection on tab/chip taps, success on pair +
 * approve + send, warning on hard errors, light on decisions.
 */

import * as Haptics from "expo-haptics";

/** The selection tap (tab switch, chip select) — the softest tick. */
export async function selectionHaptic(): Promise<void> {
  try {
    await Haptics.selectionAsync();
  } catch {
    // Haptics are decoration — an unavailable engine is never an error.
  }
}

/** The decision tap (Approve/Deny) — a light impact, once. */
export async function decisionHaptic(): Promise<void> {
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    // Haptics are decoration — an unavailable engine is never an error.
  }
}

/** The success event (pairing landed, message sent) — the notify pattern. */
export async function successHaptic(): Promise<void> {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    // Haptics are decoration — an unavailable engine is never an error.
  }
}

/** The hard-error event (pairing failed, stream lost) — the warning buzz. */
export async function warningHaptic(): Promise<void> {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  } catch {
    // Haptics are decoration — an unavailable engine is never an error.
  }
}
