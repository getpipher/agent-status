import { spawn } from "node:child_process";

export type AgentState = "working" | "idle";

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

// --- Env guards (all injectable for tests) -----------------------------------
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

// --- Fail-safe runner: no-op when disabled, swallow on error -----------------
async function run(args: string[]): Promise<void> {
  if (!enabled()) return;
  try { await exec(args); } catch { /* cosmetic — never throw into pi */ }
}

export async function setState(pane: string, state: AgentState, tool?: string): Promise<void> {
  await run(["set-option", "-p", "-t", pane, "@agent_state", state]);
  await run(["set-option", "-p", "-t", pane, "@agent_tool", tool ?? ""]);
}

export async function setSpinner(pane: string, glyph: string): Promise<void> {
  await run(["set-option", "-p", "-t", pane, "@agent_spinner", glyph]);
}

export async function clear(pane: string): Promise<void> {
  await run(["set-option", "-p", "-u", "-t", pane, "@agent_state"]);
  await run(["set-option", "-p", "-u", "-t", pane, "@agent_spinner"]);
  await run(["set-option", "-p", "-u", "-t", pane, "@agent_tool"]);
}

// --- Refresh throttle: protect the user's #(...) status scripts --------------
// refresh-client -S forces a status redraw which re-runs #(...) status-left/-right
// scripts. Transition-only + this throttle bound the overhead to <=~2/s.
let nowFn: () => number = () => Date.now();
export function setNow(fn: () => number): void { nowFn = fn; }
let lastRefreshAt = 0;
export const REFRESH_MIN_MS = 400;
export function _resetThrottleForTests(): void { lastRefreshAt = 0; }

export async function refreshStatus(pane: string): Promise<void> {
  if (!enabled()) return;
  if (nowFn() - lastRefreshAt < REFRESH_MIN_MS) return; // throttle
  lastRefreshAt = nowFn();
  try {
    const session = (await exec(["display-message", "-p", "-t", pane, "#{session_name}"])).trim();
    const clients = (await exec(["list-clients", "-t", session, "-F", "#{client_name}"]))
      .trim().split("\n").filter(Boolean);
    for (const c of clients) {
      try { await exec(["refresh-client", "-S", "-t", c]); } catch { /* swallow per-client */ }
    }
  } catch { /* swallow — cosmetic */ }
}