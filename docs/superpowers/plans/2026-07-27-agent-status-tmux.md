# @getpipher/agent-status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a pi extension that writes pi agent lifecycle state (working/idle + animated braille spinner + current tool name) to tmux pane-local user options, rendered in the user's tmux status bar and active window tab.

**Architecture:** Three small lib modules behind one pi extension. `lib/state.ts` is a pure event→state reducer (no I/O). `lib/tmux.ts` is the tmux CLI sink (exec seam + env guards, all calls fail-safe, **never touches a global option**). `lib/spinner.ts` is a pure braille-frame advancer (no `setInterval` in the default path — the extension advances a frame on each state transition). `extensions/agent-status.ts` is the composition root that wires pi lifecycle events → reducer → tmux writes + spinner advance, and refreshes the status line **only on transitions, throttled ≤2/s**. A shipped `tmux/agent-status.tmux` format snippet (opt-in, additive) renders the options in the bar.

**Tech Stack:** TypeScript (ESM, Node ≥20), `@earendil-works/pi-coding-agent` extension API, `typebox`, `node:child_process` (tmux CLI), `node:test` + `tsx` for tests, `@getpipher/term` for the integration test's real tmux session.

## Global Constraints

- **Node ≥20**, ESM (`"type": "module"`), `.ts` import extensions in source.
- **Never mutate global tmux options** (`set -g`). All writes are **pane-local**: `tmux set-option -p -t <pane>`. Global mutations leak across the whole server (the prototype isolation gotcha).
- **Status display is cosmetic.** Every tmux call is wrapped; no failure may throw into pi's event loop, block the agent, or crash the session. Swallow + stop timer on any error.
- **Coexist with herdr.** No-op when `HERDR_ENV=1` (herdr's own pi extension owns state there).
- **No-op when not in tmux** (`$TMUX` / `$TMUX_PANE` unset) or `tmux` binary missing.
- **v1 scope = working/idle + spinner + tool name only.** No blocked, no done-linger, no rollups, no auto-config-patch.
- **NEVER touch existing UI (non-breakage is a hard requirement).** The extension writes **only** pane-local `@agent_state` / `@agent_spinner` / `@agent_tool` via `tmux set-option -p`. It **must never** write (set or unset) any of: `status-interval`, `status-left`, `status-right`, `window-status-format`, `window-status-current-format`, `status-position`, `status-style`, `status-bg`/`-fg`, or any `@thm_*` / `@catppuccin_*` theme option. The tmux snippet **defines** `@agent_status_format` / `@agent_window_tab` (new user options) and **never sets** `status-left` / `window-status-*` — the user pastes the segment themselves with `set -ga` (additive).
- **Refresh policy (protects the user's `#(...)` status scripts).** `tmux refresh-client -S` is called **only on state transitions** (`agent_start`, `tool_execution_start`, `tool_execution_end`, `agent_settled`), **throttled to ≤~2/s** (min 400ms between refreshes). **While idle: zero timers, zero refreshes** — the user's bar is byte-identical to a machine without the extension. The extension **never lowers `status-interval`**. (Rationale: `refresh-client -S` forces a status redraw which re-runs `#(...)` status scripts; per-frame refresh would re-run the user's cpu/mem/battery/continuum/df scripts at the refresh rate — a CPU spike and metric churn. Transition-only + throttle bounds this to negligible.)
- **Spinner motion is transition-driven, not wall-clock.** The braille frame advances on each state transition. A smooth 12fps `setInterval` mode is **opt-in and off by default** (documented; user also lowers their own `status-interval` if they accept the script-cadence tradeoff). v1 ships transition-driven only.
- **TDD.** Write failing test → run (fail) → implement → run (pass) → commit. One commit per task.
- **GPG-signed commits** (global `commit.gpgsign=true`, key `BF47B9DC1FA320FA`). Do not set local `gpg.format`/`user.signingkey` overrides.
- 2-space indent, no AI attribution, MIT license.

---

## File Structure

| file | responsibility |
|---|---|
| `lib/tmux.ts` | tmux CLI sink: exec seam (`setExec`/`defaultTmuxExec`), env guards (`setEnabled`/`paneId`/`enabled`), `setState`/`setSpinner`/`clear`/`refreshStatus`. All fail-safe, all no-op when disabled. No pi knowledge. |
| `lib/spinner.ts` | pure braille frames + `createSpinner()` → `{advance, reset, current}`. No `setInterval`, no I/O — `advance()` returns the frame string. |
| `lib/state.ts` | pure event→state reducer: `reduce(prev, event) → {state, tool}`. No I/O. |
| `extensions/agent-status.ts` | composition root: registers pi lifecycle handlers, calls `reduce` → `tmux.setState` + `spinner.advance()` + `tmux.refreshStatus` (throttled). Guards `enabled()` on load. Inert while idle. |
| `tmux/agent-status.tmux` | opt-in format snippet for `status-left` + `window-status-current-format` (catppuccin macchiato colors). |
| `test/tmux.test.ts` | unit: mocked exec asserts exact tmux args + no-op-when-disabled. |
| `test/spinner.test.ts` | unit: `frameAt` pure + `createSpinner` `advance`/`reset`/`current` (no timers). |
| `test/state.test.ts` | unit: reducer event sequences. |
| `test/extension.test.ts` | unit: fake `ExtensionAPI` event emitter drives the extension → asserts tmux calls + spinner. |
| `test/integration.test.ts` | integration: real detached tmux session via `@getpipher/term`; real `defaultTmuxExec`; assert `tmux show-options -p` reflects `setState`. |

**Refinement vs spec §6:** the reducer is split out of `extensions/agent-status.ts` into `lib/state.ts` for pure-unit testability (spec §8 called for `reducer.test.ts`; this makes it real). The spinner timer is split into `lib/spinner.ts` for the same reason. These are responsibility splits, fully consistent with the spec's unit-boundary intent.

---

### Task 1: Project deps + `lib/tmux.ts` (tmux CLI sink)

**Files:**
- Create: `lib/tmux.ts`
- Create: `test/tmux.test.ts`
- Modify: `package.json` (already scaffolded — run `pnpm install` to materialize devDeps)

**Interfaces:**
- Produces: `setExec(fn)`, `defaultTmuxExec(args)`, `setGuards(pane?, herdr?, tmuxEnv?)`, `enabled()`, `paneId()`, `type AgentState = "working"|"idle"`, `setState(pane, state, tool?)`, `setSpinner(pane, glyph)`, `clear(pane)`, `refreshStatus(pane)`. Consumed by Tasks 4 and 6.

- [ ] **Step 1: Install deps**

Run: `pnpm install`
Expected: `node_modules/` created, `@earendil-works/pi-coding-agent`, `typebox`, `tsx`, `typescript`, `@getpipher/term` resolved.

- [ ] **Step 2: Write the failing test**

`test/tmux.test.ts`:
```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:run test/tmux.test.ts`
Expected: FAIL — `Cannot find module '../lib/tmux.ts'` / functions undefined.

- [ ] **Step 4: Write minimal implementation**

`lib/tmux.ts`:
```ts
import { spawn } from "node:child_process";

export type AgentState = "working" | "idle";

// --- Exec seam ---------------------------------------------------------------
export type ExecFn = (args: string[]) => Promise<string>;
let exec: ExecFn = defaultTmuxExec;
export function setExec(fn: ExecFn): void { exec = fn; }

export async function defaultTmuxExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`tmux ${args.join(" ")} exited ${code}`))));
    p.on("error", reject);
  });
}

// --- Env guards (all injectable for tests) -----------------------------------
let paneFn: () => string | undefined = () => process.env.TMUX_PANE;
let herdrFn: () => boolean = () => process.env.HERDR_ENV === "1";
let tmuxEnvFn: () => string | undefined = () => process.env.TMUX;

export function setGuards(
  pane?: () => string | undefined,
  herdr?: () => boolean,
  tmuxEnv?: () => string | undefined,
): void {
  if (pane) paneFn = pane;
  if (herdr) herdrFn = herdr;
  if (tmuxEnv) tmuxEnvFn = tmuxEnv;
}

export function enabled(): boolean {
  return !!tmuxEnvFn() && !!paneFn() && !herdrFn();
}
export function paneId(): string | undefined { return paneFn(); }

// --- Fail-safe runner: no-op when disabled, swallow on error -----------------
async function run(args: string[]): Promise<void> {
  if (!enabled()) return;
  try { await exec(args); } catch { /* cosmetic — never throw into pi */ }
}

export async function setState(pane: string, state: AgentState, tool?: string): Promise<void> {
  await run(["set-option", "-p", "-t", pane, "@agent_state", state]);
  await run(["set-option", "-p", "-t", pane, "@agent_tool", tool ?? ""]);
}

export async function setSpinner(pane: string, glyph: string): Promise<void> {
  await run(["set-option", "-p", "-t", pane, "@agent_spinner", glyph]);
}

export async function clear(pane: string): Promise<void> {
  await run(["set-option", "-p", "-u", "-t", pane, "@agent_state"]);
  await run(["set-option", "-p", "-u", "-t", pane, "@agent_spinner"]);
  await run(["set-option", "-p", "-u", "-t", pane, "@agent_tool"]);
}

// --- Refresh throttle: protect the user's #(...) status scripts --------------
// refresh-client -S forces a status redraw which re-runs #(...) status-left/-right
// scripts. Transition-only + this throttle bound the overhead to <=~2/s.
let nowFn: () => number = () => Date.now();
export function setNow(fn: () => number): void { nowFn = fn; }
let lastRefreshAt = 0;
export const REFRESH_MIN_MS = 400;
export function _resetThrottleForTests(): void { lastRefreshAt = 0; }

export async function refreshStatus(pane: string): Promise<void> {
  if (!enabled()) return;
  if (nowFn() - lastRefreshAt < REFRESH_MIN_MS) return; // throttle
  lastRefreshAt = nowFn();
  try {
    const session = (await exec(["display-message", "-p", "-t", pane, "#{session_name}"])).trim();
    const clients = (await exec(["list-clients", "-t", session, "-F", "#{client_name}"]))
      .trim().split("\n").filter(Boolean);
    for (const c of clients) {
      try { await exec(["refresh-client", "-S", "-t", c]); } catch { /* swallow per-client */ }
    }
  } catch { /* swallow — cosmetic */ }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:run test/tmux.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/tmux.ts test/tmux.test.ts pnpm-lock.yaml
git commit -m "feat(tmux-lib): pane-local tmux option sink with fail-safe guards"
```

---

### Task 2: `lib/spinner.ts` (braille spinner timer)

**Files:**
- Create: `lib/spinner.ts`
- Create: `test/spinner.test.ts`

**Interfaces:**
- Produces: `FRAMES`, `frameAt(i)`, `createSpinner() → {advance, reset, current}` (`advance()` returns the next frame string). Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

`test/spinner.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameAt, createSpinner, FRAMES } from "../lib/spinner.ts";

test("frameAt cycles through the 10 braille frames", () => {
  for (let i = 0; i < FRAMES.length; i++) assert.equal(frameAt(i), FRAMES[i]);
  assert.equal(frameAt(FRAMES.length), FRAMES[0]);
  assert.equal(frameAt(13), FRAMES[3]);
});

test("advance() returns sequential frames and increments", () => {
  const spinner = createSpinner();
  assert.equal(spinner.advance(), FRAMES[0]);
  assert.equal(spinner.advance(), FRAMES[1]);
  assert.equal(spinner.advance(), FRAMES[2]);
});

test("advance() wraps after FRAMES.length", () => {
  const spinner = createSpinner();
  for (let i = 0; i < FRAMES.length; i++) spinner.advance();
  assert.equal(spinner.advance(), FRAMES[0]); // wrapped
});

test("reset() returns the index to 0", () => {
  const spinner = createSpinner();
  spinner.advance(); spinner.advance();
  spinner.reset();
  assert.equal(spinner.advance(), FRAMES[0]);
});

test("current() returns the next frame without advancing", () => {
  const spinner = createSpinner();
  assert.equal(spinner.current(), FRAMES[0]);
  spinner.advance();
  assert.equal(spinner.current(), FRAMES[1]);
});
```

> Note: no `setInterval` is used in the default path — the spinner advances on `advance()` calls driven by pi state transitions (Task 4). This keeps the user's `#(...)` status scripts from being re-run at a high rate. See Global Constraints → Refresh policy.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/spinner.test.ts`
Expected: FAIL — `Cannot find module '../lib/spinner.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/spinner.ts`:
```ts
export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function frameAt(i: number): string {
  return FRAMES[((i % FRAMES.length) + FRAMES.length) % FRAMES.length];
}

export interface Spinner {
  advance(): string;  // return current frame, then increment index
  reset(): void;      // index back to 0 (call on idle)
  current(): string;  // peek next frame without advancing
}

// No setInterval in the default path — the extension calls advance() on each
// pi state transition and writes the returned frame via tmux.setSpinner. Smooth
// 12fps animation is an opt-in mode (see plan §10), intentionally not shipped
// in v1 to avoid re-running the user's #(...) status scripts at high rate.
export function createSpinner(): Spinner {
  let i = 0;
  return {
    advance() { const g = frameAt(i); i++; return g; },
    reset() { i = 0; },
    current() { return frameAt(i); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/spinner.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/spinner.ts test/spinner.test.ts
git commit -m "feat(spinner): braille frame advancer (transition-driven, no setInterval)"
```

---

### Task 3: `lib/state.ts` (pure event→state reducer)

**Files:**
- Create: `lib/state.ts`
- Create: `test/state.test.ts`

**Interfaces:**
- Produces: `type AgentEvent`, `interface StateSnapshot`, `IDLE`, `WORKING`, `reduce(prev, event) → StateSnapshot`. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

`test/state.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/state.test.ts`
Expected: FAIL — `Cannot find module '../lib/state.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/state.ts`:
```ts
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
    case "agent_settled":
      return event.isIdle ? IDLE : prev;
    case "session_shutdown":
      return event.reason === "quit" ? IDLE : prev;
    default:
      return prev;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/state.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/state.ts test/state.test.ts
git commit -m "feat(state): pure pi event → working/idle reducer"
```

---

### Task 4: `extensions/agent-status.ts` (composition root)

**Files:**
- Create: `extensions/agent-status.ts`
- Create: `test/extension.test.ts`

**Interfaces:**
- Consumes: `lib/tmux.ts` (`enabled`, `paneId`, `setState`, `setSpinner`, `clear`, `refreshStatus`, `setExec`, `setGuards`), `lib/spinner.ts` (`createSpinner`), `lib/state.ts` (`reduce`, `IDLE`, `WORKING`, `StateSnapshot`), `ExtensionAPI` from `@earendil-works/pi-coding-agent`.
- Produces: default-exported `agentStatus(pi: ExtensionAPI): void` — the pi extension entry point referenced by `package.json` `pi.extensions`.

- [ ] **Step 1: Write the failing test**

`test/extension.test.ts`:
```ts
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
```

> Note: dynamic `import("../extensions/agent-status.ts")` in each test ensures the module's top-level `enabled()` guard is re-evaluated under the current injected env. If the module loader caches the module, reset state by changing env before the first import in each test (the first test sets tmuxEnv="" before any import of the extension — ensure that test runs first, or use `import()` once after env setup). If flaky, switch to a single import after env setup and skip the disabled-on-load tests' re-import by structuring setup before the first `import()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/extension.test.ts`
Expected: FAIL — `Cannot find module '../extensions/agent-status.ts'`.

- [ ] **Step 3: Write minimal implementation**

`extensions/agent-status.ts`:
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as tmux from "../lib/tmux.ts";
import { createSpinner } from "../lib/spinner.ts";
import { reduce, IDLE, type StateSnapshot } from "../lib/state.ts";

export default function agentStatus(pi: ExtensionAPI): void {
  if (!tmux.enabled()) return;
  const pane = tmux.paneId();
  if (!pane) return;

  let snap: StateSnapshot = IDLE;
  const spinner = createSpinner();

  function isIdle(ctx: any): boolean {
    return typeof ctx?.isIdle === "function" ? ctx.isIdle() : true;
  }

  // Called on every state transition. Writes pane-local options, advances the
  // spinner frame while working, and refreshes the status line (throttled ≤2/s).
  // While idle this is never called again after the final settle, so the bar is
  // inert — byte-identical to a machine without the extension.
  async function publish(next: StateSnapshot): Promise<void> {
    if (next.state === snap.state && next.tool === snap.tool) return;
    snap = next;
    await tmux.setState(pane, snap.state, snap.tool);
    if (snap.state === "working") {
      await tmux.setSpinner(pane, spinner.advance());
    } else {
      spinner.reset();
    }
    await tmux.refreshStatus(pane); // throttled; no-op if within REFRESH_MIN_MS
  }

  pi.on("session_start", async (_e, ctx) => {
    if (ctx?.hasUI !== true) return;
    await publish(reduce(snap, { type: "session_start", isIdle: isIdle(ctx) }));
  });
  pi.on("agent_start", async () => {
    await publish(reduce(snap, { type: "agent_start" }));
  });
  pi.on("tool_execution_start", async (e) => {
    await publish(reduce(snap, { type: "tool_execution_start", toolName: (e as any)?.toolName ?? "" }));
  });
  pi.on("tool_execution_end", async () => {
    await publish(reduce(snap, { type: "tool_execution_end" }));
  });
  pi.on("agent_settled", async (_e, ctx) => {
    await publish(reduce(snap, { type: "agent_settled", isIdle: isIdle(ctx) }));
  });
  pi.on("session_shutdown", async (e) => {
    const reason = (e as any)?.reason ?? "quit";
    if (reason === "quit") {
      spinner.reset();
      await tmux.clear(pane);
      snap = IDLE;
    } else {
      // reload/new/resume/fork: the extension runtime rebinds; don't clear.
      await publish(reduce(snap, { type: "session_shutdown", reason }));
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/extension.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-status.ts test/extension.test.ts
git commit -m "feat(extension): wire pi lifecycle events → tmux state + spinner"
```

---

### Task 5: `tmux/agent-status.tmux` snippet + README install docs

**Files:**
- Create: `tmux/agent-status.tmux`
- Modify: `README.md` (install section — replace "planned" placeholder with real snippet instructions)
- Create: `test/snippet.test.ts` (smoke: snippet sources without error in a real detached tmux)

**Interfaces:**
- Produces: a tmux format snippet users `source-file` into their config; sets `status-left` augmentation is **opt-in by pasting**, not auto-applied. The snippet only defines a reusable format chunk `@agent_status_format` the user inserts into their own `status-left`/`window-status-current-format` — it does **not** set `status-left` itself (avoids the global-mutation gotcha).

- [ ] **Step 1: Write the failing test**

`test/snippet.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import * as term from "@getpipher/term";
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

test("snippet sources without error in a detached tmux session", async () => {
  const sess = await term.spawn({ command: "tmux", args: ["new", "-d", "-s", "snippet-smoke"] });
  // The snippet defines a user option @agent_status_format; sourcing must not error.
  await tmux(["source-file", snippetPath, "-t", sess.pane]);
  const fmt = await tmux(["show-options", "-g", "@agent_status_format", "-t", sess.pane]);
  assert.ok(fmt.includes("@agent_status_format"), "snippet defined @agent_status_format");
  await term.kill(sess.pane);
});

test("non-regression: snippet changes NO existing global status/theme option", async () => {
  const sess = await term.spawn({ command: "tmux", args: ["new", "-d", "-s", "nonreg"] });
  const pane = sess.pane;
  try {
    const snap = (await tmuxRead(["show-options", "-g", "-t", pane])).split("\n").filter(Boolean);
    await tmux(["source-file", snippetPath, "-t", pane]);
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
      const key = line.split(" ")[0].replace(/^"|"$/g, "");
      assert.ok(allowed.has(key), `snippet added an unexpected global option: ${line}`);
    }
  } finally {
    await term.kill(pane);
  }
});

test("non-regression: extension writes ONLY pane-local @agent_* options, never global", async () => {
  const sess = await term.spawn({ command: "tmux", args: ["new", "-d", "-s", "nonreg-ext"] });
  const pane = sess.pane;
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
    await term.kill(pane);
  }
});

  const sess = await term.spawn({ command: "tmux", args: ["new", "-d", "-s", "snippet-expand"] });
  await tmux(["source-file", snippetPath, "-t", sess.pane]);
  await tmux(["set-option", "-g", "@agent_state", "working", "-t", sess.pane]);
  await tmux(["set-option", "-g", "@agent_spinner", "⠼", "-t", sess.pane]);
  await tmux(["set-option", "-g", "@agent_tool", "bash", "-t", sess.pane]);
  const rendered = await tmux(["display-message", "-p", "-t", sess.pane, "#{E:#{@agent_status_format}}"]);
  assert.match(rendered, /working/);
  assert.match(rendered, /bash/);
  await term.kill(sess.pane);
});
```

> Note: adjust the `#{E:...}` expansion form if the installed tmux version doesn't expand a user option holding format text via `#{E:...}`; alternative is to define the snippet as a direct `status-left` fragment the user pastes. The test's intent: the format string the snippet defines expands and contains `working` + `bash` when the `@agent_*` options are set.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/snippet.test.ts`
Expected: FAIL — `tmux/agent-status.tmux` missing / `@agent_status_format` not defined.

- [ ] **Step 3: Write minimal implementation**

`tmux/agent-status.tmux`:
```tmux
# @getpipher/agent-status — opt-in tmux format snippet (catppuccin macchiato).
# Source this file, then reference #{@agent_status_format} inside your status-left
# (or window-status-current-format). This snippet does NOT set status-left itself —
# paste the segment where you want it so we never mutate your global bar layout.
#
# Required options written by the extension (pane-local):
#   @agent_state   "working" | "idle"
#   @agent_spinner braille glyph (animated while working)
#   @agent_tool    tool name or empty
#
# Usage in ~/.tmux.conf:
#   source-file ~/local-dev/getpipher/agent-status/tmux/agent-status.tmux
#   set -ga status-left "#{@agent_status_format}"

set -g @agent_status_format "#{?#{||:#{==:#{@agent_state},working},#{==:#{@agent_state},idle}},#[bg=#{@thm_bg},fg=#{@thm_overlay_0},none]│#[bg=#{@thm_bg}]#{?#{==:#{@agent_state},working},#[fg=#{@thm_green}] #{@agent_spinner} working,#[fg=#{@thm_overlay_0}] ◉ idle}#{?#{!=:#{@agent_tool},},#[fg=#{@thm_overlay_0}] · #{@agent_tool},} ,}"

# Optional: prefix the active window tab with the colored glyph.
set -g @agent_window_tab "#{?#{||:#{==:#{@agent_state},working},#{==:#{@agent_state},idle}},#{?#{==:#{@agent_state},working},#[fg=#{@thm_green}]#{@agent_spinner} ,#[fg=#{@thm_overlay_0}]◉ },}"
# Use as: set -g window-status-current-format " #I#{@agent_window_tab}#W "
```

Update `README.md` install section:
```markdown
## Install

Add to `~/.pi/agent/settings.json` `packages`:

```json
"npm:@getpipher/agent-status"
```

Source the tmux format snippet in `~/.tmux.conf` and append it to your status-left:

```tmux
source-file ~/local-dev/getpipher/agent-status/tmux/agent-status.tmux
set -ga status-left "#{@agent_status_format}"
# optional active-window tab glyph:
set -g window-status-current-format " #I#{@agent_window_tab}#W "
```

Reload tmux (`prefix + r` or `tmux source ~/.tmux.conf`). When a pi agent runs in a
tmux pane, the bar shows `⠼ working · <tool>` (animated) while it works and `◉ idle`
when settled.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run test/snippet.test.ts`
Expected: PASS (4 tests) — snippet-source, format-expand, and two non-regression tests. (Requires `tmux` installed; skip via `test.skip` if `tmux` missing on CI — guard with a `tmux --version` check.)

- [ ] **Step 5: Commit**

```bash
git add tmux/agent-status.tmux test/snippet.test.ts README.md
git commit -m "feat(tmux): opt-in catppuccin status-left/window-tab format snippet"
```

---

### Task 6: Integration test — real tmux sink end-to-end

**Files:**
- Create: `test/integration.test.ts`

**Interfaces:**
- Consumes: `lib/tmux.ts` real `defaultTmuxExec`, `@getpipher/term` `spawn`/`kill`. Spawns a real detached tmux session, points the lib's guards at the real pane, calls `setState`/`clear`, and asserts via a separate `tmux show-options -p` read.

- [ ] **Step 1: Write the failing test**

`test/integration.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as term from "@getpipher/term";
import * as tmux from "../lib/tmux.ts";

async function showOpt(pane: string, name: string): Promise<string | undefined> {
  const out = await term.capture(pane); // not used; use tmux lib directly instead
  void out;
  return undefined;
}

// Direct tmux read (separate exec, not the lib under test) to avoid self-fulfilling.
import { spawn } from "node:child_process";
async function tmuxRead(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", (c) => (c === 0 ? resolve(out) : resolve("")));
    p.on("error", reject);
  });
}

test("setState writes pane-local options readable via tmux show-options -p", async () => {
  const sess = await term.spawn({ command: "tmux", args: ["new", "-d", "-s", "integ-1"] });
  const pane = sess.pane;
  try {
    tmux.setExec(tmux.defaultTmuxExec);
    tmux.setGuards(() => pane, () => false, () => "yes");
    await tmux.setState(pane, "working", "bash");
    const state = (await tmuxRead(["show-options", "-p", "-t", pane, "@agent_state"])).trim();
    const tool = (await tmuxRead(["show-options", "-p", "-t", pane, "@agent_tool"])).trim();
    assert.match(state, /working/);
    assert.match(tool, /bash/);
  } finally {
    await term.kill(pane);
  }
});

test("clear unsets the pane-local options", async () => {
  const sess = await term.spawn({ command: "tmux", args: ["new", "-d", "-s", "integ-2"] });
  const pane = sess.pane;
  try {
    tmux.setExec(tmux.defaultTmuxExec);
    tmux.setGuards(() => pane, () => false, () => "yes");
    await tmux.setState(pane, "working", "read");
    await tmux.clear(pane);
    const state = (await tmuxRead(["show-options", "-p", "-t", pane, "@agent_state"])).trim();
    assert.equal(state, "", "option unset after clear");
  } finally {
    await term.kill(pane);
  }
});

test("setSpinner writes @agent_spinner", async () => {
  const sess = await term.spawn({ command: "tmux", args: ["new", "-d", "-s", "integ-3"] });
  const pane = sess.pane;
  try {
    tmux.setExec(tmux.defaultTmuxExec);
    tmux.setGuards(() => pane, () => false, () => "yes");
    await tmux.setSpinner(pane, "⠼");
    const sp = (await tmuxRead(["show-options", "-p", "-t", pane, "@agent_spinner"])).trim();
    assert.match(sp, /⠼/);
  } finally {
    await term.kill(pane);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run test/integration.test.ts`
Expected: FAIL or error if `tmux` not present; otherwise the lib already implements these — so this test should PASS once Tasks 1–4 are in. If it passes immediately, that's expected (it's a confirmation, not a TDD-red, since the impl exists). The value is end-to-end coverage of the real tmux CLI path.

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:run test/integration.test.ts`
Expected: PASS (3 tests). Requires `tmux` installed and `@getpipher/term` resolvable.

- [ ] **Step 4: Run the full suite + typecheck**

Run: `pnpm typecheck && pnpm test:run`
Expected: typecheck clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/integration.test.ts
git commit -m "test(integration): real tmux sink end-to-end via @getpipher/term"
```

---

## Post-implementation verification (not a code task)

- [ ] **Live QA in an isolated detached tmux session** (NOT the user's working config — see memory `tmux-prototype-isolation-gotcha.md`): `tmux new -d -s agent-status-live`, run `pi` inside it with the extension installed, source the snippet, and watch the bar transition `working`→`idle` through a real prompt. Verify the working glyph steps forward per tool call and the active window tab shows the glyph. **Idle must be fully inert** — after settle, confirm no further `refresh-client` calls (e.g. `tmux show-hooks` or a `dtrace`/`strace` on the pi process for a few seconds of idle — should see zero `tmux refresh-client` invocations).
- [ ] **Non-breakage live check on the user's REAL config (read-only)**: snapshot `tmux show-options -g` for `status-left`, `status-right`, `window-status-current-format`, `window-status-format`, `status-interval`, `status-position`, `status-style`, and all `@thm_*`/`@catppuccin_*` options. Then source the snippet + add the `set -ga status-left "#{@agent_status_format}}"` line + wire the extension. Run a pi prompt in a throwaway window. Re-snapshot. **Assert every pre-existing option is byte-identical.** The only new globals allowed: `@agent_status_format`, `@agent_window_tab` (defined by the snippet). If ANY existing option changed → block ship, fix.
- [ ] **No `set -g` audit**: `grep -rn 'set -g\|set-option -g\|set-option  *-g' lib/ extensions/ tmux/` must return zero matches. The extension and snippet never write a global option.
- [ ] **Coverage check**: `pnpm test:run -- --experimental-test-coverage` (or `c8`); confirm ≥80% on `lib/*` and `extensions/agent-status.ts`.
- [ ] **Coexistence check**: with `HERDR_ENV=1` set, confirm the extension registers no handlers (run `pi` under herdr, confirm herdr's spinner still owns).
- [ ] **npm publish prep**: `npm version 0.1.0`, `npm publish --access public` (account `rz1989`; if EOTP, RECTOR provides `--otp`). Update `README.md` status section.
- [ ] **Wire into local pi**: add `"npm:@getpipher/agent-status"` to `~/.pi/agent/settings.json` `packages`, `/reload`, source the snippet in `~/.tmux.conf`.