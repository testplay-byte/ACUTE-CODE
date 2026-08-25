import { create } from "zustand";

/**
 * ROUND-39: a tiny event bus for cross-component UI requests in the chat
 * route. The right sidebar's quick-menu "File" option needs to open the
 * AgentChatPanel's CommandPalette — but the palette lives inside the panel,
 * not the sidebar. Rather than thread a callback through props (the panel is
 * keyed by project.id so refs are awkward), this store lets the sidebar
 * "request" the file picker and the panel subscribe.
 *
 * A counter (not a boolean) is used so multiple consecutive requests each
 * fire — a Set/boolean would coalesce identical rapid requests.
 */
interface RightSidebarEventsState {
  filePickerRequest: number;
  requestFilePicker: () => void;
  /** For completeness: the close-other-panels events can land here too. */
  terminalFocusRequest: number;
  requestTerminalFocus: () => void;
}

export const useRightSidebarEvents = create<RightSidebarEventsState>((set) => ({
  filePickerRequest: 0,
  requestFilePicker: () =>
    set((s) => ({ filePickerRequest: s.filePickerRequest + 1 })),
  terminalFocusRequest: 0,
  requestTerminalFocus: () =>
    set((s) => ({ terminalFocusRequest: s.terminalFocusRequest + 1 })),
}));
