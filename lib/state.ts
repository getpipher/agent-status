import type { AgentState } from "./tmux.ts";

export interface StateSnapshot {
  state: AgentState;
  tool: string;
}

export type AgentEvent =
  | { type: "session_start"; isIdle: boolean }
  | { type: "agent_start" }
  | { type: "tool_execution_start"; toolName: string }
  | { type: "tool_execution_end" }
  | { type: "agent_end"; settled: boolean }
  | { type: "agent_settled"; isIdle: boolean }
  | { type: "session_shutdown"; reason: string };

export const IDLE: StateSnapshot = { state: "idle", tool: "" };
export const WORKING: StateSnapshot = { state: "working", tool: "" };

export function reduce(prev: StateSnapshot, event: AgentEvent): StateSnapshot {
  switch (event.type) {
    case "session_start":
      return event.isIdle ? IDLE : { state: "working", tool: prev.tool };
    case "agent_start":
      return { state: "working", tool: "" };
    case "tool_execution_start":
      return { state: "working", tool: event.toolName };
    case "tool_execution_end":
      return { state: "working", tool: "" };
    case "agent_end":
      return event.settled ? IDLE : prev;
    case "agent_settled":
      return event.isIdle ? IDLE : prev;
    case "session_shutdown":
      return event.reason === "quit" ? IDLE : prev;
    default:
      return prev;
  }
}