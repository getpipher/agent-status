import { test } from "node:test";
import assert from "node:assert/strict";
import * as tmux from "../lib/tmux.ts";

const calls: string[][] = [];
let pane = "p0";
let herdr = false;
let tmuxEnv = "yes";
tmux.setExec(async (args) => { calls.push([...args]); return ""; });
tmux.setGuards(() => pane, () => herdr, () => tmuxEnv);

function argsFor(cmd: string): string[][] {
  return calls.filter((a) => a[0] === cmd);
}

test("setState writes pane-local @agent_state only", async () => {
  calls.length = 0;
  await tmux.setState("p0", "working");
  assert.deepEqual(argsFor("set-option"), [
    ["set-option", "-p", "-t", "p0", "@agent_state", "working"],
  ]);
});

test("clear unsets pane-local @agent_state", async () => {
  calls.length = 0;
  await tmux.clear("p0");
  const unsets = argsFor("set-option").filter((a) => a.includes("-u"));
  assert.equal(unsets.length, 1);
  assert.deepEqual(unsets[0], ["set-option", "-p", "-u", "-t", "p0", "@agent_state"]);
});

test("no-op when not in tmux ($TMUX unset)", async () => {
  calls.length = 0; tmuxEnv = "";
  await tmux.setState("p0", "working");
  assert.equal(calls.length, 0);
  tmuxEnv = "yes";
});

test("no-op when HERDR_ENV=1", async () => {
  calls.length = 0; herdr = true;
  await tmux.setState("p0", "working");
  assert.equal(calls.length, 0);
  herdr = false;
});

test("swallows tmux errors (status is cosmetic)", async () => {
  tmux.setExec(async () => { throw new Error("boom"); });
  await assert.doesNotReject(() => tmux.setState("p0", "working"));
  tmux.setExec(async (args) => { calls.push([...args]); return ""; });
});

// --- rollup ------------------------------------------------------------------
// Drive computeRollup with a stubbed exec that answers pane-state reads.
function stubRollup(paneStates: Record<string, string | undefined>, windowOf = "p0"): void {
  let i = 0;
  const replies: Record<number, string> = {};
  // call sequence for paneStates' pane p0:
  //  display-message #{window_id} -> "@w"
  //  list-panes -F #{pane_id}     -> the pane ids joined
  //  for each pane: show-options -p -v @agent_state -> state or "" (unset errors)
  const panes = Object.keys(paneStates);
  tmux.setExec(async (args) => {
    calls.push([...args]);
    if (args[0] === "display-message" && args.includes("#{window_id}")) return "@w\n";
    if (args[0] === "list-panes") return panes.join("\n") + "\n";
    if (args[0] === "show-options" && args.includes("@agent_state")) {
      const target = args[args.indexOf("-t") + 1]!;
      const v = paneStates[target];
      if (v === undefined) throw new Error("unset"); // unset pane -> error
      return v + "\n";
    }
    return "";
  });
  void windowOf; void i; void replies;
}

test("computeRollup: all working → working", async () => {
  stubRollup({ "%1": "working", "%2": "working" });
  const r = await tmux.computeRollup("p0");
  assert.equal(r, "working");
});

test("computeRollup: all idle → idle", async () => {
  stubRollup({ "%1": "idle", "%2": "idle" });
  const r = await tmux.computeRollup("p0");
  assert.equal(r, "idle");
});

test("computeRollup: mixed (working + idle) → mixed", async () => {
  stubRollup({ "%1": "working", "%2": "idle" });
  const r = await tmux.computeRollup("p0");
  assert.equal(r, "mixed");
});

test("computeRollup: no pi (all panes unset) → null", async () => {
  stubRollup({ "%1": undefined, "%2": undefined });
  const r = await tmux.computeRollup("p0");
  assert.equal(r, null);
});

test("computeRollup: one working among shells (unset) → working", async () => {
  stubRollup({ "%1": "working", "%2": undefined });
  const r = await tmux.computeRollup("p0");
  assert.equal(r, "working");
});

test("setWindowState: writes window-scoped @agent_window_state", async () => {
  calls.length = 0;
  let winFor = "p0";
  tmux.setExec(async (args) => {
    calls.push([...args]);
    if (args[0] === "display-message" && args.includes("#{window_id}")) return "@w\n";
    return "";
  });
  void winFor;
  await tmux.setWindowState("p0", "working");
  assert.ok(argsFor("set-option").some((a) =>
    a.includes("-w") && a.includes("@agent_window_state") && a.includes("working") && a.includes("@w")),
    "wrote window-scoped (-w) @agent_window_state=working");
});

test("setWindowState: null rollup unsets the window option", async () => {
  calls.length = 0;
  tmux.setExec(async (args) => {
    calls.push([...args]);
    if (args[0] === "display-message" && args.includes("#{window_id}")) return "@w\n";
    return "";
  });
  await tmux.setWindowState("p0", null);
  assert.ok(argsFor("set-option").some((a) =>
    a.includes("-w") && a.includes("-u") && a.includes("@agent_window_state")),
    "unset window-scoped @agent_window_state when rollup null");
});