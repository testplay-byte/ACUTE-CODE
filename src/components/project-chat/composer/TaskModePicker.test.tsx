// @vitest-environment happy-dom
/**
 * ROUND-73 (R73-c) tests — the TASK-MODE picker (the composer's posture
 * pill, ModeSwitcher's sibling). Rendered DIRECTLY (the BrowserCheckpointCard
 * pattern — the component is props-driven; the panel wiring + PATCH
 * round-trip live in AgentChatPanel.test.tsx):
 *
 *  - the pill label: "Mode: Auto" when no mode is active, the mode's NAME
 *    when one is, the raw id while the list is loading (honest fallback);
 *  - the dropdown: "Auto (no mode)" first, one row per mode with its
 *    trigger-rich description clamped to ~2 lines, the current mode
 *    Check-marked, a subtle "custom" chip for source === "file";
 *  - selection reports the id (null for Auto) and closes the menu; the
 *    current mode does not re-fire onChange;
 *  - a11y: aria-haspopup/aria-expanded on the pill, role=menu +
 *    menuitemradio/aria-checked inside (ModeSwitcher's semantics), Escape
 *    dismissal (useDismiss), and the disabled state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { TaskModePicker } from "./TaskModePicker";
import type { TaskModeInfo } from "../../../lib/api";
import { resetTestState } from "../../../test-utils";

/** Four representative modes: three builtins + one .acute/agents/*.md custom. */
const MODES: TaskModeInfo[] = [
  {
    id: "plan",
    name: "Plan",
    description:
      "Use when the user says 'plan this', 'write a spec', 'design before we build' — the deliverable is a decision-ready specification, not code. NOT for executing an approved plan.",
    source: "builtin",
    // R75: the enforced read-only postures carry the flag.
    readOnly: true,
  },
  {
    id: "debug",
    name: "Debug",
    description:
      "Use when the user says 'fix this bug', 'why did this break', 'it stopped working' — reproduce, isolate, one cause per fix. NOT for green-field work.",
    source: "builtin",
  },
  {
    id: "review",
    name: "Review",
    description:
      "Use when the user says 'review this PR', 'look over my changes' — a tiered verdict with file:line evidence. NOT for implementing the changes yourself.",
    source: "builtin",
    readOnly: true,
  },
  {
    id: "security",
    name: "Security",
    description: "A project .acute/agents/security.md custom posture — audits authz, secrets, and injection surface.",
    source: "file",
  },
];

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
});

const pill = (): HTMLElement => screen.getByRole("button", { name: /Task mode/ });

/** Open the pill and wait for the menu (with its rows) to mount. */
async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(pill());
  return await screen.findByRole("menu", { name: "Task mode" });
}

