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

## Install

Add to `~/.pi/agent/settings.json` `packages`:

```json
"npm:@getpipher/agent-status"
```

Source the tmux format snippet in `~/.tmux.conf` and append it to your status-left:

```tmux
source-file ~/local-dev/getpipher/agent-status/tmux/agent-status.tmux
set -ga status-left "#{@agent_status_format}"
```

For the active window tab, insert `#{@agent_window_tab}` into your **existing**
`window-status-current-format` (do NOT replace your format — merge the segment).
For example, if your current format is `" #I:#W "`, adapt it to:

```tmux
set -g window-status-current-format " #I#{@agent_window_tab}#W "
```

Reload tmux (`prefix + r` or `tmux source ~/.tmux.conf`). When a pi agent runs in a
tmux pane, the bar shows `⠼ working · <tool>` (animated) while it works and `◉ idle`
when settled.

## License

MIT