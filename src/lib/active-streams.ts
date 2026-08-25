import { create } from "zustand";

/**
 * ROUND-38 (owner: the currently-running session shows a pixelated animation
 * on the right side of its sidebar row to signal activity). AgentChatPanel
 * marks its session active while a turn is in flight (streaming or sync send);
 * the sidebar SessionRow reads this set to render the activity indicator.
 *
 * Transient — never persisted. A Set is used so lookup is O(1); a NEW Set is
 * produced on every change so React's shallow selector re-renders consumers.
 */
interface ActiveStreamsState {
  active: Set<string>;
  start: (sessionId: string) => void;
  stop: (sessionId: string) => void;
}

export const useActiveStreams = create<ActiveStreamsState>((set) => ({
  active: new Set<string>(),
  start: (sessionId) =>
    set((s) => {
      if (s.active.has(sessionId)) return s;
      const next = new Set(s.active);
      next.add(sessionId);
      return { active: next };
    }),
  stop: (sessionId) =>
    set((s) => {
      if (!s.active.has(sessionId)) return s;
      const next = new Set(s.active);
      next.delete(sessionId);
      return { active: next };
    }),
}));
