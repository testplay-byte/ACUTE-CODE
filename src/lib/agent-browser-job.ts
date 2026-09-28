/**
 * ROUND-132 (R132-CU2): the SHARED R94-F evalJob protocol — one job runner,
 * two consumers (the mounted BrowserPanel's bridge handler and the AGENT
 * DESK's 'popout' answers in agent-browser-bridge.ts).
 *
 * The protocol verbatim from the BrowserPanel (R89-E/R94-F/R128-W7a): the
 * TINY hands script starts the async job (window.__acuteJob — the
 * human-paced animation runs in the page BEYOND the Rust eval's 3s callback
 * budget) and returns {started:true} at once; the runner then polls the
 * job's state every 120ms and answers with the final result — each poll is
 * its own short eval, so no Rust changes are needed. The start phase is
 * SELF-HEALING BY CONSTRUCTION:
 *   · {needInstall:true} → eval the installer once (12s timeout, verify
 *     {installed:true}) → re-run the start;
 *   · an UNEXPECTED payload → poll window.__acuteJob ONCE first (the job
 *     may actually have started while the reply was mangled — recover it),
 *     else retry the start once (with install if it asks);
 *   · a TIMED-OUT start eval → the same one-shot recovery;
 *   · only then the honest failure — INCLUDING the received payload, so
 *     the next field report pinpoints the transport quirk exactly.
 * Nothing is cached across navigations: a fresh page context simply
 * reports needInstall again and the flow re-runs.
 *
 * The evals ride `nativeTabEval(tabId, …)` — the Rust side resolves the
 * webview by its globally-unique label, so this works for a PANEL tab (the
 * webview is a child of the main window) AND for the desk/pop-out tab (the
 * webview is a child of the pop-out window) alike.
 */
import { nativeTabEval } from "./native-browser";
import type { BrowserCommandReply } from "./agent-browser-bridge";

/** One page-job state ({done,error,result}) → the final reply, or "live"
 * when the job is still running (keep polling). */
type JobState = { done?: unknown; error?: unknown; result?: unknown };

function readJobState(value: unknown): { reply: BrowserCommandReply } | "live" {
  const state = (value ?? {}) as JobState;
  if (typeof state.error === "string" && state.error !== "") {
    return { reply: { ok: false, error: `the page job failed: ${state.error}` } };
  }
  if (state.done === true) {
    return { reply: { ok: true, data: { ok: true, value: state.result ?? null } } };
  }
  return "live";
}

/** withTimeout — the R91-B3 shape the install leg bounds itself with. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Run ONE evalJob command to completion. `tabId` is the webview's tab id
 * (a panel tab or the desk's fixed 'popout'); `script` is the TINY start
 * script; `installScript` is the one-time hands-runtime installer (may be
 * "" when the caller carries none — then a needInstall answer is the honest
 * dead end, not a crash).
 */
