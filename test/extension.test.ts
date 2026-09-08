import { test } from "node:test";
import assert from "node:assert/strict";
import * as tmux from "../lib/tmux.ts";

type Handler = (event: any, ctx: any) => void | Promise<void>;
interface FakePi { on(name: string, h: Handler): void; handlers: Map<string, Handler>; }
function fakePi(): FakePi {
  const handlers = new Map<string, Handler>();
  return { on: (n: string, h: Handler) => handlers.set(n, h), handlers } as unknown as FakePi;
}

// Stateful exec stub: persists pane @agent_state + window @agent_window_state
// so computeRollup reads reflect the extension's writes.
function statefulStub(pane: string, panesInWindow: string[]) {
  const paneState: Record<string, string> = {};
  const winState: Record<string, string> = {};
  const calls: string[][] = [];
  tmux.setExec(async (args) => {
    calls.push([...args]);
    const cmd = args[0];
    if (cmd === "set-option") {
      if (args.includes("-u")) {
        if (args.includes("@agent_state")) delete paneState[args[args.indexOf("-t") + 1]!];
        if (args.includes("@agent_window_state")) delete winState[args[args.indexOf("-t") + 1]!];
        return "";
      }
      const key = args.find((a) => a.startsWith("@agent"))!;
      const tIdx = args.indexOf("-t");
      const target = args[tIdx + 1]!;
      const valIdx = args.indexOf(key);
      const val = args[valIdx + 1]!;
      if (key === "@agent_state") paneState[target] = val;
      if (key === "@agent_window_state") winState[target] = val;
      return "";
    }
    if (cmd === "show-options") {
      const target = args[args.indexOf("-t") + 1]!;
      const v = paneState[target];
      if (v === undefined) throw new Error("unset");
      return v + "\n";
    }
    if (cmd === "display-message" && args.includes("#{window_id}")) return "@w\n";
    if (cmd === "display-message" && args.includes("#{session_name}")) return "s\n";
    if (cmd === "list-panes") return panesInWindow.join("\n") + "\n";
    return "";
  });
  tmux.setGuards(() => pane, () => false, () => "yes");
  return { paneState, winState, calls };
}

test("extension no-ops on load when not in tmux", async () => {
  tmux.setGuards(() => "p0", () => false, () => "");
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);
  assert.equal(pi.handlers.size, 0, "no handlers registered when disabled");
});

test("single pi: agent_start → pane working + window working(green); settled → idle + window idle(grey)", async () => {
  const { paneState, winState } = statefulStub("p0", ["p0"]);
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);

  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => true });
  assert.equal(paneState.p0, "idle");
  assert.equal(winState["@w"], "idle");

  await pi.handlers.get("agent_start")!({}, {});
  assert.equal(paneState.p0, "working");
  assert.equal(winState["@w"], "working");

  await pi.handlers.get("agent_settled")!({}, { isIdle: () => true });
  assert.equal(paneState.p0, "idle");
  assert.equal(winState["@w"], "idle");
});

test("omp: agent_end (no willContinue key) → idle — omp never fires agent_settled", async () => {
  const { paneState, winState } = statefulStub("p0", ["p0"]);
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);

  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => true });
  await pi.handlers.get("agent_start")!({}, {});
  assert.equal(paneState.p0, "working");

  await pi.handlers.get("agent_end")!({ type: "agent_end", messages: [] }, {});
  assert.equal(paneState.p0, "idle");
  assert.equal(winState["@w"], "idle");
});

test("omp: agent_end with willContinue=true stays working (queued continuation)", async () => {
  const { paneState } = statefulStub("p0", ["p0"]);
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);

  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => true });
  await pi.handlers.get("agent_start")!({}, {});
  await pi.handlers.get("agent_end")!({ type: "agent_end", messages: [], willContinue: true }, {});
  assert.equal(paneState.p0, "working");
});

test("pi double-fire: agent_end(settled) then agent_settled(idle) writes idle exactly once", async () => {
  const { paneState, calls } = statefulStub("p0", ["p0"]);
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);

  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => true });
  await pi.handlers.get("agent_start")!({}, {});
  await pi.handlers.get("agent_end")!({ type: "agent_end", messages: [] }, {});
  await pi.handlers.get("agent_settled")!({}, { isIdle: () => true });

  assert.equal(paneState.p0, "idle");
  const paneWrites = calls.filter((c) => c[0] === "set-option" && c.includes("@agent_state"));
  assert.equal(paneWrites.length, 3, "startup idle + working + idle — deduped, no 4th write");
});

test("two pi panes: mixed rollup → yellow (one working, one idle)", async () => {
  // pane p0 is THIS extension instance; p1 is a sibling whose state we preset.
  const stub = statefulStub("p0", ["p0", "p1"]);
  stub.paneState.p1 = "idle"; // sibling idle
  const { paneState, winState } = stub;
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);

  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => true });
  await pi.handlers.get("agent_start")!({}, {});
  // p0 working, p1 idle → mixed
  assert.equal(paneState.p0, "working");
  assert.equal(winState["@w"], "mixed");

  // p0 settles → both idle → idle (grey)
  stub.paneState.p1 = "idle";
  await pi.handlers.get("agent_settled")!({}, { isIdle: () => true });
  assert.equal(paneState.p0, "idle");
  assert.equal(winState["@w"], "idle");
});

test("session_shutdown quit clears pane state + rollup → no pi (null window state)", async () => {
  const stub = statefulStub("p0", ["p0"]);
  const { paneState, winState } = stub;
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);
  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => false });
  await pi.handlers.get("agent_start")!({}, {});
  assert.equal(winState["@w"], "working");
  await pi.handlers.get("session_shutdown")!({ reason: "quit" }, {});
  assert.equal(paneState.p0, undefined, "pane state cleared on quit");
  assert.equal(winState["@w"], undefined, "window state unset on quit (no pi)");
});

test("session_shutdown reload does NOT clear (extension rebinds)", async () => {
  const stub = statefulStub("p0", ["p0"]);
  const { paneState } = stub;
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);
  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => false });
  await pi.handlers.get("agent_start")!({}, {});
  await pi.handlers.get("session_shutdown")!({ reason: "reload" }, {});
  assert.equal(paneState.p0, "working", "pane state preserved on reload");
});

test("session_start without hasUI is ignored", async () => {
  const stub = statefulStub("p0", ["p0"]);
  const { paneState } = stub;
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);
  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: false });
  assert.equal(paneState.p0, undefined);
});

test("quit+restart cycle re-writes pane state (regression: dot gone after /new or /resume)", async () => {
  // Repro of RECTOR's bug: pi in pane B starts (idle), then does a /new or
  // /resume (fires session_shutdown quit + session_start). The quit cleared the
  // tmux @agent_state option, but lastWritten was not reset, so the next
  // session_start's publish(IDLE) was deduped (idle===idle) and never re-wrote.
  // Result: pane @agent_state stays unset; when the sibling pane later closes,
  // applyRollup finds no states -> window_state unset -> dot gone.
  const stub = statefulStub("p0", ["p0"]);
  const { paneState, winState } = stub;
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);
  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => true });
  assert.equal(paneState.p0, "idle");
  // quit clears the tmux option (e.g. /new, /resume, a reload that emits quit)
  await pi.handlers.get("session_shutdown")!({ reason: "quit" }, {});
  assert.equal(paneState.p0, undefined, "pane state cleared on quit");
  // restart in the same extension instance -> MUST re-write the pane state
  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => true });
  assert.equal(paneState.p0, "idle", "pane state re-written after quit+start");
  assert.equal(winState["@w"], "idle", "window state restored after restart");
});