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