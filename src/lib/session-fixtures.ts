import type { UsageRecord } from "shared";
import {
  ApiError,
  type CreateSessionInput,
  type SendMessageResult,
  type Session,
  type SessionDetail,
  type SessionEvent,
  type SessionsBackend,
} from "./api";

/**
 * In-memory SessionsBackend used by tests and the "demo data" toggle (sibling
 * of agent-fixtures.ts). Mirrors the sidecar semantics verified against the
 * live Wave 2 routes: synchronous turns with realistic latency, an append-only
 * event log where a failed provider call still leaves the user event in place
 * (ADR-0010), and 502 PROVIDER_ERROR envelopes for upstream failures.
 *
 * Demo affordance: a message starting with "/error" fails the simulated
 * provider call so the error banner + retry affordance are demonstrable
 * without the sidecar.
 */

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

/** Simulated provider latency for a turn; long enough to show the thinking state. */
const REPLY_DELAY_MS = 700;

/** Chat event exactly as appendSessionEvent writes it (payload mirrors agentId + ts). */
function messageEvent(
  seq: number,
  role: "user" | "assistant",
  agentId: string,
  content: string,
  ts: string,
): SessionEvent {
  return {
    seq,
    type: role === "user" ? "message.user" : "message.assistant",
    agentId,
    payload: { role, content, agentId, ts },
    ts,
  };
}

const REPLIES = [
  "On it — I'll gather the relevant context first and come back with findings that name absolute file paths.",
  "Understood. I'll keep the change minimal, follow the workspace rules, and flag anything that needs an owner decision.",
  "Done. The artifact is updated and the acceptance checklist now covers the edge cases you called out.",
  "Here's my read: the riskiest assumption is the one without a test behind it. I'd pin that down before building on top of it.",
];

interface SessionSeed {
  session: Session;
  events: SessionEvent[];
}

const SEED: SessionSeed[] = [
  {
    session: {
      id: "sess_seed_report",
      projectId: null,
      agentId: "agt_scribe",
      mode: "single",
      status: "running",
      title: "Phase 2 report draft",
      createdAt: "2026-08-22T09:14:00Z",
      updatedAt: "2026-08-22T09:31:00Z",
    },
    events: [
      messageEvent(
        1,
        "user",
        "agt_scribe",
        "Draft the Phase 2 acceptance checklist from the plan in docs/runbooks.",
        "2026-08-22T09:14:12Z",
      ),
      messageEvent(
        2,
        "assistant",
        "agt_scribe",
        "Here is the Phase 2 acceptance checklist — 8 items covering the sessions screen, the fixture demo mode, and the verify gate. Every item names its artifact and its pass/fail signal.",
        "2026-08-22T09:14:19Z",
      ),
      messageEvent(
        3,
        "user",
        "agt_scribe",
        "Good. Add open questions at the end, tagged BLOCKING or NON-BLOCKING.",
        "2026-08-22T09:30:02Z",
      ),
      messageEvent(
        4,
        "assistant",
        "agt_scribe",
        "Appended two open questions — one BLOCKING (usage estimation source) and one NON-BLOCKING (empty-state copy). Ready to file under docs/runbooks/phase-2.md.",
        "2026-08-22T09:30:24Z",
      ),
    ],
  },
  {
    session: {
      id: "sess_seed_audit",
      projectId: null,
      agentId: "agt_ui_vision",
      mode: "single",
      status: "completed",
      title: "Audit Agents screen visuals",
      createdAt: "2026-08-21T15:02:00Z",
      updatedAt: "2026-08-21T15:06:30Z",
    },
    events: [
      messageEvent(
        1,
        "user",
        "agt_ui_vision",
        "Walk the Agents screen against the owner's design demos and list any visual regressions.",
        "2026-08-21T15:02:40Z",
      ),
      messageEvent(
        2,
        "assistant",
        "agt_ui_vision",
        "No visual regressions found. Borders, radii, badge tones and the motion curve all match the dashboard demo; one nit — the template badge could be 0.5px larger for parity.",
        "2026-08-21T15:06:30Z",
      ),
    ],
  },
];

