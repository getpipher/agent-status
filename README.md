# @getpipher/agent-status

> Pi coding-agent lifecycle state as a **colored dot in your tmux window tab** — at-a-glance across all your pi windows, no polling.

A [pi coding-agent](https://github.com/earendil-works/pi-coding-agent) extension
that listens to pi lifecycle events and writes a **per-window rollup** of all
pi panes' state to a tmux window-scoped option, rendered as a single colored
dot in the window tab. No animation → no extra status-bar redraws → your
existing `#(...)` status scripts keep their normal cadence.

Inspired by [herdr](https://herdr.dev)'s per-pane state indicator, but targets
your **existing tmux** (window tabs) instead of herdr's sidebar. When pi runs
under herdr, this extension defers to herdr's own pi integration.

## The dot

A `●` prefixed before the window number — **color-only, no text, no spinner**:

| window contains | dot |
|---|---|
| no pi pane | (no dot) |
| all pi panes working | 🟢 green |
| mixed (some working, some idle) | 🟡 yellow |
| all pi panes idle | ⚪ grey |

e.g. window `3: getpipher` with one pi working + one pi idle → `● 3: getpipher` (yellow).

## Status

v0.2.6 — fix: omp host support. omp (the Bun fork of pi-mono) never fires
`agent_settled`, so after the first turn the dot stayed green forever, and its
`session_shutdown` carries no `reason`, so `/reload`-class shutdowns took the
quit path. Now also handles omp's settle signal — `agent_end` with
`willContinue !== true` (pi fires the same event just before
`agent_settled`; the publish dedup absorbs the double-fire). omp's
reason-less shutdown remains quit-path by design: it self-heals on the next
`session_start`. [#10](https://github.com/getpipher/agent-status/issues/10)

v0.2.5 — fix: dot vanished after a pi `/new`/`/resume` (quit+start cycle) in a
window with a sibling pane. The `session_shutdown(quit)` handler cleared the
pane's `@agent_state` option but didn't reset the in-memory dedup guard, so the
next `session_start` `publish(IDLE)` was deduped and never re-wrote it. The
pane silently dropped out of the rollup; when the sibling later closed, the dot
went with it. Reset `lastWritten` on quit so the next publish always re-writes.

v0.2.0 — window-tab dot + per-window rollup (green/yellow/grey/none). Replaces
the v0.1.x status-left spinner (which cost status-script re-runs). Non-breaking:
the extension writes only pane-local `@agent_state` + window-scoped
`@agent_window_state`; the snippet defines one new user option `@agent_window_dot`
and never sets `status-left`/`window-status-*` — you merge the dot into your own
window-status format. See the [design spec](docs/superpowers/specs/2026-07-27-agent-status-tmux-design.md)
and [v0.2 plan](docs/superpowers/plans/2026-07-28-window-dot-rollup.md).

## Install

pi — add to `~/.pi/agent/settings.json` `packages`:

```json
"npm:@getpipher/agent-status"
```

omp — install into the omp plugin root:

```sh
omp plugin install @getpipher/agent-status
```

Source the tmux snippet in `~/.tmux.conf` and insert the dot at the start of
your **existing** `window-status-current-format` / `window-status-format`
(merge, don't replace — preserves your tab layout):

```tmux
source-file ~/local-dev/getpipher/agent-status/tmux/agent-status.tmux
# Prepend #{E:#{@agent_window_dot}} to YOUR existing window-status formats.
# The #I:#W below is just a template — keep your own tab layout:
set -g window-status-current-format "#{E:#{@agent_window_dot}} #I:#W"
set -g window-status-format         "#{E:#{@agent_window_dot}} #I:#W"
```

Reload tmux (`prefix + r` or `tmux source ~/.tmux.conf`). When a pi agent runs
in a tmux pane, its window's tab shows a green dot (working); when multiple pi
panes are in the same window with mixed states, yellow; when all idle, grey;
when no pi is in the window, no dot.

## License

MIT