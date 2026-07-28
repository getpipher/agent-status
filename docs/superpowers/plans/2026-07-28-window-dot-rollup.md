# @getpipher/agent-status v0.2.0 — window-tab dot rollup (plan delta)

Replaces the v0.1.x status-left spinner with a **static colored dot in the window tab**, with per-window rollup across all pi panes. No animation → zero per-frame cost.

## Visual
A single `●` dot, color-only, prefixed before the window number in the window tab:
`(dot) 3: getpipher`

## Rollup (per window, across all panes)
| panes in window | `@agent_window_state` | dot |
|---|---|---|
| none has `@agent_state` set (no pi) | unset | none |
| any working + any idle | `mixed` | 🟡 yellow `@thm_yellow` |
| all working | `working` | 🟢 green `@thm_green` |
| all idle | `idle` | ⚪ grey `@thm_overlay_0` |

## tmux mechanics (verified)
- pane-local: `set-option -p -t <pane> @agent_state working|idle` (read by rollup).
- window-scoped: `set-option -t <window> @agent_window_state working|mixed|idle`; unset (`-u`) when no pi.
- `#{@agent_window_state}` resolves the window-scoped option in window-status context (verified via `display-message -t <window> -p`).
- Writing the window option auto-triggers a status redraw; `refresh-client -S` on transition is a harmless backstop (≤2/turn).

## Changes vs v0.1.x
- **remove** `lib/spinner.ts` (no animation).
- **`lib/state.ts`** unchanged (per-pane working/idle reducer).
- **`lib/tmux.ts`**: drop `setSpinner`; keep `setState` (writes only `@agent_state`, drop `@agent_tool`); add `windowOf(pane)`; add `computeRollup(pane)` → `"working"|"mixed"|"idle"|null`; add `setWindowState(window, state)` (write/unset window option) + a transition refresh.
- **`extensions/agent-status.ts`**: on each event → write pane `@agent_state` → `computeRollup` → `setWindowState`. On `session_shutdown` quit → clear pane `@agent_state` + recompute rollup.
- **`tmux/agent-status.tmux`**: `set -g window-status-format` and `set -g window-status-current-format` to prefix the colored dot via `#{?#{@agent_window_state},<dot by state>,}`. (These ARE global format options — the user opts in by sourcing the snippet; non-regression: snippet only sets these two + nothing else.)
- **README**: drop the status-left install; show window-status install (the snippet sets the formats, so user just `source-file`s).
- **tests**: rollup unit (working-wins/mixed/all-idle/no-pi) + non-regression (snippet only touches the two window-status formats) + integration (real tmux rollup).
- version → 0.2.0.

## Non-breakage
- The snippet sets `window-status-format` + `window-status-current-format` globally — this REPLACES the user's existing formats. To be non-breaking, the snippet must MERGE the dot into the user's existing format, not overwrite. **Decision:** the snippet does NOT set the formats globally. Instead it defines `@agent_window_dot` (a user option holding the dot format) and the user pastes it into their own `window-status-current-format`/`-format` with `set -ga`-style append... but window-status formats aren't append-friendly. **Final approach:** the snippet provides the dot segment as `@agent_window_dot` and documents that the user inserts `#{@agent_window_dot}` at the start of their existing `window-status-current-format` (merge, not replace) — same opt-in pattern as v0.1. The extension writes `@agent_window_state`; the snippet's `@agent_window_dot` formats it.