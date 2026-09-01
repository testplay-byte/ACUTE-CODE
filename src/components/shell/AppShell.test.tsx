// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { AppShell } from "./AppShell";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

/**
 * R60-C — AppShell's sidebar visibility is the GLOBAL appSidebarVisible
 * store flag: one control on EVERY route (the Tauri title-bar identity
 * button; the floating Acute logo in web dev mode). These tests run WITHOUT
 * `window.__TAURI__` — exactly browser dev mode — so isTauri() is false and
 * the floating logo fallback is the exercised affordance.
 */

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  // The store is module-level and shared across tests in this file — pin the
  // R60-C default so a flipped flag can never leak between cases.
  useProjectChatStore.setState({ appSidebarVisible: true });
});

function renderShell(route: string) {
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<div>dashboard stub</div>} />
        <Route path="project/:id/chat" element={<div>chat stub</div>} />
        <Route path="usage" element={<div>usage stub</div>} />
        <Route path="settings" element={<div>settings stub</div>} />
      </Route>
    </Routes>,
    { route },
  );
}

describe("AppShell sidebar visibility (R60-C — global appSidebarVisible)", () => {
  it("renders the sidebar on the CHAT route while appSidebarVisible is true — the old auto-hide is gone", () => {
    renderShell("/project/prj_x/chat");
    expect(screen.getByRole("complementary", { name: "Main sidebar" })).toBeTruthy();
    // No floating fallback while the sidebar is visible.
    expect(screen.queryByRole("button", { name: "Acute — show sidebar" })).toBeNull();
  });

  it("appSidebarVisible=false removes the whole sidebar (any route) and shows the WEB-mode floating logo", () => {
    useProjectChatStore.setState({ appSidebarVisible: false });
    renderShell("/");
    expect(screen.queryByRole("complementary", { name: "Main sidebar" })).toBeNull();
    expect(screen.queryByText("Navigation")).toBeNull();
    // Web dev mode (no __TAURI__): the floating Acute logo is the fallback.
    expect(screen.getByRole("button", { name: "Acute — show sidebar" })).toBeTruthy();
  });

  it("clicking the floating Acute logo brings the sidebar back and the fallback disappears", () => {
    useProjectChatStore.setState({ appSidebarVisible: false });
    renderShell("/");
    fireEvent.click(screen.getByRole("button", { name: "Acute — show sidebar" }));
    expect(screen.getByRole("complementary", { name: "Main sidebar" })).toBeTruthy();
    expect(screen.getByText("Navigation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Acute — show sidebar" })).toBeNull();
  });
});
