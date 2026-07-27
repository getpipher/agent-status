import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as tmux from "../lib/tmux.ts";
import { createSpinner } from "../lib/spinner.ts";
import { reduce, IDLE, type StateSnapshot } from "../lib/state.ts";

export default function agentStatus(pi: ExtensionAPI): void {
  if (!tmux.enabled()) return;
  const pane = tmux.paneId();
  if (!pane) return;

  let snap: StateSnapshot = IDLE;
  const spinner = createSpinner();

  function isIdle(ctx: any): boolean {
    return typeof ctx?.isIdle === "function" ? ctx.isIdle() : true;
  }

  // Called on every state transition. Writes pane-local options, advances the
  // spinner frame while working, and refreshes the status line (throttled ≤2/s).
  // While idle this is never called again after the final settle, so the bar is
  // inert — byte-identical to a machine without the extension.
  async function publish(next: StateSnapshot): Promise<void> {
    if (next.state === snap.state && next.tool === snap.tool) return;
    snap = next;
    await tmux.setState(pane, snap.state, snap.tool);
    if (snap.state === "working") {
      await tmux.setSpinner(pane, spinner.advance());
    } else {
      spinner.reset();
    }
    await tmux.refreshStatus(pane); // throttled; no-op if within REFRESH_MIN_MS
  }

  pi.on("session_start", async (_e, ctx) => {
    if (ctx?.hasUI !== true) return;
    await publish(reduce(snap, { type: "session_start", isIdle: isIdle(ctx) }));
  });
  pi.on("agent_start", async () => {
    await publish(reduce(snap, { type: "agent_start" }));
  });
  pi.on("tool_execution_start", async (e) => {
    await publish(reduce(snap, { type: "tool_execution_start", toolName: (e as any)?.toolName ?? "" }));
  });
  pi.on("tool_execution_end", async () => {
    await publish(reduce(snap, { type: "tool_execution_end" }));
  });
  pi.on("agent_settled", async (_e, ctx) => {
    await publish(reduce(snap, { type: "agent_settled", isIdle: isIdle(ctx) }));
  });
  pi.on("session_shutdown", async (e) => {
    const reason = (e as any)?.reason ?? "quit";
    if (reason === "quit") {
      spinner.reset();
      await tmux.clear(pane);
      snap = IDLE;
    } else {
      // reload/new/resume/fork: the extension runtime rebinds; don't clear.
      await publish(reduce(snap, { type: "session_shutdown", reason }));
    }
  });
}