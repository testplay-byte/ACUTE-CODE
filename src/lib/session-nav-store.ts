import { create } from "zustand";

/**
 * ROUND-115 (R115-E2): the events stream's NAVIGATION bridge — the tiny
 * zustand store handleEventsFrame uses to hand a route to the component
 * layer. The dispatcher (src/lib/events-stream.ts) is deliberately
 * router-free (it is a plain module consumed by tests + the mobile port's
 * own twin), but a device-sourced session-created frame should route the
 * desktop to the phone's new chat — so it deposits the URL HERE, and the
 * AppShell-mounted EventStreamStarter (inside the Router tree, exactly like
 * the Toaster's useNavigate leg) performs the actual navigate().
 *
 * The Toaster precedent (components/notifications/Toaster.tsx openSession):
 * the URL shape is `/project/{projectId}/chat?session={sessionId}`, and a
 * component mounted once in AppShell owns the navigation side-effect. This
 * store is that component's inbox.
 *
 * Transient — never persisted. A fresh Set-of-facts per request: `requestNav`
 * bumps `navSeq` (the consumer's change signal) and stores the URL; state
 * is never cleared — a remounting consumer re-subscribes and only acts on
 * NEW requests (no replay of old intents, no double navigation).
 */
interface SessionNavState {
  /** Monotonic request counter — every bump is ONE navigation intent. */
  navSeq: number;
  /** The most recent intent's in-app route (null before the first). */
  lastNav: { url: string } | null;
  /** Deposit one navigation intent (the dispatcher's only write). */
  requestNav: (url: string) => void;
}

export const useSessionNavStore = create<SessionNavState>((set) => ({
  navSeq: 0,
  lastNav: null,
  requestNav: (url) =>
    set((s) => ({
      navSeq: s.navSeq + 1,
      lastNav: { url },
    })),
}));
