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
  const pane = (await tmux(["list-panes", "-t", sess, "-F", "#{pane_id}"])).trim().split("\n")[0] ?? "";
  return pane;
}

async function killSession(pane: string): Promise<void> {
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
    for (const line of snap) {
      assert.ok(afterSet.has(line), `existing option changed/removed: ${line}`);
    }
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
    const pstate = (await tmuxRead(["show-options", "-p", "-t", pane, "@agent_state"])).trim();
    assert.match(pstate, /working/);
  } finally {
    await killSession(pane);
  }
});

// Regression test for v0.1.0 bug: the format used comma-separated #[...] style
// blocks inside #{?cond,then,else} branches, whose commas tmux parsed as branch
// delimiters — so the segment rendered the literal format text instead of a
// state. Also: options are session-scoped (not -g) so test runs never pollute
// the user's live global @agent_* / @thm_* options.
test("format-expand: #{E:#{@agent_status_format}} renders correctly across unset/working/idle", async () => {
  const pane = await newSession("snippet-expand");
  const sess = (await tmux(["display-message", "-p", "-t", pane, "#{session_name}"])).trim();
  try {
    // catppuccin tokens the snippet references (bare session has no theme).
    await tmux(["set-option", "-t", sess, "@thm_bg", "#24273a"]);
    await tmux(["set-option", "-t", sess, "@thm_overlay_0", "#6e738d"]);
    await tmux(["set-option", "-t", sess, "@thm_green", "#a6da95"]);
    await tmux(["source-file", "-t", pane, snippetPath]);

    // UNSET → segment hidden (neither working nor idle visible)
    const unset = await tmux(["display-message", "-p", "-t", pane, "#{E:#{@agent_status_format}}"]);
    assert.doesNotMatch(unset, /working|idle/, "unset → segment hidden");

    // working → spinner glyph + 'working' + tool name
    await tmux(["set-option", "-t", sess, "@agent_state", "working"]);
    await tmux(["set-option", "-t", sess, "@agent_spinner", "⠼"]);
    await tmux(["set-option", "-t", sess, "@agent_tool", "bash"]);
    const working = await tmux(["display-message", "-p", "-t", pane, "#{E:#{@agent_status_format}}"]);
    assert.match(working, /⠼/, "working → spinner glyph rendered");
    assert.match(working, /working/, "working → 'working' text rendered");
    assert.match(working, /bash/, "working → tool name rendered");

    // idle → ◉ + 'idle', no 'working'
    await tmux(["set-option", "-t", sess, "@agent_state", "idle"]);
    await tmux(["set-option", "-t", sess, "-u", "@agent_tool"]);
    const idle = await tmux(["display-message", "-p", "-t", pane, "#{E:#{@agent_status_format}}"]);
    assert.match(idle, /◉/, "idle → ◉ glyph rendered");
    assert.match(idle, /idle/, "idle → 'idle' text rendered");
    assert.doesNotMatch(idle, /working/, "idle → no 'working' text");
  } finally {
    await killSession(pane);
  }
});