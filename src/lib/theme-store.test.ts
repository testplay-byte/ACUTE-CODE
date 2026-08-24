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
    });
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
