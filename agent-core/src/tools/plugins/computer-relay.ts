/**
 * ROUND-62 (D8): the LIVE COMPUTER-USE RELAY registry.
 *
 * History: the browser plugin's `screenshot` action used to borrow the
 * computer-use engine through this registry (the ONLY pixel-capture path in
 * the app — the OS screen capture backends) plus its vision relay, which
 * silently made browser screenshots require Settings → Computer Use
 * (DEFAULT OFF) — an unrelated master switch.
 *
 * ROUND-98 (R98-G1): the browser plugin now captures through the STANDALONE
 * getCaptureBackend() (computer/backends/index.ts — same platform backend +
 * runner, no computer-use session/relay/settings gate). This registry is
 * deliberately KEPT (narrowest honest change, per the round's contract):
 * the computer-use plugin still arms it every enabled turn — the registry
 * remains the "a computer-use turn is live" handshake for computer-use-side
 * consumers and for the plugin tests that pin the armed-turn wiring.
 *
 * Honest failure modes (all fail-closed):
 *  - nothing registered → no armed computer-use turn (Computer Use is OFF,
 *    or no tool-bearing turn ran yet);
 *  - registered but capture fails → the OS backend's error surfaces.
 */
import type { CuaBackend, RunCommand } from "../../computer/backends/interface.js";
import type { ComputerSession } from "../../computer/session.js";

/** What the computer-use plugin hands over per armed turn. */
export interface ActiveComputerRelay {
  backend: CuaBackend;
  run: RunCommand;
  session: ComputerSession;
}

let active: ActiveComputerRelay | null = null;

/** Called by the computer-use plugin's createTools when the toolset arms
 *  (enabled + deps present). The registry holds the LATEST armed turn's
 *  engine — browser tools run inside the same turn, so it is current. */
export function setActiveComputerRelay(relay: ActiveComputerRelay): void {
  active = relay;
}

/** The live computer-use engine, or null when Computer Use is OFF. */
export function getActiveComputerRelay(): ActiveComputerRelay | null {
  return active;
}

/** Test hook. */
export function resetActiveComputerRelayForTest(): void {
  active = null;
}
