// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { THEMES, applyTheme, useThemeStore } from "./theme-store";

function reset() {
  localStorage.clear();
  useThemeStore.setState({
    themeId: "nova",
    mode: "dark",
    density: "comfortable",
    sidebarTint: "subtle",
    activityMode: "detailed",
    chatTextSize: "medium",
    timestampsMode: "hidden",
  });
}

beforeEach(reset);

describe("theme store", () => {
  it("defaults to nova dark", () => {
    const { themeId, mode } = useThemeStore.getState();
    expect(themeId).toBe("nova");
    expect(mode).toBe("dark");
  });

  it("toggleMode flips light/dark", () => {
    useThemeStore.getState().toggleMode();
    expect(useThemeStore.getState().mode).toBe("light");
    useThemeStore.getState().toggleMode();
    expect(useThemeStore.getState().mode).toBe("dark");
  });

  it("setTheme switches to a catalog theme", () => {
    useThemeStore.getState().setTheme("bento");
    expect(useThemeStore.getState().themeId).toBe("bento");
  });

  it("persists theme and mode to localStorage (zustand persist)", () => {
    useThemeStore.getState().setTheme("bento");
    useThemeStore.getState().setMode("light");
    const raw = localStorage.getItem("acute-code.theme");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state).toEqual({
      themeId: "bento",
      mode: "light",
      density: "comfortable",
      sidebarTint: "subtle",
      activityMode: "detailed",
      chatTextSize: "medium",
      timestampsMode: "hidden",
    });
  });

  // R97-H: the chat customizability pair — text size + timestamps.
  it("defaults to medium text + hidden timestamps (the pre-R97 look)", () => {
    const s = useThemeStore.getState();
    expect(s.chatTextSize).toBe("medium");
    expect(s.timestampsMode).toBe("hidden");
  });

  it("setChatTextSize / setTimestampsMode flip and persist", () => {
    useThemeStore.getState().setChatTextSize("large");
    useThemeStore.getState().setTimestampsMode("hover");
    expect(useThemeStore.getState().chatTextSize).toBe("large");
    expect(useThemeStore.getState().timestampsMode).toBe("hover");
    const raw = JSON.parse(localStorage.getItem("acute-code.theme")!);
    expect(raw.state.chatTextSize).toBe("large");
    expect(raw.state.timestampsMode).toBe("hover");
  });

  it("applyTheme mirrors the store onto the document element", () => {
    applyTheme("bento", "light");
    expect(document.documentElement.dataset.theme).toBe("bento");
    expect(document.documentElement.dataset.mode).toBe("light");
  });

  it("catalog has at least two accent themes including nova", () => {
    expect(THEMES.map((t) => t.id)).toContain("nova");
    expect(THEMES.length).toBeGreaterThanOrEqual(2);
  });
});
