// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { SetupWizard } from "./SetupWizard";
import { useOnboardingStore } from "./onboarding-store";
import { THEMES } from "../../lib/themes";

// Vitest globals are off, so RTL's auto-cleanup does not hook in.
afterEach(cleanup);

// The wizard store is module-level; reset it (and the first-run flag) so each
// test starts the machine from Welcome.
beforeEach(() => {
  localStorage.clear();
  useOnboardingStore.setState({
    step: 0,
    brainChoice: "now",
    providerId: "",
    baseUrl: "",
    apiKey: "",
    showApiKey: false,
    modelId: "",
    showModelDropdown: false,
    contextWindow: 100000,
    contextManual: false,
    maxOutput: 8192,
    temperature: 0.7,
    inputCost: 2.5,
    outputCost: 10,
    reasoning: "med",
  });
});

function renderWizard() {
  // Fresh QueryClient per render: no retry (the sidecar is unreachable here),
  // no cross-test cache. Providers query fails gracefully -> selector shows
  // its offline hint on the PlugBrain step.
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/setup"]}>
        <SetupWizard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Setup wizard", () => {
  it("renders step 0 (Welcome) with Header/Footer chrome", () => {
    renderWizard();
    expect(screen.getByText("WELCOME TO")).toBeTruthy();
    expect(screen.getByText("Get Started")).toBeTruthy();
    expect(screen.getAllByText(/ACUTE-CODE • CRAFTED WITH/).length).toBeGreaterThan(0);
  });

  it("advances to PickFlavor and renders one card per THEMES entry", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(screen.getByText("Pick your flavor.")).toBeTruthy();
    for (const t of THEMES) {
      expect(screen.getByText(t.name)).toBeTruthy();
    }
    expect(screen.getByText("New themes coming soon")).toBeTruthy();
  });

  it("reaches NeedBrain and 'Skip to Finish' lands on AllSet", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText("Need a brain?")).toBeTruthy();
    // Choose "I'll do it later", then take the skip exit.
    fireEvent.click(screen.getByRole("button", { name: /do it later/i }));
    fireEvent.click(screen.getByRole("button", { name: /skip to finish/i }));
    expect(screen.getByText("You're all set!")).toBeTruthy();
    // Completion/dismissal sets the first-run flag.
    expect(localStorage.getItem("acute.setupDone")).toBe("1");
  });
});
