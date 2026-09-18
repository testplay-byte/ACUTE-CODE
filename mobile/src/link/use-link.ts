/**
 * useLink — the React leg of the connection manager: one subscription per
 * consuming screen, `start()` exactly once per app run, and a stable
 * snapshot object so renders stay cheap. The manager is the single source of
 * truth; this hook only mirrors it.
 */

import { useEffect, useState } from "react";
import { ConnectionManager, ConnectionStatus, LiveInfo, StoredHost } from "./connection";
import { getLinkManager } from "./runtime";

export interface LinkSnapshot {
  link: ConnectionManager;
  /** False until start()'s store read resolved — the router gate waits on this. */
  ready: boolean;
  status: ConnectionStatus;
  host: StoredHost | null;
  live: LiveInfo | null;
  lastSeen: number | null;
  lastFailure: { kind: "network" | "tls"; message: string } | null;
}

export function useLink(): LinkSnapshot {
  const link = getLinkManager();
  const [snapshot, setSnapshot] = useState<LinkSnapshot>(() => readSnapshot(link));

  useEffect(() => {
    // start() is idempotent — the first caller wins, later mounts just sync.
    void link.start().then(() => setSnapshot(readSnapshot(link)));
    const unsubscribe = link.subscribe(() => setSnapshot(readSnapshot(link)));
    return unsubscribe;
  }, [link]);

  return snapshot;
}

function readSnapshot(link: ConnectionManager): LinkSnapshot {
  return {
    link,
    ready: link.isReady(),
    status: link.getStatus(),
    host: link.getHost(),
    live: link.getLiveInfo(),
    lastSeen: link.getLastSeen(),
    lastFailure: link.getLastFailure(),
  };
}
