import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as tmux from "../lib/tmux.ts";
import { reduce, IDLE, type StateSnapshot } from "../lib/state.ts";

// Extension version, written into the pane's boot marker. Must match
// package.json — test/heal.test.ts enforces the sync.
export const EXT_VERSION = "0.2.7";

export default function agentStatus(pi: ExtensionAPI): void {
  if (!tmux.enabled()) return;
  const paneId = tmux.paneId() ?? "";
  if (!paneId) return;

  let snap: StateSnapshot = IDLE;
  let lastWritten: string | undefined = undefined;
  let bootRollupDone = false;
  // True only while the pane option is KNOWN to hold lastWritten (readback
  // verified). Gates the idle dedup: a failed settle write must be retried
  // by the next idle signal, not absorbed by in-memory belief.
  let lastWriteVerified = false;
  // True while the boot marker carries a write-fail diagnostic; the next
  // verified write restores the plain marker so a single transient tmux
  // blip cannot mislabel the pane for the rest of the session.
  let markerDirty = false;
  // Publishes are serialized: interleaved async handlers (e.g. turn_start
  // and agent_start ~50ms apart) must not interleave setState/getState
  // pairs, or one publish's readback could observe the other's value and
  // forge a write-fail diagnostic.
  let publishing: Promise<void> = Promise.resolve();

  function isIdle(ctx: unknown): boolean {
    const c = ctx as { isIdle?: unknown } | undefined;
    return typeof c?.isIdle === "function" ? (c.isIdle as () => boolean)() : true;
  }

  // On every state transition: write this pane's @agent_state, verify the
  // write stuck, then (on real transitions) recompute the window rollup
  // (green=all working, yellow=mixed, grey=all idle, none=no pi) and write
  // the window-scoped @agent_window_state.
  //
  // Heal semantics (v0.2.7): "working" is ALWAYS rewritten even when the
  // in-memory state already says working, so a cleared or lost pane option
  // self-heals on the next working signal. "idle" is deduped only while the
  // pane option is verified-idle, which absorbs omp/pi double settle fires
  // (agent_end settled + agent_settled) but retries a failed settle write.
  // lastWritten starts undefined so the FIRST publish always writes — this
  // is what re-syncs the pane option after a quit+start cycle in the same
  // extension instance.
  async function publish(next: StateSnapshot): Promise<void> {
    const changed = next.state !== snap.state;
    if (!changed && next.state === "idle" && lastWritten === "idle" && lastWriteVerified) return;
    lastWritten = next.state;
    snap = next;
    await tmux.setState(paneId, snap.state);
    const readBack = await tmux.getState(paneId);
    if (readBack === snap.state) {
      lastWriteVerified = true;
      if (markerDirty) {
        markerDirty = false;
        await tmux.setBootMarker(paneId, `v${EXT_VERSION}`);
      }
    } else {
      // Persist the failure into the boot marker instead of stderr: stray
      // stderr corrupts pi's raw-mode TUI, and omp routes the marker to a
      // place `tmux show-options -p @agent_status_boot` can inspect. The
      // label means "writes suspect" — it covers both failed writes and
      // unreadable/corrupt readbacks.
      lastWriteVerified = false;
      markerDirty = true;
      await tmux.setBootMarker(paneId, `v${EXT_VERSION} write-fail(${readBack ?? "unset"})`);
    }
    if (changed || !bootRollupDone) {
      bootRollupDone = true;
      await tmux.applyRollup(paneId);
    }
  }

  function enqueuePublish(next: StateSnapshot): Promise<void> {
    const run = publishing.then(() => publish(next));
    publishing = run.catch(() => { /* cosmetic: never poison the chain */ });
    return run;
  }

  // Boot marker: proves this instance activated in this pane. Pair with
  // @agent_state when diagnosing a "grey dot while running" report:
  //   marker `vX.Y.Z write-fail(...)` → writes are currently failing
  //   marker set + state unset        → handlers muted after activation
  //   neither set                     → extension never ran, or its very
  //                                     first marker write failed
  void tmux.setBootMarker(paneId, `v${EXT_VERSION}`);

  pi.on("session_start", async (_e, ctx) => {
    // Same-instance restart (/new, /resume): quit cleared the marker, so
    // re-establish it before anything else — the taxonomy above must hold
    // for every session an instance serves.
    void tmux.setBootMarker(paneId, `v${EXT_VERSION}`);
    if (ctx?.hasUI !== true) return;
    // Defensive: clear any session-scoped @agent_window_state (v0.2.0 leftover)
    // so this pane's window-scoped state is authoritative.
    await tmux.clearSessionWindowState(paneId);
    await enqueuePublish(reduce(snap, { type: "session_start", isIdle: isIdle(ctx) }));
  });
  // turn_start fires at the start of each user turn — on omp 18.3.4 ~50ms
  // BEFORE agent_start (verified 2026-09-27); pi ≥0.85 defines the same
  // event. Registering it gives the earliest working signal and an extra
  // heal point on both hosts.
  pi.on("turn_start", async () => { await enqueuePublish(reduce(snap, { type: "agent_start" })); });
  pi.on("agent_start", async () => { await enqueuePublish(reduce(snap, { type: "agent_start" })); });
  // Tool events: already modeled by the reducer since v0.1 but never
  // registered — wire them so tool activity reinforces the working state
  // (and the heal) mid-turn even if a loop-level signal was missed.
  pi.on("tool_execution_start", async (e) => {
    const toolName = typeof e?.toolName === "string" ? e.toolName : "";
    await enqueuePublish(reduce(snap, { type: "tool_execution_start", toolName }));
  });
  pi.on("tool_execution_end", async () => {
    await enqueuePublish(reduce(snap, { type: "tool_execution_end" }));
  });
  // omp never fires agent_settled; its settle signal is agent_end with a
  // willContinue flag ({ willContinue: true } = queued continuation follows).
  // ctx.isIdle() was NOT usable at agent_end on omp ≤18.1 (still false); as
  // of omp 18.3.4 it reads true here, and the payload stays authoritative
  // anyway. pi also fires agent_end (no willContinue key) just before
  // agent_settled — treated as settled; the verified idle dedup absorbs the
  // double-fire.
  pi.on("agent_end", async (e) => {
    // omp adds willContinue at runtime; it is absent from pi's AgentEndEvent
    // type, so narrow via `in` instead of property access.
    const willContinue = typeof e === "object" && e !== null && "willContinue" in e && e.willContinue === true;
    await enqueuePublish(reduce(snap, { type: "agent_end", settled: !willContinue }));
  });
  pi.on("agent_settled", async (_e, ctx) => {
    await enqueuePublish(reduce(snap, { type: "agent_settled", isIdle: isIdle(ctx) }));
  });
  pi.on("session_shutdown", async (e) => {
    const reason = e?.reason ?? "quit";
    if (reason === "quit") {
      // this pi is leaving the window — clear its pane state and recompute rollup.
      // Reset lastWritten so the next session_start publish (e.g. a /new or
      // /resume that fires quit+start in the same extension instance) actually
      // re-writes @agent_state — otherwise publish(IDLE) is deduped (idle===idle)
      // and the pane option stays unset, so the dot silently disappears.
      snap = IDLE;
      lastWritten = undefined;
      bootRollupDone = false;
      lastWriteVerified = false;
      markerDirty = false;
      await tmux.clear(paneId);
      await tmux.applyRollup(paneId);
    } else {
      // reload/new/resume/fork: the extension runtime rebinds; don't clear.
      await enqueuePublish(reduce(snap, { type: "session_shutdown", reason }));
    }
  });
}
