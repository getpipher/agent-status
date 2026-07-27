import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, IDLE, WORKING } from "../lib/state.ts";

test("session_start idle → IDLE", () => {
  assert.deepEqual(reduce(WORKING, { type: "session_start", isIdle: true }), IDLE);
});

test("session_start while busy restores WORKING and keeps prior tool", () => {
  const prev = { state: "working", tool: "bash" };
  assert.deepEqual(reduce(prev, { type: "session_start", isIdle: false }), { state: "working", tool: "bash" });
});

test("agent_start → WORKING with tool cleared", () => {
  assert.deepEqual(reduce(IDLE, { type: "agent_start" }), { state: "working", tool: "" });
});

test("tool_execution_start sets the tool name", () => {
  assert.deepEqual(reduce(WORKING, { type: "tool_execution_start", toolName: "read" }), { state: "working", tool: "read" });
});

test("tool_execution_end clears the tool name but stays working", () => {
  const prev = { state: "working", tool: "bash" };
  assert.deepEqual(reduce(prev, { type: "tool_execution_end" }), { state: "working", tool: "" });
});

test("agent_settled idle → IDLE", () => {
  assert.deepEqual(reduce({ state: "working", tool: "bash" }, { type: "agent_settled", isIdle: true }), IDLE);
});

test("agent_settled while not idle is a no-op (auto-retry/compact may continue)", () => {
  const prev = { state: "working", tool: "bash" };
  assert.deepEqual(reduce(prev, { type: "agent_settled", isIdle: false }), prev);
});

test("session_shutdown quit → IDLE", () => {
  assert.deepEqual(reduce(WORKING, { type: "session_shutdown", reason: "quit" }), IDLE);
});

test("session_shutdown reload/new/resume/fork is a no-op (extension rebinds)", () => {
  const prev = { state: "working", tool: "bash" };
  for (const reason of ["reload", "new", "resume", "fork"]) {
    assert.deepEqual(reduce(prev, { type: "session_shutdown", reason }), prev);
  }
});