export async function runEvalJobProtocol(
  tabId: string,
  script: string,
  installScript: string,
): Promise<BrowserCommandReply> {
  const POLL_MS = 120;
  // R90-D1: 60s — the human-paced jobs grew (tap → ~1s → typing at ~150 WPM
  // → ~1s → Enter; a full 600-char type is ~48s of typing alone). The
  // agent-core sidecar's outer round-trip budget is 75s.
  const JOB_BUDGET_MS = 60_000;

  const pollJob = async (): Promise<BrowserCommandReply> => {
    const deadline = Date.now() + JOB_BUDGET_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const poll = await nativeTabEval(
        tabId,
        "return window.__acuteJob ? {done: window.__acuteJob.done, error: (window.__acuteJob.error || null), result: (window.__acuteJob.result === undefined ? null : window.__acuteJob.result)} : {done: true, error: 'the job vanished (the page navigated away)'};",
      );
      if (poll === null) {
        return { ok: false, error: "evalJob poll unavailable — the native browser bridge is not present" };
      }
      if (!poll.ok) {
        return { ok: false, error: poll.error ?? "the job state poll failed" };
      }
      const state = readJobState(poll.value);
      if (state !== "live") return state.reply;
      if (Date.now() > deadline) {
        return { ok: false, error: "the page job timed out (60s — the page may be wedged)" };
      }
    }
  };

  /** The R94-F recovery probe: did a job actually start under the
   * mangled/lost start reply? A confirmed job (done OR live) is recovered;
   * null means "no job — retry the start". */
  const probeJob = async (): Promise<BrowserCommandReply | null> => {
    const probe = await nativeTabEval(
      tabId,
      "return (window.__acuteJob ? {exists: true, done: window.__acuteJob.done, error: (window.__acuteJob.error || null), result: (window.__acuteJob.result === undefined ? null : window.__acuteJob.result)} : {exists: false});",
    );
    if (probe === null || !probe.ok) return null; // can't confirm — treat as none
    const probed = (probe.value ?? {}) as { exists?: unknown };
    if (probed.exists !== true) return null;
    const state = readJobState(probe.value);
    if (state !== "live") return state.reply; // already done (or failed) — the answer
    return pollJob(); // live — the normal polling flow takes over
  };

  // ── the start phase (at most 3 start evals + 1 install) ──────────────
  let starts = 0;
  let installRan = false;
  for (;;) {
    starts += 1;
    const start = await nativeTabEval(tabId, script);
    if (start === null) {
      return { ok: false, error: "evalJob unavailable — the native browser bridge is not present" };
    }
    if (!start.ok) {
      const message = start.error ?? "the page rejected the hands script";
      // A timed-out start eval gets the same one-shot recovery (the job may
      // have started while the reply was lost).
      if (/timed out/i.test(message) && starts < 2) {
        const recovered = await probeJob();
        if (recovered !== null) return recovered;
        continue; // ONE retry
      }
      return { ok: false, error: message };
    }
    const value = (start.value ?? {}) as { started?: unknown; needInstall?: unknown; error?: unknown };
    if (typeof value.error === "string" && value.error !== "") {
      return { ok: false, error: value.error };
    }
    if (value.started === true) return pollJob();
    if (value.needInstall === true) {
      if (installRan) {
        return {
          ok: false,
          error: `evalJob: the runtime install did not take (the start still reports needInstall) — got: ${JSON.stringify(value).slice(0, 200)}`,
        };
      }
      if (installScript === "") {
        return {
          ok: false,
          error:
            "evalJob: the page reports the hands runtime missing, but this command carries no installScript (the agent-core sidecar is older than this app — restart it and retry)",
        };
      }
      // The ONE-TIME install — the same nativeTabEval path, bounded.
      const install = await withTimeout(nativeTabEval(tabId, installScript), 12_000, "the hands runtime install");
      if (install === null) {
        return { ok: false, error: "evalJob install unavailable — the native browser bridge is not present" };
      }
      if (!install.ok) {
        return { ok: false, error: install.error ?? "the page rejected the runtime installer" };
      }
      const installed = (install.value ?? {}) as { installed?: unknown };
      if (installed.installed !== true) {
        return {
          ok: false,
          error: `evalJob: the runtime installer did not report {installed:true} — got: ${JSON.stringify(install.value ?? null).slice(0, 200)}`,
        };
      }
      installRan = true;
      continue; // re-run the start once (the runtime is now in the page)
    }
    // ── R128-W7a (the belt): a NULL start value is the OLD-FORMAT ──
    // script shape from an OLDER agent-core sidecar — the Rust
    // browser_tab_eval wrap turns the script into a function BODY, so a
    // bare IIFE expression statement's value is discarded and the envelope
    // answers value:null (the {needInstall}/{started} handshake can never
    // arrive through that shape). Probe the job once — a job that started
    // anyway is recovered — then retry the start once before the honest
    // error below.
    if ((start.value === null || start.value === undefined) && starts < 2) {
      const recovered = await probeJob();
      if (recovered !== null) return recovered;
      continue; // one retry (with install if the retry asks for it)
    }
    // UNEXPECTED start payload — the owner's exact v0.91.0 failure.
    if (starts < 2) {
      const recovered = await probeJob();
      if (recovered !== null) return recovered;
      continue; // one retry (with install if the retry asks for it)
    }
    // R128-W7a: report the value the envelope ACTUALLY carried — `null`
    // for the discarded-value shapes (JSON.stringify(undefined) is not a
    // string, so both nullish cases render as "null").
    const gotRaw = JSON.stringify(start.value);
    const got = typeof gotRaw === "string" ? gotRaw.slice(0, 200) : "null";
    return {
      ok: false,
      error: `evalJob: unexpected start payload (no job started) — got: ${got}`,
    };
  }
}
