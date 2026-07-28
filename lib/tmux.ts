import { spawn } from "node:child_process";

export type AgentState = "working" | "idle";
export type WindowRollup = "working" | "mixed" | "idle" | null;

// --- Exec seam ---------------------------------------------------------------
export type ExecFn = (args: string[]) => Promise<string>;
let exec: ExecFn = defaultTmuxExec;
export function setExec(fn: ExecFn): void { exec = fn; }

export async function defaultTmuxExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`tmux ${args.join(" ")} exited ${code}`))));
    p.on("error", reject);
  });
}

// --- Env guards (injectable for tests) ----------------------------------------
let paneFn: () => string | undefined = () => process.env.TMUX_PANE;
let herdrFn: () => boolean = () => process.env.HERDR_ENV === "1";
let tmuxEnvFn: () => string | undefined = () => process.env.TMUX;

export function setGuards(
  pane?: () => string | undefined,
  herdr?: () => boolean,
  tmuxEnv?: () => string | undefined,
): void {
  if (pane) paneFn = pane;
  if (herdr) herdrFn = herdr;
  if (tmuxEnv) tmuxEnvFn = tmuxEnv;
}

export function enabled(): boolean {
  return !!tmuxEnvFn() && !!paneFn() && !herdrFn();
}
export function paneId(): string | undefined { return paneFn(); }

// --- Fail-safe runner: no-op when disabled, swallow on error ------------------
async function run(args: string[]): Promise<void> {
  if (!enabled()) return;
  try { await exec(args); } catch { /* cosmetic — never throw into pi */ }
}

// Per-pane state: write pane-local @agent_state. Read by the window rollup.
export async function setState(pane: string, state: AgentState): Promise<void> {
  await run(["set-option", "-p", "-t", pane, "@agent_state", state]);
}

export async function clear(pane: string): Promise<void> {
  await run(["set-option", "-p", "-u", "-t", pane, "@agent_state"]);
}

// --- Window rollup ------------------------------------------------------------
// Aggregate @agent_state across every pane in the pane's window:
//   any working + any idle → "mixed"
//   all working            → "working"
//   all idle               → "idle"
//   none set (no pi)       → null
async function windowId(pane: string): Promise<string | undefined> {
  if (!enabled()) return undefined;
  try { return (await exec(["display-message", "-p", "-t", pane, "#{window_id}"])).trim(); }
  catch { return undefined; }
}

async function sessionName(pane: string): Promise<string | undefined> {
  if (!enabled()) return undefined;
  try { return (await exec(["display-message", "-p", "-t", pane, "#{session_name}"])).trim(); }
  catch { return undefined; }
}

// Defensive: clear any SESSION-scoped @agent_window_state so the window-scoped
// value (set by setWindowState with -w) is authoritative. v0.2.0 set this at
// session scope; v0.2.1+ (with -w) doesn't write session scope but also didn't
// clear leftovers, causing "dots on all windows" for upgraders from v0.2.0.
// Called on session_start.
export async function clearSessionWindowState(pane: string): Promise<void> {
  const s = await sessionName(pane);
  if (s) await run(["set-option", "-u", "-t", s, "@agent_window_state"]);
}

async function paneStates(pane: string): Promise<AgentState[]> {
  if (!enabled()) return [];
  try {
    const win = await windowId(pane);
    if (!win) return [];
    const panes = (await exec(["list-panes", "-t", win, "-F", "#{pane_id}"]))
      .trim().split("\n").filter(Boolean);
    const states: AgentState[] = [];
    for (const p of panes) {
      try {
        const v = (await exec(["show-options", "-p", "-v", "-t", p, "@agent_state"])).trim();
        if (v === "working" || v === "idle") states.push(v);
      } catch { /* unset/unknown pane — skip */ }
    }
    return states;
  } catch { return []; }
}

export async function computeRollup(pane: string): Promise<WindowRollup> {
  const states = await paneStates(pane);
  if (states.length === 0) return null;
  const hasWorking = states.some((s) => s === "working");
  const hasIdle = states.some((s) => s === "idle");
  if (hasWorking && hasIdle) return "mixed";
  if (hasWorking) return "working";
  return "idle";
}

// Write the window-scoped @agent_window_state. -w forces WINDOW scope (without
// it, set-option -t <window> defaults to SESSION scope for user options, so
// every window in the session would share the same dot). Unset when null.
export async function setWindowState(pane: string, rollup: WindowRollup): Promise<void> {
  const win = await windowId(pane);
  if (!win) return;
  if (rollup === null) {
    await run(["set-option", "-w", "-u", "-t", win, "@agent_window_state"]);
  } else {
    await run(["set-option", "-w", "-t", win, "@agent_window_state", rollup]);
  }
}

// Recompute + apply the rollup for the pane's window. Called on every transition.
export async function applyRollup(pane: string): Promise<void> {
  const rollup = await computeRollup(pane);
  await setWindowState(pane, rollup);
  await refreshStatus(pane);
}

// --- Refresh throttle: protects the user's #(...) status scripts --------------
// Only called on state transitions (≤2/turn). Idle never calls this.
let nowFn: () => number = () => Date.now();
export function setNow(fn: () => number): void { nowFn = fn; }
let lastRefreshAt = 0;
export const REFRESH_MIN_MS = 400;
export function _resetThrottleForTests(): void { lastRefreshAt = 0; }

export async function refreshStatus(pane: string): Promise<void> {
  if (!enabled()) return;
  if (nowFn() - lastRefreshAt < REFRESH_MIN_MS) return;
  lastRefreshAt = nowFn();
  try {
    const win = await windowId(pane);
    if (!win) return;
    const session = (await exec(["display-message", "-p", "-t", win, "#{session_name}"])).trim();
    const clients = (await exec(["list-clients", "-t", session, "-F", "#{client_name}"]))
      .trim().split("\n").filter(Boolean);
    for (const c of clients) {
      try { await exec(["refresh-client", "-S", "-t", c]); } catch { /* swallow per-client */ }
    }
  } catch { /* swallow — cosmetic */ }
}