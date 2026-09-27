import { test } from "node:test";
import assert from "node:assert/strict";
import * as tmux from "../lib/tmux.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// v0.2.7 heal + diagnostics contract:
//  - activation writes a pane-local @agent_status_boot marker
//  - "working" always rewrites (heals a cleared/lost pane option)
//  - turn_start / tool_execution_* reinforce the working state
//  - idle stays deduped (absorbs omp/pi double settle-fires)
//  - a failed write is persisted into the boot marker (no stderr: pi TUI)

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;
interface FakePi { on(name: string, h: Handler): void; handlers: Record<string, Handler>; }
function fakePi(): FakePi {
  const handlers: Record<string, Handler> = {};
  return { on: (n: string, h: Handler) => { handlers[n] = h; }, handlers };
}

async function fire(pi: FakePi, event: string, payload: unknown = { type: event }, ctx: unknown = {}): Promise<void> {
  const h = pi.handlers[event];
  if (!h) throw new Error(`no handler registered for ${event}`);
  await h(payload, ctx);
}

interface HealStub {
  paneState: Record<string, string>;
  bootState: Record<string, string>;
  winState: Record<string, string>;
  stateWrites: string[];
  setFailStateWrites(fail: boolean): void;
}

// Stub persisting ALL extension options (pane @agent_state + @agent_status_boot,
// window @agent_window_state) and counting @agent_state writes, so tests can
// assert heal rewrites and dedup separately.
function healStub(pane: string, panesInWindow: string[]): HealStub {
  const paneState: Record<string, string> = {};
  const bootState: Record<string, string> = {};
  const winState: Record<string, string> = {};
  const stateWrites: string[] = [];
  let failStateWrites = false;
  tmux._resetThrottleForTests();
  tmux.setExec(async (args) => {
    const cmd = args[0]!;
    const target = args[args.indexOf("-t") + 1]!;
    if (cmd === "set-option") {
      if (args.includes("-u")) {
        const opt = args[args.length - 1]!;
        if (opt === "@agent_state") delete paneState[target];
        if (opt === "@agent_status_boot") delete bootState[target];
        if (opt === "@agent_window_state") delete winState[target];
        return "";
      }
      const opt = args.find((a) => a.startsWith("@agent"))!;
      const val = args[args.length - 1]!;
      if (opt === "@agent_state") {
        if (failStateWrites) throw new Error("injected tmux failure");
        paneState[target] = val;
        stateWrites.push(val);
      }
      if (opt === "@agent_status_boot") bootState[target] = val;
      if (opt === "@agent_window_state") winState[target] = val;
      return "";
    }
    if (cmd === "show-options") {
      const opt = args[args.length - 1]!;
      const store = opt === "@agent_state" ? paneState : bootState;
      const v = store[target];
      if (v === undefined) throw new Error("unset");
      return v + "\n";
    }
    if (cmd === "display-message" && args.includes("#{window_id}")) return "@w\n";
    if (cmd === "display-message" && args.includes("#{session_name}")) return "s\n";
    if (cmd === "list-panes") return panesInWindow.join("\n") + "\n";
    return "";
  });
  tmux.setGuards(() => pane, () => false, () => "yes");
  return {
    paneState, bootState, winState, stateWrites,
    setFailStateWrites(fail: boolean): void { failStateWrites = fail; },
  };
}

async function activate(stub: HealStub, pane: string): Promise<FakePi> {
  // Dynamic import per repo test convention (test/extension.test.ts): loads
  // the raw-TS extension entry exactly as a pi/omp host would.
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  const pi = fakePi();
  // Test seam: the extension expects the full ExtensionAPI; the fake supplies
  // exactly the surface under test.
  agentStatus(pi as unknown as ExtensionAPI);
  return pi;
}

test("activation writes pane-local boot marker (diagnostic trail)", async () => {
  const pane = "p1";
  const stub = healStub(pane, [pane]);
  await activate(stub, pane);
  assert.match(stub.bootState[pane]!, /^v0\.2\.\d+$/);
});

test("heal: externally cleared @agent_state is rewritten working on turn_start", async () => {
  const pane = "p2";
  const stub = healStub(pane, [pane]);
  const pi = await activate(stub, pane);
  await fire(pi, "session_start", { type: "session_start" }, { hasUI: true, isIdle: () => true });
  assert.equal(stub.paneState[pane], "idle");
  delete stub.paneState[pane]; // the %225 scenario: option lost after startup
  await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  assert.equal(stub.paneState[pane], "working");
});

test("turn_start publishes working even when session_start was skipped (no hasUI)", async () => {
  const pane = "p3";
  const stub = healStub(pane, [pane]);
  const pi = await activate(stub, pane);
  await fire(pi, "session_start", { type: "session_start" }, { hasUI: false });
  assert.equal(stub.paneState[pane], undefined);
  await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  assert.equal(stub.paneState[pane], "working");
});

