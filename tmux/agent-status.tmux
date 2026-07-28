# @getpipher/agent-status v0.2 — window-tab colored dot (no animation).
#
# Defines @agent_window_dot (a format string). Insert #{E:#{@agent_window_dot}}
# at the START of your existing window-status-current-format and
# window-status-format. This snippet does NOT set those formats — you merge
# the dot into your own tab layout so nothing you have is replaced.
#
# Style blocks are single-attr #[...] (no commas) — commas inside #[...] would
# be parsed as #{?cond,then,else} branch delimiters and corrupt the conditional.
#
# The extension writes:
#   @agent_state        pane-local  (working | idle)              — per pi pane
#   @agent_window_state window-scoped (working | mixed | idle)     — rollup
#
# Dot colors (catppuccin macchiato):
#   green  @thm_green      — all pi panes in the window working
#   yellow @thm_yellow     — mixed (some working, some idle)
#   grey   @thm_overlay_0  — all pi panes idle
#   (no dot)              — no pi pane in the window
#
# Usage in ~/.tmux.conf:
#   source-file ~/local-dev/getpipher/agent-status/tmux/agent-status.tmux
#   set -g window-status-current-format "#{E:#{@agent_window_dot}} #I:#W"
#   set -g window-status-format         "#{E:#{@agent_window_dot}} #I:#W"

set -g @agent_window_dot "#{?#{@agent_window_state},#{?#{==:#{@agent_window_state},working}, #[fg=#{@thm_green}]●#[fg=default],#{?#{==:#{@agent_window_state},mixed}, #[fg=#{@thm_yellow}]●#[fg=default], #[fg=#{@thm_overlay_0}]●#[fg=default]}},}"