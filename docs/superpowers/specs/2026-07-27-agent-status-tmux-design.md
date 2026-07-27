# @getpipher/agent-status — Design Spec

**Date:** 2026-07-27
**Status:** Approved (pending user review of written spec)
**Package:** `@getpipher/agent-status` — public, `getpipher/agent-status`
**Scope:** v1 (working / idle + animated spinner + current tool name)

---

## 1. Purpose

A [pi coding-agent](https://github.com/earendil-works/pi-coding-agent) extension
that reads pi lifecycle events and writes agent state to **tmux pane-local user
options**, which the user's tmux status bar and active window tab render as a
live spinner. Single concern: **pi lifecycle → tmux display**.

Inspired by [herdr](https://herdr.dev)'s per-pane agent-state spinner, but
targets the user's **existing tmux** instead of herdr's sidebar/socket. When pi
runs under herdr, herdr's own pi extension handles state; this extension defers
(see §5).

## 2. Non-goals (v1 and beyond)

- ❌ **Blocked state** — explicitly out of scope (user decision). pi emits no
  native "waiting for permission" event; accurate detection is fragile. Not v1,
  not planned for v2.
- ❌ **Done-linger** (✓ visible for N seconds after settle) — out of v1.
- ❌ **State rollups** across panes/windows/workspaces.
- ❌ **herdr socket sink** or any non-tmux sink (i3/wezterm bars, etc.).
- ❌ **Auto-patching** the user's `.tmux.conf`.
- ❌ **Renaming** the user's tmux windows.

## 3. Event → state map (the whole logic core)

| pi event | `@agent_state` | `@agent_tool` | spinner timer |
|---|---|---|---|
| `session_start` (hasUI) | restore: `working` if `ctx.isIdle()===false`, else `idle` | — | start if working, else stop |
| `agent_start` | `working` | — | start (animated) |
| `tool_execution_start` | `working` | `<toolName>` (bash, read, edit, …) | running |
| `tool_execution_end` | `working` | clear | running |
| `agent_settled` and `ctx.isIdle()===true` | `idle` | clear | stop (◉) |
| `session_shutdown` (reason `quit`) | clear options | clear | stop + teardown |

This mirrors herdr's canonical mapping (from
`~/.pi/agent/extensions/herdr-agent-state.ts`) **minus blocked**.

`agent_end` is intentionally **not** used for `idle` — pi may still auto-retry,
auto-compact-and-retry, or process queued follow-ups after `agent_end`. Only
`agent_settled` (with `ctx.isIdle()===true`) means "done running automatically."

## 4. tmux sink & display

| concern | choice |
|---|---|
| Option scope | **pane-local** — `tmux set-option -p` on `$TMUX_PANE`; each pi pane tracks independently |
| Options written | `@agent_state` (`working` \| `idle`), `@agent_spinner` (braille glyph), `@agent_tool` (tool name or empty) |
| Spinner animation | `setInterval` ~80ms cycling `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, writes `@agent_spinner` + `tmux refresh-client -S` (throttled to ≤~12/s) while `working`; stopped on `idle` |
| Status bar readout | user wires a shipped format snippet into `status-left`; reads `@agent_state`/`@agent_spinner`/`@agent_tool` via `#{?#{==:#{@agent_state},working},…,…}` conditionals |
| Window tab readout | `window-status-current-format` snippet prefixes the active window with the colored glyph |
| Repaint | `refresh-client -S` per animation frame; global `status-interval` untouched |
| Colors (catppuccin macchiato) | `working` → green `#a6da95`; `idle` → overlay_0 `#6e738d`; separators → overlay_0 |
| Glyphs | `working` = animated braille; `idle` = `◉` |

The shipped tmux snippet (`tmux/agent-status.tmux`) is **opt-in**: the extension
writes the options; the user sources the snippet (or pastes the format lines)
into their `.tmux.conf`. v1 does not auto-patch config.

## 5. Guards & coexistence

| case | behavior |
|---|---|
| not in tmux (`$TMUX` / `$TMUX_PANE` unset) | extension no-ops on load |
| `tmux` binary missing or not on PATH | no-op, never throw |
| any `tmux set-option`/`refresh-client` call fails | swallow + stop timer (status is cosmetic; never crashes pi or blocks the agent) |
| running under herdr (`HERDR_ENV=1`) | our extension no-ops, deferring to herdr's own pi extension (which is dormant unless `HERDR_ENV`+`HERDR_SOCKET_PATH`+`HERDR_PANE_ID` are set) |
| session reload (`/reload`, `/new`, `/resume`, `/fork`) | re-bind via `session_start`; do **not** clear options on non-`quit` shutdown (matches herdr's `shouldReleaseOnSessionShutdown`) |
| multiple panes / multiple pi's | each writes its own pane options; `status-left` shows the focused pane's state; the window tab shows the active pane's state |

## 6. Architecture / components

```
@getpipher/agent-status/
├── extensions/agent-status.ts   # pi extension: event listeners + state reducer + spinner timer
├── lib/tmux.ts                  # tmux CLI helper: set-option -p, refresh-client -S, pane id, no-op guards, throttle
├── tmux/agent-status.tmux       # opt-in format snippet for status-left + window-status-current-format
├── test/
│   ├── tmux.test.ts             # mocked tmux CLI: option writes, pane-id, refresh throttle, no-op when unset
│   ├── reducer.test.ts          # pure event→state reducer: event sequences → option writes + timer start/stop
│   └── integration.test.ts      # real detached tmux session (via @getpipher/term) + pi RPC; assert option transitions
├── docs/superpowers/specs/2026-07-27-agent-status-tmux-design.md   # this file
├── README.md
├── AGENTS.md
├── LICENSE
├── package.json
└── tsconfig.json
```

### Unit boundaries

- **`lib/tmux.ts`** — one job: talk to tmux CLI safely. No pi knowledge. Exports
  `setEnabled`, `setState(pane, state, tool?)`, `setSpinner(pane, glyph)`,
  `clear(pane)`, `startSpinner(pane, onTick)`, `stopSpinner()`. All swallow
  errors; all no-op when `$TMUX_PANE` unset or `HERDR_ENV=1` or `tmux` missing.
- **`extensions/agent-status.ts`** — one job: map pi events to `lib/tmux.ts`
  calls. Holds the working/idle reducer state per session. No tmux CLI calls
  directly.
- **`tmux/agent-status.tmux`** — one job: format strings. No logic.

### Data flow

```
pi event ──► agent-status.ts (reducer) ──► lib/tmux.ts ──► tmux set-option -p
                                                │
                                                └► setInterval ──► tmux refresh-client -S
tmux status-left / window-status-current-format  ◄── reads @agent_* options ──► rendered bar
```

## 7. Error handling

Status display is **purely cosmetic**. No failure in this extension may block
the agent, throw into pi's event loop, or crash the session. Every tmux call is
wrapped; every handler is fail-safe. The spinner timer is always clearable on
`session_shutdown`.

## 8. Testing

| layer | what | how |
|---|---|---|
| unit — tmux lib | option writes, pane-id resolution, refresh throttle, no-op when `$TMUX` unset / `HERDR_ENV=1` / `tmux` missing | mock `child_process` / tmux binary |
| unit — reducer | event sequences → expected option writes + timer start/stop | pure function, feed events, assert calls |
| integration | real detached tmux session via `@getpipher/term` + pi RPC session; assert `tmux show-options -p @agent_state` transitions `working`→`idle` | `tsx --test` |
| live QA | `term` tool driving a tmux window running pi, capturing the status bar format expansion | manual / scripted |

Coverage target: 80%+ on new code (per global standard).

## 9. Packaging & repo

| field | value |
|---|---|
| org/repo | `getpipher/agent-status` (public) |
| npm name | `@getpipher/agent-status` |
| description | `Pi coding-agent lifecycle state as a live spinner in your tmux status bar — working / idle at a glance, per pane.` |
| topics | `pi` `pi-coding-agent` `tmux` `tmux-status-bar` `agent-status` `coding-agent` `terminal` `developer-tools` `catppuccin` `agent-multiplexer` |
| license | MIT |
| author | RECTOR <rector@rectorspace.com> |
| install | add `"npm:@getpipher/agent-status"` to `~/.pi/agent/settings.json` `packages`; source `tmux/agent-status.tmux` snippet into `~/.tmux.conf` |
| peer deps | `@earendil-works/pi-coding-agent`, `typebox` |
| node | `>=20` |

## 10. Open questions for implementation plan

- Exact throttle rate for `refresh-client -S` (12/s is a placeholder; verify no
  visible flicker / CPU cost on a long run).
- Whether `@agent_tool` should show the *raw* tool name or a friendlier label
  (`bash` vs ` Bash`). Default: raw, lowercased.
- Snippet placement guidance for non-catppuccin users (provide a plain variant).