test("tool_execution_start/end keep and re-write working state", async () => {
  const pane = "p4";
  const stub = healStub(pane, [pane]);
  const pi = await activate(stub, pane);
  await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  const writesAfterTurnStart = stub.stateWrites.length;
  await fire(pi, "tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
  await fire(pi, "tool_execution_end", { type: "tool_execution_end", toolCallId: "c1" });
  assert.equal(stub.paneState[pane], "working");
  assert.equal(stub.stateWrites.length, writesAfterTurnStart + 2);
});

test("idle dedup survives: agent_end(settled) + agent_settled write idle exactly once", async () => {
  const pane = "p5";
  const stub = healStub(pane, [pane]);
  const pi = await activate(stub, pane);
  await fire(pi, "session_start", { type: "session_start" }, { hasUI: true, isIdle: () => true });
  await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  const writesWhileWorking = stub.stateWrites.filter((v) => v === "working").length;
  assert.ok(writesWhileWorking >= 1);
  const before = stub.stateWrites.length;
  await fire(pi, "agent_end", { type: "agent_end", messages: [] });
  await fire(pi, "agent_settled", { type: "agent_settled" }, { hasUI: true, isIdle: () => true });
  assert.equal(stub.stateWrites.length, before + 1); // only agent_end wrote
  assert.equal(stub.paneState[pane], "idle");
});

test("omp queued continuation: agent_end willContinue=true stays working", async () => {
  const pane = "p6";
  const stub = healStub(pane, [pane]);
  const pi = await activate(stub, pane);
  await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await fire(pi, "agent_end", { type: "agent_end", messages: [], willContinue: true });
  assert.equal(stub.paneState[pane], "working");
});

test("failed write is persisted into the boot marker (write-fail diagnostic)", async () => {
  const pane = "p7";
  const stub = healStub(pane, [pane]);
  const pi = await activate(stub, pane);
  stub.setFailStateWrites(true);
  await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  assert.match(stub.bootState[pane]!, /^v0\.2\.\d+ write-fail\(unset\)$/);
});

test("quit + session_start rewrites pane state (v0.2.5 regression) and clears the marker", async () => {
  const pane = "p8";
  const stub = healStub(pane, [pane]);
  const pi = await activate(stub, pane);
  await fire(pi, "session_start", { type: "session_start" }, { hasUI: true, isIdle: () => true });
  await fire(pi, "session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(stub.paneState[pane], undefined);
  assert.equal(stub.bootState[pane], undefined); // marker cleared with state on quit
  await fire(pi, "session_start", { type: "session_start" }, { hasUI: true, isIdle: () => true });
  assert.equal(stub.paneState[pane], "idle"); // re-written despite in-memory idle
  assert.match(stub.bootState[pane]!, /^v0\.2\.\d+$/); // marker re-established after quit cleared it
});

test("first publish applies the window rollup even with no state change", async () => {
  const pane = "p9";
  const stub = healStub(pane, [pane]);
  const pi = await activate(stub, pane);
  await fire(pi, "session_start", { type: "session_start" }, { hasUI: true, isIdle: () => true });
  assert.equal(stub.winState["@w"], "idle");
});

test("marker restores to plain after a transient write failure recovers", async () => {
  const pane = "p10";
  const stub = healStub(pane, [pane]);
  const pi = await activate(stub, pane);
  stub.setFailStateWrites(true);
  await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  assert.match(stub.bootState[pane]!, /write-fail\(/);
  stub.setFailStateWrites(false);
  await fire(pi, "tool_execution_end", { type: "tool_execution_end", toolCallId: "c1" });
  assert.match(stub.bootState[pane]!, /^v0\.2\.\d+$/); // plain marker restored
  assert.equal(stub.paneState[pane], "working");
});

test("failed idle write is retried by the next idle signal, not absorbed by dedup", async () => {
  const pane = "p11";
  const stub = healStub(pane, [pane]);
  const pi = await activate(stub, pane);
  await fire(pi, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  stub.setFailStateWrites(true);
  await fire(pi, "agent_end", { type: "agent_end", messages: [] }); // settle write fails
  assert.equal(stub.paneState[pane], "working"); // still stale-working
  assert.match(stub.bootState[pane]!, /write-fail\(working\)$/); // diagnostic names the stale value
  stub.setFailStateWrites(false);
  await fire(pi, "agent_settled", { type: "agent_settled" }, { hasUI: true, isIdle: () => true });
  assert.equal(stub.paneState[pane], "idle"); // retried and healed
  assert.match(stub.bootState[pane]!, /^v0\.2\.\d+$/);
});

test("EXT_VERSION stays in sync with package.json (marker is the diagnostic trail)", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const declared = /"version":\s*"([^"]+)"/.exec(raw)?.[1];
  const { EXT_VERSION } = await import("../extensions/agent-status.ts");
  assert.equal(EXT_VERSION, declared);
});