describe("TaskModePicker (ROUND-73 R73-c)", () => {
  it("renders the pill: Compass + 'Mode: Auto' when no mode is active", () => {
    render(<TaskModePicker modes={MODES} activeMode={null} disabled={false} onChange={vi.fn()} />);
    const btn = pill();
    // The accessible name + the visible label both say Auto.
    expect(btn.getAttribute("aria-label")).toBe("Task mode: Auto");
    expect(btn.textContent).toContain("Mode: Auto");
    // The Auto title explains what Auto MEANS (the owner-facing contract).
    expect(btn.getAttribute("title")).toContain("no task mode active");
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the ACTIVE mode's name (label + accessible name + title)", () => {
    render(<TaskModePicker modes={MODES} activeMode="debug" disabled={false} onChange={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Task mode: Debug" });
    expect(btn.textContent).toContain("Debug");
    expect(btn.textContent).not.toContain("Mode: Auto");
    // The title explains the active posture's contract (its description).
    expect(btn.getAttribute("title")).toContain("posture guide rides the agent's system prompt");
    expect(btn.getAttribute("title")).toContain("reproduce, isolate, one cause per fix");
  });

  it("renders the RAW id while the mode list has not loaded it (honest, never 'Auto')", () => {
    // A vanished custom (or the list still in flight): the session row says a
    // mode is active — the pill must not claim Auto.
    render(<TaskModePicker modes={[]} activeMode="security" disabled={false} onChange={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Task mode: security" });
    expect(btn.textContent).toContain("security");
    expect(btn.getAttribute("title")).toContain("no longer in the project's mode list");
  });

  it("R75: menu lists 'Auto (no mode)' FIRST, then every mode — NAMES ONLY; the descriptions ride the rows' title tooltips (hover to reveal)", async () => {
    render(<TaskModePicker modes={MODES} activeMode={null} disabled={false} onChange={vi.fn()} />);
    await openMenu();

    const rows = screen.getAllByRole("menuitemradio");
    expect(rows).toHaveLength(MODES.length + 1); // Auto + every mode
    // Auto is the FIRST row (the clear affordance leads the list).
    expect(rows[0].textContent).toContain("Auto (no mode)");
    // R75 (owner: "by default the description of them should not be shown;
    // only when the user hovers"): the one-line summary is GONE from the
    // row text — it rides the native title tooltip.
    expect(rows[0].textContent).not.toContain("The agent picks its posture");
    expect(rows[0].getAttribute("title")).toBe("No task mode active — the agent picks its posture per request.");

    // Every mode row: the NAME renders, the description does NOT (title only).
    for (const mode of MODES) {
      const row = screen.getByRole("menuitemradio", { name: new RegExp(mode.name) });
      expect(row.textContent).toContain(mode.name);
      expect(row.textContent).not.toContain(mode.description);
      expect(row.getAttribute("title")).toBe(mode.description);
    }
    // Single-line rows: no clamped description element survives.
    const planRow = screen.getByRole("menuitemradio", { name: /Plan/ });
    expect(planRow.querySelector(".line-clamp-2")).toBeNull();
  });

  it("R75: read-only modes (plan/review/explore) carry the ENFORCED read-only badge", async () => {
    render(<TaskModePicker modes={MODES} activeMode={null} disabled={false} onChange={vi.fn()} />);
    await openMenu();
    const planRow = screen.getByRole("menuitemradio", { name: /Plan/ });
    expect(planRow.textContent).toContain("read-only");
    // The badge itself carries the "Enforced" title (the row's title stays
    // the mode description — the hover-reveal text).
    const badge = planRow.querySelector("span[title^='Enforced']") as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("read-only");
    // A mutating mode (debug) carries no badge.
    const debugRow = screen.getByRole("menuitemradio", { name: /Debug/ });
    expect(debugRow.textContent).not.toContain("read-only");
  });

  it("custom modes (source 'file') carry a subtle 'custom' chip — builtins do not", async () => {
    render(<TaskModePicker modes={MODES} activeMode={null} disabled={false} onChange={vi.fn()} />);
    await openMenu();
    const securityRow = screen.getByRole("menuitemradio", { name: /Security/ });
    expect(securityRow.textContent).toContain("custom");
    const debugRow = screen.getByRole("menuitemradio", { name: /Debug/ });
    expect(debugRow.textContent).not.toContain("custom");
  });

  it("the CURRENT mode is Check-marked + aria-checked; selecting a mode reports its id and closes the menu", async () => {
    const onChange = vi.fn();
    render(<TaskModePicker modes={MODES} activeMode="plan" disabled={false} onChange={onChange} />);
    await openMenu();

    // The active row carries the radio state (ModeSwitcher's semantics).
    const planRow = screen.getByRole("menuitemradio", { name: /Plan/ });
    expect(planRow.getAttribute("aria-checked")).toBe("true");
    const debugRow = screen.getByRole("menuitemradio", { name: /Debug/ });
    expect(debugRow.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(debugRow);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Task mode" })).toBeNull());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("debug");
  });

  it("selecting 'Auto (no mode)' reports null — the clear affordance", async () => {
    const onChange = vi.fn();
    render(<TaskModePicker modes={MODES} activeMode="debug" disabled={false} onChange={onChange} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Auto/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("clicking the CURRENT mode does NOT re-fire onChange (ModeSwitcher's no-op guard)", async () => {
    const onChange = vi.fn();
    render(<TaskModePicker modes={MODES} activeMode="debug" disabled={false} onChange={onChange} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Debug/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled: the pill stays closed (aria-expanded false, no menu mounts)", () => {
    render(<TaskModePicker modes={MODES} activeMode={null} disabled={true} onChange={vi.fn()} />);
    const btn = pill();
    expect(btn.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu", { name: "Task mode" })).toBeNull();
  });

  it("a11y + dismissal: aria-expanded flips with the menu; Escape closes it (useDismiss)", async () => {
    render(<TaskModePicker modes={MODES} activeMode={null} disabled={false} onChange={vi.fn()} />);
    const btn = pill();
    fireEvent.click(btn);
    const menu = await screen.findByRole("menu", { name: "Task mode" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(menu.getAttribute("role")).toBe("menu");
    // Escape dismisses (useDismiss's document keydown listener).
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Task mode" })).toBeNull());
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });
});
