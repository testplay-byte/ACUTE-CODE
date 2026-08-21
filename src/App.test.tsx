// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the app name and the phase marker", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "ACUTE-CODE" })).toBeTruthy();
    expect(screen.getByText("Phase 1 skeleton")).toBeTruthy();
  });
});
