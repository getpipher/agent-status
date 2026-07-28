import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as tmuxLib from "../lib/tmux.ts";

async function tmuxCmd(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`tmux ${args.join(" ")} ${c}`))));
    p.on("error", reject);
  });
}

async function tmuxRead(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => resolve(out));
    p.on("error", () => resolve(""));
  });
}

let sessCounter = 0;
async function newSession(name: string): Promise<string> {
  const sess = `${name}-${++sessCounter}`;
  await tmuxCmd(["new", "-d", "-s", sess]);
  return (await tmuxCmd(["list-panes", "-t", sess, "-F", "#{pane_id}"])).trim().split("\n")[0]!.replace(/[^%0-9]/g, "");
}
async function killSession(pane: string): Promise<void> {
  try {
    const sess = (await tmuxCmd(["display-message", "-p", "-t", pane, "#{session_name}"])).trim();
    await tmuxCmd(["kill-session", "-t", sess]);
  } catch { /* best-effort */ }
}
async function split(pane: string): Promise<string> {
  return (await tmuxCmd(["split-window", "-t", pane, "-P", "-F", "#{pane_id}"])).trim();
}
async function readOpt(target: string, name: string): Promise<string> {
  return (await tmuxRead(["show-options", "-p", "-t", target, name])).trim();
}
async function readWinOpt(win: string, name: string): Promise<string> {
  return (await tmuxRead(["show-options", "-w", "-t", win, name])).trim();
}

test("real tmux rollup: two panes working+idle → mixed", async () => {
  const pane = await newSession("integ-rollup");
  try {
    const p2 = await split(pane);
    tmuxLib.setExec(tmuxLib.defaultTmuxExec);
    tmuxLib.setGuards(() => pane, () => false, () => "yes");
    await tmuxLib.setState(pane, "working");
    await tmuxLib.setState(p2, "idle");
    // confirm pane-local writes are readable
    assert.match(await readOpt(pane, "@agent_state"), /working/);
    assert.match(await readOpt(p2, "@agent_state"), /idle/);
    const rollup = await tmuxLib.computeRollup(pane);
    assert.equal(rollup, "mixed");
  } finally {
    await killSession(pane);
  }
});

test("real tmux rollup: single working pane → working", async () => {
  const pane = await newSession("integ-single");
  try {
    tmuxLib.setExec(tmuxLib.defaultTmuxExec);
    tmuxLib.setGuards(() => pane, () => false, () => "yes");
    await tmuxLib.setState(pane, "working");
    const rollup = await tmuxLib.computeRollup(pane);
    assert.equal(rollup, "working");
  } finally {
    await killSession(pane);
  }
});

test("real tmux rollup: no pi panes → null", async () => {
  const pane = await newSession("integ-none");
  try {
    tmuxLib.setExec(tmuxLib.defaultTmuxExec);
    tmuxLib.setGuards(() => pane, () => false, () => "yes");
    const rollup = await tmuxLib.computeRollup(pane);
    assert.equal(rollup, null);
  } finally {
    await killSession(pane);
  }
});

test("setWindowState writes window-scoped @agent_window_state readable via show-options", async () => {
  const pane = await newSession("integ-win");
  try {
    tmuxLib.setExec(tmuxLib.defaultTmuxExec);
    tmuxLib.setGuards(() => pane, () => false, () => "yes");
    await tmuxLib.setState(pane, "working");
    await tmuxLib.setWindowState(pane, "working");
    const win = (await tmuxCmd(["display-message", "-p", "-t", pane, "#{window_id}"])).trim();
    assert.match(await readWinOpt(win, "@agent_window_state"), /working/);
  } finally {
    await killSession(pane);
  }
});