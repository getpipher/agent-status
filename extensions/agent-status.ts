import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as tmux from "../lib/tmux.ts";
import { reduce, IDLE, type StateSnapshot } from "../lib/state.ts";

export default function agentStatus(pi: ExtensionAPI): void {
  if (!tmux.enabled()) return;
  const paneId = tmux.paneId() ?? "";
  if (!paneId) return;

  let snap: StateSnapshot = IDLE;
  let lastWritten: string | undefined = undefined;

  function isIdle(ctx: any): boolean {
    return typeof ctx?.isIdle === "function" ? ctx.isIdle() : true;
  }

  // On every state transition: write this pane's @agent_state, then recompute
  // the window rollup (green=all working, yellow=mixed, grey=all idle, none=no
  // pi) and write the window-scoped @agent_window_state. Idle never fires again
  // after settle, so the bar is inert when no agent is working.
  // Dedup against lastWritten (not snap) so the FIRST publish always writes
  // (syncs the pane option to the in-memory state) even if it equals the
  // initial IDLE snapshot.
  async function publish(next: StateSnapshot): Promise<void> {
    if (next.state === lastWritten) return;
    lastWritten = next.state;
    snap = next;
    await tmux.setState(paneId, snap.state);
    await tmux.applyRollup(paneId);
  }

  pi.on("session_start", async (_e, ctx) => {
    if (ctx?.hasUI !== true) return;
    await publish(reduce(snap, { type: "session_start", isIdle: isIdle(ctx) }));
  });
  pi.on("agent_start", async () => { await publish(reduce(snap, { type: "agent_start" })); });
  pi.on("agent_settled", async (_e, ctx) => {
    await publish(reduce(snap, { type: "agent_settled", isIdle: isIdle(ctx) }));
  });
  pi.on("session_shutdown", async (e) => {
    const reason = (e as any)?.reason ?? "quit";
    if (reason === "quit") {
      // this pi is leaving the window — clear its pane state and recompute rollup
      snap = IDLE;
      await tmux.clear(paneId);
      await tmux.applyRollup(paneId);
    } else {
      // reload/new/resume/fork: the extension runtime rebinds; don't clear.
      await publish(reduce(snap, { type: "session_shutdown", reason }));
    }
  });
}