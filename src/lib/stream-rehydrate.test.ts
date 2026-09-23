/**
 * ROUND-120 (R120-C-PC, items 37+38 — the sync/state law) stream-store
 * REHYDRATE tests: the live-turn state reconciles with the BACKEND's turn
 * registry (GET /sessions/:id/live → rehydrateLiveTurn), never with "no SSE
 * frames arrived lately".
 *
 * The owner's symptoms these pins exist to kill:
 *  · "a refresh makes everything look finished until the next agent frame
 *    arrives" → live:true + no local liveTurn OPENS a mirror seeded from the
 *    folded log's trailing turn (working entries, the partial streamed text,
 *    the model) with the userText anchor that suppresses the fold's copy —
 *    the WORKING state returns (remoteRunning → the stop affordance), and
 *    the running exchange can never render as two halves;
 *  · "the frontend claims completion while the backend still works" (the
 *    own fetch died; the R42 law keeps the turn alive server-side) → the
 *    DETACH leg flips the frozen failure onto the mirror path, retracting
 *    the false "Generation failed";
 *  · a mirror whose terminal frame was missed (an events-stream reconnect
 *    gap) → live:false RETIRES it, handing the fold the render.
 *
 * Same driving pattern as stream-remote.test.ts: seed the store directly +
 * the queryClient singleton cache for the fold, drive rehydrateLiveTurn,
 * assert on the slices. No network (fetchSessionLive is the caller's job —
 * these tests hand the boolean straight to the reconciler).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { useConfigStore } from "./config-store";
import { setQueryClient } from "./query-client";
import { useStreamStore, clearStreamSessionProjectsForTest, type LiveTurn } from "./stream-store";
import { useActiveStreams } from "./active-streams";
import type { SessionDetail, SessionEvent } from "./api";

const SID = "sess_r120_rehydrate";

function messageEvent(
  seq: number,
  role: "user" | "assistant",
  content: string,
  ts: string,
  extra: Record<string, unknown> = {},
): SessionEvent {
  return {
    seq,
    type: role === "user" ? "message.user" : "message.assistant",
    agentId: "agt_scribe",
    payload: { role, content, agentId: "agt_scribe", ts, ...extra },
    ts,
  };
}

function toolEvent(seq: number, ts: string): SessionEvent {
  return {
    seq,
    type: "tool.use",
    agentId: "agt_scribe",
    payload: { role: "tool", toolName: "write_file", argsSummary: "path: src/a.ts, content: 120 chars", ok: true },
    ts,
  };
}

/** The mid-turn refetch's snapshot: the opener, the in-flight turn's
 * already-persisted events (the trailing OPEN turn), a queued row. */
function runningSessionEvents(): SessionEvent[] {
  return [
    messageEvent(1, "user", "please build the thing", "2026-09-23T10:00:10Z"),
    messageEvent(2, "assistant", "Let me inspect the project first.", "2026-09-23T10:00:20Z", {
      model: "test/folded-model",
    }),
    toolEvent(3, "2026-09-23T10:00:30Z"),
    {
      seq: 4,
      type: "message.queued",
      agentId: "agt_scribe",
      payload: { role: "user", content: "and make it pretty", agentId: "agt_scribe", ts: "2026-09-23T10:00:40Z" },
      ts: "2026-09-23T10:00:40Z",
    },
    messageEvent(5, "assistant", "The file is ready so far.", "2026-09-23T10:00:50Z", {
      model: "test/folded-model",
    }),
  ];
}

/** Seed the ["session","live",SID] cache the rehydrate reads (the panel's
 * refetched folded log). */
function seedSessionCache(events: SessionEvent[]): void {
  const qc = setOrGetQueryClient();
  qc.setQueryData<SessionDetail>(["session", "live", SID], {
    id: SID,
    projectId: null,
    agentId: "agt_scribe",
    mode: "single",
    status: "running",
    title: "R120 rehydrate probe",
    createdAt: "2026-09-23T10:00:00Z",
    updatedAt: "2026-09-23T10:05:00Z",
    parentSessionId: null,
    subRole: null,
    permissionMode: "ask",
    selectedModel: null,
    events,
    lastSeq: events[events.length - 1]?.seq ?? 0,
  } as SessionDetail);
}

let sharedQc: QueryClient | null = null;
function setOrGetQueryClient(): QueryClient {
  if (sharedQc === null) {
    sharedQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setQueryClient(sharedQc);
  }
  return sharedQc;
}

