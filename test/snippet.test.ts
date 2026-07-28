import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

const snippetPath = path.resolve(fileURLToPath(import.meta.url), "../../tmux/agent-status.tmux");

async function tmux(args: string[]): Promise<string> {
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
  await tmux(["new", "-d", "-s", sess]);
  return (await tmux(["list-panes", "-t", sess, "-F", "#{pane_id}"])).trim().split("\n")[0] ?? "";
}

async function killSession(pane: string): Promise<void> {
  try {
    const sess = (await tmux(["display-message", "-p", "-t", pane, "#{session_name}"])).trim();
    await tmux(["kill-session", "-t", sess]);
  } catch { /* best-effort */ }
}

async function windowId(pane: string): Promise<string> {
  return (await tmux(["display-message", "-p", "-t", pane, "#{window_id}"])).trim();
}

test("snippet sources without error and defines @agent_window_dot", async () => {
  const pane = await newSession("snippet-smoke");
  try {
    await tmux(["source-file", "-t", pane, snippetPath]);
    const fmt = await tmux(["show-options", "-g", "@agent_window_dot"]);
    assert.ok(fmt.includes("@agent_window_dot"), "snippet defined @agent_window_dot");
  } finally {
    await killSession(pane);
  }
});

test("non-regression: snippet changes NO existing global option (only @agent_window_dot added)", async () => {
  const pane = await newSession("nonreg");
  try {
    const snap = (await tmuxRead(["show-options", "-g", "-t", pane])).split("\n").filter(Boolean);
    await tmux(["source-file", "-t", pane, snippetPath]);
    const after = (await tmuxRead(["show-options", "-g", "-t", pane])).split("\n").filter(Boolean);
    const beforeSet = new Set(snap);
    const afterSet = new Set(after);
    for (const line of snap) {
      assert.ok(afterSet.has(line), `existing option changed/removed: ${line}`);
    }
    for (const line of after) {
      if (beforeSet.has(line)) continue;
      const key = (line.split(" ")[0] ?? "").replace(/^"|"$/g, "");
      assert.equal(key, "@agent_window_dot", `snippet added an unexpected global option: ${line}`);
    }
  } finally {
    await killSession(pane);
  }
});

test("#{E:#{@agent_window_dot}} renders green/yellow/grey/none across states", async () => {
  const pane = await newSession("snippet-expand");
  const sess = (await tmux(["display-message", "-p", "-t", pane, "#{session_name}"])).trim();
  const win = await windowId(pane);
  try {
    await tmux(["set-option", "-t", sess, "@thm_green", "#a6da95"]);
    await tmux(["set-option", "-t", sess, "@thm_yellow", "#eed49f"]);
    await tmux(["set-option", "-t", sess, "@thm_overlay_0", "#6e738d"]);
    await tmux(["source-file", "-t", pane, snippetPath]);

    // working → green dot
    await tmux(["set-option", "-t", win, "@agent_window_state", "working"]);
    let r = await tmux(["display-message", "-p", "-t", pane, "#{E:#{@agent_window_dot}}"]);
    assert.match(r, /#a6da95.*●/, "working → green dot");

    // mixed → yellow dot
    await tmux(["set-option", "-t", win, "@agent_window_state", "mixed"]);
    r = await tmux(["display-message", "-p", "-t", pane, "#{E:#{@agent_window_dot}}"]);
    assert.match(r, /#eed49f.*●/, "mixed → yellow dot");

    // idle → grey dot
    await tmux(["set-option", "-t", win, "@agent_window_state", "idle"]);
    r = await tmux(["display-message", "-p", "-t", pane, "#{E:#{@agent_window_dot}}"]);
    assert.match(r, /#6e738d.*●/, "idle → grey dot");

    // unset → no dot
    await tmux(["set-option", "-u", "-t", win, "@agent_window_state"]);
    r = await tmux(["display-message", "-p", "-t", pane, "#{E:#{@agent_window_dot}}"]);
    assert.doesNotMatch(r, /●/, "unset → no dot");
  } finally {
    await killSession(pane);
  }
});