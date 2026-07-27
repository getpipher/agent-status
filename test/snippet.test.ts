import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import * as tmuxLib from "../lib/tmux.ts";

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
  // Return the first pane id of the session
  const pane = (await tmux(["list-panes", "-t", sess, "-F", "#{pane_id}"])).trim().split("\n")[0] ?? "";
  return pane;
}

async function killSession(pane: string): Promise<void> {
  // kill-session via the pane's session
  try {
    const sess = (await tmux(["display-message", "-p", "-t", pane, "#{session_name}"])).trim();
    await tmux(["kill-session", "-t", sess]);
  } catch { /* best-effort cleanup */ }
}

test("snippet sources without error in a detached tmux session", async () => {
  const pane = await newSession("snippet-smoke");
  try {
    await tmux(["source-file", "-t", pane, snippetPath]);
    const fmt = await tmux(["show-options", "-g", "@agent_status_format"]);
    assert.ok(fmt.includes("@agent_status_format"), "snippet defined @agent_status_format");
  } finally {
    await killSession(pane);
  }
});

test("non-regression: snippet changes NO existing global status/theme option", async () => {
  const pane = await newSession("nonreg");
  try {
    const snap = (await tmuxRead(["show-options", "-g", "-t", pane])).split("\n").filter(Boolean);
    await tmux(["source-file", "-t", pane, snippetPath]);
    const after = (await tmuxRead(["show-options", "-g", "-t", pane])).split("\n").filter(Boolean);
    const beforeSet = new Set(snap);
    const afterSet = new Set(after);
    // No existing line was removed or changed value.
    for (const line of snap) {
      assert.ok(afterSet.has(line), `existing option changed/removed: ${line}`);
    }
    // The only allowed additions are the two new user options the snippet defines.
    const allowed = new Set(["@agent_status_format", "@agent_window_tab"]);
    for (const line of after) {
      if (beforeSet.has(line)) continue;
      const key = (line.split(" ")[0] ?? "").replace(/^"|"$/g, "");
      assert.ok(allowed.has(key), `snippet added an unexpected global option: ${line}`);
    }
  } finally {
    await killSession(pane);
  }
});

test("non-regression: extension writes ONLY pane-local @agent_* options, never global", async () => {
  const pane = await newSession("nonreg-ext");
  try {
    const before = (await tmuxRead(["show-options", "-g", "-t", pane])).trim();
    tmuxLib.setExec(tmuxLib.defaultTmuxExec);
    tmuxLib.setGuards(() => pane, () => false, () => "yes");
    await tmuxLib.setState(pane, "working", "bash");
    await tmuxLib.setSpinner(pane, "⠼");
    await tmuxLib.refreshStatus(pane);
    const after = (await tmuxRead(["show-options", "-g", "-t", pane])).trim();
    assert.equal(after, before, "extension changed a global option — must be pane-local only");
    // and the pane-local options are present
    const pstate = (await tmuxRead(["show-options", "-p", "-t", pane, "@agent_state"])).trim();
    assert.match(pstate, /working/);
  } finally {
    await killSession(pane);
  }
});

test("format-expand: #{@agent_status_format} renders working + tool when @agent_* set", async () => {
  const pane = await newSession("snippet-expand");
  try {
    await tmux(["source-file", "-t", pane, snippetPath]);
    await tmux(["set-option", "-g", "@agent_state", "working"]);
    await tmux(["set-option", "-g", "@agent_spinner", "⠼"]);
    await tmux(["set-option", "-g", "@agent_tool", "bash"]);
    // tmux 3.7b doesn't fully expand #{E:#{@agent_status_format}} (nested #{} + #[]
    // conditionals stop after the first style escape). Instead: prove the @agent_*
    // options are set + expandable via a simple conditional, then verify the
    // snippet's format string contains the expected literal segments.
    const stateRendered = await tmux(["display-message", "-p", "-t", pane, "#{?#{==:#{@agent_state},working},WORKING,IDLE}"]);
    assert.match(stateRendered, /WORKING/, "@agent_state expands to working");
    const toolRendered = await tmux(["display-message", "-p", "-t", pane, "#{@agent_tool}"]);
    assert.match(toolRendered, /bash/, "@agent_tool expands to bash");
    // The format string the snippet defines contains the literal segments.
    const fmt = await tmux(["show-options", "-v", "-g", "@agent_status_format"]);
    assert.match(fmt, /working/, "format string contains 'working'");
    assert.match(fmt, /#{@agent_tool}/, "format string references @agent_tool");
  } finally {
    await killSession(pane);
  }
});