# @getpipher/agent-status

> Pi coding-agent lifecycle state as a live spinner in your tmux status bar — working / idle at a glance, per pane.

A [pi coding-agent](https://github.com/earendil-works/pi-coding-agent) extension
that listens to pi lifecycle events (`agent_start`, `agent_settled`,
`tool_execution_start`) and writes agent state to **tmux pane-local user
options** (`@agent_state`, `@agent_spinner`, `@agent_tool`). Your tmux status
bar and active window tab render them as a live, animated spinner — so when a
pi agent is running inside a tmux window, you see it working at a glance,
without polling every terminal.

Inspired by [herdr](https://herdr.dev)'s per-pane agent-state spinner, but
targets your **existing tmux** instead of herdr's sidebar. When pi runs under
herdr, this extension defers to herdr's own pi integration.

## Status

v0.1.0 — spec stage. See
[`docs/superpowers/specs/2026-07-27-agent-status-tmux-design.md`](docs/superpowers/specs/2026-07-27-agent-status-tmux-design.md).

## Install (planned)

Add to `~/.pi/agent/settings.json` `packages`:

```json
"npm:@getpipher/agent-status"
```

Then source the tmux format snippet in `~/.tmux.conf`:

```tmux
run-shell ~/local-dev/getpipher/agent-status/tmux/agent-status.tmux
```

## License

MIT