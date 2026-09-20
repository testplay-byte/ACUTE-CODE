// @vitest-environment happy-dom
/**
 * ROUND-114 (R114-e) composer-utils tests — the session's DISPLAY model
 * ladder (resolveSessionModelDisplay), the fix for the owner's "the phone
 * showed Auto while the PC had a model selected":
 *
 *   1. loadModelOverride(sessionId) — this device's per-session pick
 *      (localStorage) always wins tier 1;
 *   2. session.selectedModel — the SERVER's cross-device truth (a phone-side
 *      PATCH /sessions/:id {model} rides the meta frame's immediate
 *      invalidation into the refetched row) seeds the display when no local
 *      override exists;
 *   3. loadLastUsedModel() — the global remember-my-last-pick default
 *      (R89-B4) when neither tier answers.
 *
 * Pure display-level resolution over localStorage — no React, no network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadLastUsedModel,
  loadModelOverride,
  resolveSessionModelDisplay,
  saveLastUsedModel,
  saveModelOverride,
} from "./composer-utils";

beforeEach(() => {
  localStorage.clear();
});

describe("resolveSessionModelDisplay (ROUND-114 R114-e — the display ladder)", () => {
  it("tier 1 wins: a persisted localStorage override beats BOTH the server pair and the last-used default", () => {
    saveModelOverride("sess_1", { providerId: "zai", model: "z-ai/glm-4.7" });
    saveLastUsedModel({ providerId: "openrouter", model: "z-ai/glm-5.2:free" });

    expect(
      resolveSessionModelDisplay("sess_1", { providerId: "openrouter", model: "openai/gpt-4o" }),
    ).toEqual({ providerId: "zai", model: "z-ai/glm-4.7" });
    // A local pick made on THIS device keeps displaying what this device
    // picked — the session row's pair never overwrites it.
    expect(resolveSessionModelDisplay("sess_1", null)).toEqual({
      providerId: "zai",
      model: "z-ai/glm-4.7",
    });
  });

  it("tier 2: session.selectedModel seeds the display when NO local override exists (the phone's pick lands)", () => {
    saveLastUsedModel({ providerId: "openrouter", model: "z-ai/glm-5.2:free" });

    expect(
      resolveSessionModelDisplay("sess_2", { providerId: "zai", model: "z-ai/glm-4.7" }),
    ).toEqual({ providerId: "zai", model: "z-ai/glm-4.7" });
  });

  it("tier 2 clears to tier 3: selectedModel null (agent default) falls through to the last-used default", () => {
    saveLastUsedModel({ providerId: "openrouter", model: "z-ai/glm-5.2:free" });

    expect(resolveSessionModelDisplay("sess_2", null)).toEqual({
      providerId: "openrouter",
      model: "z-ai/glm-5.2:free",
    });
  });

  it("tier 3: no override, no server pair, no last-used → null (the agent-default send)", () => {
    expect(resolveSessionModelDisplay("sess_3", null)).toBeNull();
    expect(resolveSessionModelDisplay("sess_3", undefined)).toBeNull();
  });

  it("no session yet (null id): the override tier is skipped, the server pair still seeds", () => {
    saveLastUsedModel({ providerId: "openrouter", model: "z-ai/glm-5.2:free" });

    // Pre-session seeding: a project-scoped row can still carry the pair.
    expect(
      resolveSessionModelDisplay(null, { providerId: "zai", model: "z-ai/glm-4.7" }),
    ).toEqual({ providerId: "zai", model: "z-ai/glm-4.7" });
    expect(resolveSessionModelDisplay(null, null)).toEqual({
      providerId: "openrouter",
      model: "z-ai/glm-5.2:free",
    });
  });

  it("an EMPTY-string pair (a half-written row) never seeds — it falls through honestly", () => {
    saveLastUsedModel({ providerId: "openrouter", model: "z-ai/glm-5.2:free" });

    expect(
      resolveSessionModelDisplay("sess_4", { providerId: "", model: "z-ai/glm-4.7" }),
    ).toEqual({ providerId: "openrouter", model: "z-ai/glm-5.2:free" });
    expect(
      resolveSessionModelDisplay("sess_4", { providerId: "zai", model: "" }),
    ).toEqual({ providerId: "openrouter", model: "z-ai/glm-5.2:free" });
  });

  it("a MALFORMED localStorage override (tier 1 corrupted) falls through to the server pair, never crashes", () => {
    localStorage.setItem("acute-model:sess_5", JSON.stringify({ model: 42 }));
    saveLastUsedModel({ providerId: "openrouter", model: "z-ai/glm-5.2:free" });

    expect(
      resolveSessionModelDisplay("sess_5", { providerId: "zai", model: "z-ai/glm-4.7" }),
    ).toEqual({ providerId: "zai", model: "z-ai/glm-4.7" });
    // loadModelOverride itself reads the corruption as null.
    expect(loadModelOverride("sess_5")).toBeNull();
    expect(loadLastUsedModel()).toEqual({ providerId: "openrouter", model: "z-ai/glm-5.2:free" });
  });
});
