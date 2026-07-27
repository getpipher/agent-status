import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as tmux from "../lib/tmux.ts";

// Direct tmux exec (separate from the lib under test) for session management + read-back.
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
  const pane = (await tmuxCmd(["list-panes", "-t", sess, "-F", "#{pane_id}"])).trim().split("\n")[0];
  return pane;
}

async function killSession(pane: string): Promise<void> {
  try {
    const sess = (await tmuxCmd(["display-message", "-p", "-t", pane, "#{session_name}"])).trim();
    await tmuxCmd(["kill-session", "-t", sess]);
  } catch { /* best-effort cleanup */ }
}

test("setState writes pane-local options readable via tmux show-options -p", async () => {
  const pane = await newSession("integ-1");
  try {
    tmux.setExec(tmux.defaultTmuxExec);
    tmux.setGuards(() => pane, () => false, () => "yes");
    await tmux.setState(pane, "working", "bash");
    const state = (await tmuxRead(["show-options", "-p", "-t", pane, "@agent_state"])).trim();
    const tool = (await tmuxRead(["show-options", "-p", "-t", pane, "@agent_tool"])).trim();
    assert.match(state, /working/);
    assert.match(tool, /bash/);
  } finally {
    await killSession(pane);
  }
});

test("clear unsets the pane-local options", async () => {
  const pane = await newSession("integ-2");
  try {
    tmux.setExec(tmux.defaultTmuxExec);
    tmux.setGuards(() => pane, () => false, () => "yes");
    await tmux.setState(pane, "working", "read");
    await tmux.clear(pane);
    const state = (await tmuxRead(["show-options", "-p", "-t", pane, "@agent_state"])).trim();
    assert.equal(state, "", "option unset after clear");
  } finally {
    await killSession(pane);
  }
});

test("setSpinner writes @agent_spinner", async () => {
  const pane = await newSession("integ-3");
  try {
    tmux.setExec(tmux.defaultTmuxExec);
    tmux.setGuards(() => pane, () => false, () => "yes");
    await tmux.setSpinner(pane, "⠼");
    const sp = (await tmuxRead(["show-options", "-p", "-t", pane, "@agent_spinner"])).trim();
    assert.match(sp, /⠼/);
  } finally {
    await killSession(pane);
  }
});