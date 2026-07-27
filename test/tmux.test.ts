import { test } from "node:test";
import assert from "node:assert/strict";
import * as tmux from "../lib/tmux.ts";

// Capture exec calls; stub the env guards.
const calls: string[][] = [];
let pane = "p0";
let herdr = false;
let tmuxEnv = "yes";
tmux.setExec(async (args) => { calls.push([...args]); return ""; });
tmux.setGuards(() => pane, () => herdr, () => tmuxEnv);

function argsFor(cmd: string): string[][] {
  return calls.filter((a) => a[0] === cmd);
}

test("setState writes pane-local @agent_state and @agent_tool", async () => {
  calls.length = 0;
  await tmux.setState("p0", "working", "bash");
  assert.deepEqual(argsFor("set-option"), [
    ["set-option", "-p", "-t", "p0", "@agent_state", "working"],
    ["set-option", "-p", "-t", "p0", "@agent_tool", "bash"],
  ]);
});

test("setState defaults tool to empty string", async () => {
  calls.length = 0;
  await tmux.setState("p0", "idle");
  assert.deepEqual(argsFor("set-option"), [
    ["set-option", "-p", "-t", "p0", "@agent_state", "idle"],
    ["set-option", "-p", "-t", "p0", "@agent_tool", ""],
  ]);
});

test("setSpinner writes @agent_spinner", async () => {
  calls.length = 0;
  await tmux.setSpinner("p0", "⠼");
  assert.deepEqual(argsFor("set-option"), [
    ["set-option", "-p", "-t", "p0", "@agent_spinner", "⠼"],
  ]);
});

test("clear unsets all three pane-local options", async () => {
  calls.length = 0;
  await tmux.clear("p0");
  const unsets = argsFor("set-option").filter((a) => a.includes("-u"));
  assert.equal(unsets.length, 3);
  assert.ok(unsets.every((a) => a.includes("-p") && a.includes("-t") && a.includes("p0")));
});

test("no-op when not in tmux ($TMUX unset)", async () => {
  calls.length = 0; tmuxEnv = "";
  await tmux.setState("p0", "working");
  assert.equal(calls.length, 0);
  tmuxEnv = "yes";
});

test("no-op when $TMUX_PANE unset", async () => {
  calls.length = 0; pane = "";
  await tmux.setState("p0", "working");
  assert.equal(calls.length, 0);
  pane = "p0";
});

test("no-op when HERDR_ENV=1", async () => {
  calls.length = 0; herdr = true;
  await tmux.setState("p0", "working");
  assert.equal(calls.length, 0);
  herdr = false;
});

test("refreshStatus lists clients in the pane's session and refreshes each", async () => {
  calls.length = 0;
  // First exec call: display-message session_name. Second: list-clients. Then refresh-client per client.
  let callIdx = 0;
  const replies = ["sess\n", "/dev/ttys010\n/dev/ttys000\n", "", ""];
  tmux.setExec(async (args) => { calls.push([...args]); return replies[callIdx++] ?? ""; });
  await tmux.refreshStatus("p0");
  assert.deepEqual(argsFor("display-message")[0], ["display-message", "-p", "-t", "p0", "#{session_name}"]);
  assert.deepEqual(argsFor("list-clients")[0], ["list-clients", "-t", "sess", "-F", "#{client_name}"]);
  const refreshes = argsFor("refresh-client");
  assert.deepEqual(refreshes, [
    ["refresh-client", "-S", "-t", "/dev/ttys010"],
    ["refresh-client", "-S", "-t", "/dev/ttys000"],
  ]);
  // restore default stub
  tmux.setExec(async (args) => { calls.push([...args]); return ""; });
});

test("refreshStatus is throttled to ≤2/s across calls", async () => {
  calls.length = 0;
  let t = 1000;
  tmux.setNow(() => t);
  tmux._resetThrottleForTests();
  const replies = ["sess\n", "/dev/ttys010\n", "", "", "sess\n", "/dev/ttys010\n", ""];
  let i = 0;
  tmux.setExec(async (args) => { calls.push([...args]); return replies[i++] ?? ""; });
  await tmux.refreshStatus("p0");          // t=1000, runs
  await tmux.refreshStatus("p0");          // t=1000, throttled (<400ms)
  assert.equal(argsFor("refresh-client").length, 1, "second call throttled");
  t = 1500;                                 // +500ms — past throttle window
  await tmux.refreshStatus("p0");          // runs again
  assert.equal(argsFor("refresh-client").length, 2, "third call after window runs");
  tmux.setNow(() => Date.now());
  tmux.setExec(async (args) => { calls.push([...args]); return ""; });
});

test("swallows tmux errors (status is cosmetic)", async () => {
  calls.length = 0;
  tmux.setExec(async () => { throw new Error("boom"); });
  await assert.doesNotReject(() => tmux.setState("p0", "working"));
  tmux.setExec(async (args) => { calls.push([...args]); return ""; });
});