beforeEach(() => {
  useConfigStore.setState({
    baseUrl: "http://sidecar.test",
    token: "tok_123",
    demoData: false,
  });
  sharedQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setQueryClient(sharedQc);
  useStreamStore.setState({ bySession: {}, subagentsLive: {} });
  useActiveStreams.setState({ active: new Set<string>() });
  clearStreamSessionProjectsForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setQueryClient(null as unknown as QueryClient);
});

describe("stream store live-truth rehydrate (ROUND-120 R120-C-PC)", () => {
  it("live:true + no local liveTurn → the mirror OPENS seeded from the fold's trailing turn (working + partial text + model + the userText anchor)", () => {
    seedSessionCache(runningSessionEvents());

    useStreamStore.getState().rehydrateLiveTurn(SID, true);

    const slice = useStreamStore.getState().bySession[SID];
    expect(slice).toBeDefined();
    expect(slice?.remote).toBe(true);
    expect(slice?.streamBusy).toBe(false); // a mirror never owns a fetch
    expect(slice?.liveTurn).not.toBeNull();
    // The fold's trailing turn content rides the mirror: the narration entry,
    // the persisted write_file row, and the partial streamed text.
    const kinds = slice?.liveTurn?.working.map((e) => e.type);
    expect(kinds).toContain("text");
    expect(kinds).toContain("tool");
    const tool = slice?.liveTurn?.working.find((e) => e.type === "tool");
    expect(tool).toMatchObject({ type: "tool", tool: { toolName: "write_file", ok: true } });
    expect(slice?.liveTurn?.streamText).toBe("The file is ready so far.");
    expect(slice?.liveTurn?.model).toBe("test/folded-model");
    // THE ANCHOR (the R119-C interlock input): the last user item's content —
    // while this mirror renders, the fold's copy of the same turn is
    // suppressed (startedBySeq >= anchor), so a refresh mid-turn can never
    // render two halves of the running exchange.
    expect(slice?.liveTurn?.userText).toBe("please build the thing");
    // The queued row past the anchor rides the mirror's queue (the fold's
    // copy drops by seq — exactly one chip).
    expect(slice?.queued).toEqual([
      { seq: 4, content: "and make it pretty", ts: "2026-09-23T10:00:40Z" },
    ]);
    // The sidebar spinner is ON — the working state is back.
    expect(useActiveStreams.getState().active.has(SID)).toBe(true);
  });

  it("live:true twice is IDEMPOTENT — the open mirror renders already; the second call never re-seeds under it", () => {
    seedSessionCache(runningSessionEvents());
    useStreamStore.getState().rehydrateLiveTurn(SID, true);
    const first = useStreamStore.getState().bySession[SID]?.liveTurn;

    // A later poll with the fold REFetched (the events list grew — one more
    // assistant row): the open mirror must NOT be re-seeded backwards.
    const grown = [...runningSessionEvents(), messageEvent(6, "assistant", "More work.", "2026-09-23T10:01:20Z", { model: "test/folded-model" })];
    seedSessionCache(grown);
    useStreamStore.getState().rehydrateLiveTurn(SID, true);

    const second = useStreamStore.getState().bySession[SID]?.liveTurn;
    expect(second).toBe(first); // referentially identical — no re-seed
  });

  it("live:true while an OWN stream runs → NO-OP (the SSE reader owns the render)", () => {
    seedSessionCache(runningSessionEvents());
    useStreamStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [SID]: {
          liveTurn: {
            startedAtMs: Date.now(),
            working: [],
            streamText: "own stream text",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [],
            debugReport: null,
            browserCheckpoint: null,
            retry: null,
            note: null,
          } satisfies LiveTurn,
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: "please build the thing",
          lastLiveEndMs: 0,
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
        },
      },
    }));

    useStreamStore.getState().rehydrateLiveTurn(SID, true);

    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.remote).toBe(false);
    expect(slice?.streamBusy).toBe(true);
    expect(slice?.liveTurn?.streamText).toBe("own stream text");
  });

  it("live:true + a FROZEN failure (the own fetch died, the turn survived server-side) → DETACH: the false error retracts, the slice becomes a mirror anchored by the opener", () => {
    seedSessionCache(runningSessionEvents());
    // The startStream catch+finally shape after a NON-deliberate stream
    // death: liveError armed, the liveTurn frozen stopped (not by user),
    // the optimistic echo still armed (failedUnpersisted keeps it).
    useStreamStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [SID]: {
          liveTurn: {
            startedAtMs: Date.now() - 4000,
            working: [{ type: "text" as const, content: "partial narration", ts: "2026-09-23T10:00:20Z" }],
            streamText: "partial answer",
            streamThinking: "",
            stopped: true,
            stoppedByUser: false,
            streamingToolInputs: [],
            debugReport: null,
            browserCheckpoint: null,
            retry: null,
            note: null,
          } satisfies LiveTurn,
          streamBusy: false,
          sendError: "The stream from the agent ended unexpectedly",
          liveError: {
            code: "NETWORK_ERROR",
            message: "The stream from the agent ended unexpectedly",
            ts: "2026-09-23T10:00:30Z",
          },
          pendingEcho: "please build the thing",
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
        },
      },
    }));

    useStreamStore.getState().rehydrateLiveTurn(SID, true);

    const slice = useStreamStore.getState().bySession[SID];
    // The false failure retracts — the backend is still working.
    expect(slice?.remote).toBe(true);
    expect(slice?.liveError).toBeNull();
    expect(slice?.sendError).toBeNull();
    expect(slice?.liveTurn?.stopped).toBe(false);
    expect(slice?.liveTurn?.stoppedByUser).toBe(false);
    // The detached mirror keeps its accumulated content and gains the
    // interlock anchor (the opening user content the echo held).
    expect(slice?.liveTurn?.streamText).toBe("partial answer");
    expect(slice?.liveTurn?.userText).toBe("please build the thing");
    expect(useActiveStreams.getState().active.has(SID)).toBe(true);
  });

  it("live:false + an open mirror with NO pending retire → the MISSED terminal frame retires the mirror (the fold takes over)", async () => {
    seedSessionCache(runningSessionEvents());
    useStreamStore.getState().rehydrateLiveTurn(SID, true);
    expect(useStreamStore.getState().bySession[SID]?.liveTurn).not.toBeNull();

    // The events-stream reconnect gap ate the terminal frame; the poll's
    // truth read says the turn is over.
    await useStreamStore.getState().rehydrateLiveTurn(SID, false);

    const slice = useStreamStore.getState().bySession[SID];
    expect(slice?.liveTurn).toBeNull();
    expect(slice?.remote).toBe(false);
    expect(slice?.queued).toEqual([]);
    expect(useActiveStreams.getState().active.has(SID)).toBe(false);
  });

  it("live:false with NO mirror → NO-OP (nothing to retire, nothing opened)", () => {
    seedSessionCache(runningSessionEvents());
    useStreamStore.getState().rehydrateLiveTurn(SID, false);
    // The slice may not even exist yet — the resting session is untouched.
    expect(useStreamStore.getState().bySession[SID]).toBeUndefined();
  });

  it("a minimal mirror (cold start before the fold loaded) RE-SEEDS once the fold lands — frames that already landed disqualify the re-seed", () => {
    // Poll #1 ran with an EMPTY cache (the detail query still in flight):
    // the minimal mirror opened — working state visible, no content.
    useStreamStore.getState().rehydrateLiveTurn(SID, true);
    let slice = useStreamStore.getState().bySession[SID];
    expect(slice?.remote).toBe(true);
    expect(slice?.liveTurn?.working).toEqual([]);
    expect(slice?.liveTurn?.streamText).toBe("");
    expect(slice?.liveTurn?.userText).toBeUndefined();

    // The fold lands; the next poll upgrades the mirror with the content +
    // the anchor.
    seedSessionCache(runningSessionEvents());
    useStreamStore.getState().rehydrateLiveTurn(SID, true);
    slice = useStreamStore.getState().bySession[SID];
    expect(slice?.liveTurn?.streamText).toBe("The file is ready so far.");
    expect(slice?.liveTurn?.userText).toBe("please build the thing");
    expect(slice?.liveTurn?.working.length).toBeGreaterThan(0);

    // A frame landed (the events bus caught up): the re-seed is permanently
    // disqualified — the freshest frame wins over any refetch.
    useStreamStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [SID]: {
          ...(s.bySession[SID] as NonNullable<typeof s.bySession[string]>),
          liveTurn: {
            ...(s.bySession[SID]?.liveTurn as LiveTurn),
            streamText: "frame text",
          },
        },
      },
    }));
    seedSessionCache(runningSessionEvents());
    useStreamStore.getState().rehydrateLiveTurn(SID, true);
    expect(useStreamStore.getState().bySession[SID]?.liveTurn?.streamText).toBe("frame text");
  });
});
