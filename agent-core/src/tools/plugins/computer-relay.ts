/**
 * ROUND-62 (D8): the LIVE COMPUTER-USE RELAY registry.
 *
 * The browser plugin's `screenshot` action needs the computer-use engine
 * (the ONLY pixel-capture path in the app — the OS screen capture backends)
 * plus its vision relay. The computer-use plugin is SETTINGS-GATED and
 * builds its dispatcher per turn inside createTools; this module is the
 * handshake point: the computer-use plugin registers the LIVE engine when
 * a turn arms it, and the browser plugin borrows it for screen-region
 * captures of the embedded browser panel.
 *
 * Honest failure modes (all fail-closed in the browser tool):
 *  - nothing registered → Computer Use is OFF (Settings → Computer Use);
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
