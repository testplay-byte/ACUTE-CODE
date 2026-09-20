/**
 * composer-prefs.ts — the composer's PER-SESSION preferences, persisted
 * through AsyncStorage exactly the way the desktop persists them through
 * localStorage (R113-c mirrors R50's composer-utils keys): the thinking
 * level and the per-send model override survive remounts per session, and
 * the last-used model seeds the NEXT session's default (the desktop's
 * R89-B4 "remember the last used model" directive).
 *
 * Small + honest: unreadable values read as absent (never block the
 * composer), and every write is best-effort (an in-memory value still works
 * when storage refuses).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ModelOverride, ThinkingLevel } from "./composer-state";
import { THINKING_OPTIONS } from "./composer-state";

const thinkingKey = (sessionId: string): string => `acute.composer.thinking.${sessionId}`;
const modelKey = (sessionId: string): string => `acute.composer.model.${sessionId}`;
const LAST_USED_MODEL_KEY = "acute.composer.lastModel";

/** Load the session's persisted thinking level ("default" when absent/invalid). */
export async function loadThinkingLevel(sessionId: string): Promise<ThinkingLevel> {
  try {
    const raw = await AsyncStorage.getItem(thinkingKey(sessionId));
    const parsed = THINKING_OPTIONS.find((t) => t.id === raw);
    return parsed?.id ?? "default";
  } catch {
    return "default";
  }
}

/** Persist the session's thinking level (best-effort). */
export async function saveThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
  try {
    await AsyncStorage.setItem(thinkingKey(sessionId), level);
  } catch {
    /* storage unavailable — the in-memory value still works */
  }
}

/** Load the session's persisted model override (null when absent/malformed). */
export async function loadModelOverride(sessionId: string): Promise<ModelOverride | null> {
  try {
    const raw = await AsyncStorage.getItem(modelKey(sessionId));
    if (raw === null) return null;
    return parseModelOverride(raw);
  } catch {
    return null;
  }
}

/** Persist the session's model override (null removes; best-effort). */
export async function saveModelOverride(
  sessionId: string,
  override: ModelOverride | null,
): Promise<void> {
  try {
    if (override === null) await AsyncStorage.removeItem(modelKey(sessionId));
    else await AsyncStorage.setItem(modelKey(sessionId), JSON.stringify(override));
  } catch {
    /* storage unavailable — the in-memory override still works */
  }
}

/** The globally remembered last-used model (null when absent/malformed) —
 * every model pick updates it; a NEW session starts from it. */
export async function loadLastUsedModel(): Promise<ModelOverride | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_USED_MODEL_KEY);
    if (raw === null) return null;
    return parseModelOverride(raw);
  } catch {
    return null;
  }
}

/** Remember the last-used model globally (the next session's default). */
export async function saveLastUsedModel(override: ModelOverride): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_USED_MODEL_KEY, JSON.stringify(override));
  } catch {
    /* storage unavailable */
  }
}

function parseModelOverride(raw: string): ModelOverride | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { model, providerId } = parsed as Record<string, unknown>;
    if (typeof model !== "string" || model === "") return null;
    if (typeof providerId !== "string" || providerId === "") return null;
    return { model, providerId };
  } catch {
    return null;
  }
}