interface SessionRow extends SessionSeed {
  /** Rotation cursor for REPLIES so consecutive turns vary. */
  assistantTurns: number;
}

function toDetail(row: SessionRow): SessionDetail {
  return {
    ...row.session,
    events: row.events.map((event) => ({
      ...event,
      payload: { ...(event.payload as Record<string, unknown>) },
    })),
    lastSeq: row.events.length,
  };
}

/** Build an isolated fixture backend; the UI shares a single memoized one. */
export function createFixtureSessions(seed: SessionSeed[] = SEED): SessionsBackend {
  const rows = new Map<string, SessionRow>(
    seed.map((s) => [
      s.session.id,
      {
        session: { ...s.session },
        events: [...s.events],
        // Continue the reply rotation after the seeded history.
        assistantTurns: s.events.filter((e) => e.type === "message.assistant").length,
      },
    ]),
  );

  const ok = <T>(value: T, ms = 10) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  const row = (id: string): SessionRow => {
    const found = rows.get(id);
    if (!found) throw new ApiError(404, "NOT_FOUND", `no session with id ${id}`);
    return found;
  };

  const appendUserEvent = (target: SessionRow, content: string) => {
    target.events.push(
      messageEvent(target.events.length + 1, "user", target.session.agentId ?? "", content, now()),
    );
  };

  return {
    list: () =>
      ok(
        [...rows.values()]
          .map(({ session }) => ({ ...session }))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      ),
    create: (input: CreateSessionInput) => {
      // Fixture sessions keep the live shape: created "queued", no events yet.
      const session: Session = {
        id: uid("sess"),
        projectId: input.projectId ?? null,
        agentId: input.agentId,
        mode: "single",
        status: "queued",
        title: input.title ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      rows.set(session.id, { session, events: [], assistantTurns: 0 });
      return ok({ ...session });
    },
    get: (id) => ok(toDetail(row(id))),
    remove: (id) => {
      // Mirrors DELETE /sessions/:id (round-30): 404 via row() when missing,
      // otherwise the session (and its events, which live on the row) is gone.
      row(id);
      rows.delete(id);
      return ok(undefined, 5);
    },
    sendMessage: (id, content) => {
      const target = row(id);
      // The user event lands before the provider call (ADR-0010): a failed
      // call still leaves the turn's user message in the log.
      appendUserEvent(target, content);

      if (content.trimStart().startsWith("/error")) {
        return new Promise<never>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new ApiError(502, "PROVIDER_ERROR", `provider 'openrouter' call failed for session ${id}`, {
                  providerError: "simulated upstream failure (demo): model overloaded, retry later",
                }),
              ),
            REPLY_DELAY_MS,
          ),
        );
      }

      return new Promise<SendMessageResult>((resolve) => {
        setTimeout(() => {
          if (target.session.status === "queued") target.session.status = "running";
          target.session.updatedAt = now();
          const reply = REPLIES[target.assistantTurns % REPLIES.length];
          target.assistantTurns += 1;
          const ts = now();
          const seq = target.events.length + 1;
          target.events.push(messageEvent(seq, "assistant", target.session.agentId ?? "", reply, ts));
          const usage: UsageRecord = {
            agentId: target.session.agentId ?? "",
            sessionId: id,
            provider: "openrouter",
            model: "openrouter/ox-alpha",
            inputTokens: 88 + Math.floor(Math.random() * 60),
            outputTokens: 26 + Math.floor(Math.random() * 34),
            costUsd: 0,
            ts,
          };
          resolve({
            assistantMessage: {
              seq,
              role: "assistant",
              agentId: target.session.agentId ?? "",
              content: reply,
              ts,
            },
            usage,
          });
        }, REPLY_DELAY_MS);
      });
    },
  };
}

let shared: SessionsBackend | null = null;

/** Memoized instance so toggling demoData off/on keeps demo conversations. */
export function getFixtureSessions(): SessionsBackend {
  shared ??= createFixtureSessions();
  return shared;
}

/** Re-seed the shared demo backend (test isolation / "reset demo data"). */
export function resetFixtureSessions() {
  shared = null;
}
