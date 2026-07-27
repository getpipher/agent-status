import { test } from "node:test";
import assert from "node:assert/strict";
import * as tmux from "../lib/tmux.ts";

// Fake ExtensionAPI: capture registered handlers so we can emit events.
type Handler = (event: any, ctx: any) => void | Promise<void>;
interface FakePi {
  on(name: string, h: Handler): void;
  handlers: Map<string, Handler>;
}
function fakePi(): FakePi {
  const handlers = new Map<string, Handler>();
  return { on: (n, h) => handlers.set(n, h), handlers } as unknown as FakePi;
}

function setup(pane = "p0") {
  const calls: string[][] = [];
  let curPane = pane;
  let herdr = false;
  let tmuxEnv = "yes";
  tmux.setExec(async (a) => { calls.push([...a]); return curPane === "p0" ? "sess\n/dev/ttys010\n" : ""; });
  tmux.setGuards(() => curPane, () => herdr, () => tmuxEnv);
  return { calls, setPane: (p: string) => { curPane = p; }, setHerdr: (b: boolean) => { herdr = b; }, setTmuxEnv: (e: string) => { tmuxEnv = e; } };
}

test("extension no-ops on load when not in tmux", async () => {
  const { setTmuxEnv } = setup();
  setTmuxEnv("");
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);
  assert.equal(pi.handlers.size, 0, "no handlers registered when disabled");
});

test("extension no-ops on load when HERDR_ENV=1", async () => {
  const { setHerdr } = setup();
  setHerdr(true);
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);
  assert.equal(pi.handlers.size, 0);
});

test("agent_start → working + frame advanced; agent_settled idle → idle", async () => {
  const { calls } = setup();
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);

  // session_start with hasUI true, idle
  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => true });
  // agent_start
  await pi.handlers.get("agent_start")!({}, {});
  assert.ok(calls.some((a) => a.includes("@agent_state") && a.includes("working")), "wrote working");

  // tool_execution_start → tool name
  await pi.handlers.get("tool_execution_start")!({ toolName: "bash" }, {});
  assert.ok(calls.some((a) => a.includes("@agent_tool") && a.includes("bash")), "wrote tool name");

  // agent_settled idle
  await pi.handlers.get("agent_settled")!({}, { isIdle: () => true });
  assert.ok(calls.some((a) => a.includes("@agent_state") && a.includes("idle")), "wrote idle");
});

test("session_shutdown quit clears options", async () => {
  const { calls } = setup();
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);
  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => true });
  await pi.handlers.get("agent_start")!({}, {});
  calls.length = 0;
  await pi.handlers.get("session_shutdown")!({ reason: "quit" }, {});
  assert.ok(calls.some((a) => a.includes("-u") && a.includes("@agent_state")), "unset @agent_state on quit");
});

test("session_shutdown reload does NOT clear (extension rebinds)", async () => {
  const { calls } = setup();
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);
  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: true, isIdle: () => false });
  calls.length = 0;
  await pi.handlers.get("session_shutdown")!({ reason: "reload" }, {});
  assert.ok(!calls.some((a) => a.includes("-u")), "no unset on reload");
});

test("session_start without hasUI is ignored", async () => {
  const { calls } = setup();
  const pi = fakePi();
  const { default: agentStatus } = await import("../extensions/agent-status.ts");
  agentStatus(pi as any);
  calls.length = 0;
  await pi.handlers.get("session_start")!({ reason: "startup" }, { hasUI: false });
  assert.equal(calls.filter((a) => a.includes("@agent_state")).length, 0);
});