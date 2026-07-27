# getpipher/agent-status

Pi extension that surfaces pi coding-agent lifecycle state as a live spinner in
the tmux status bar (working / idle, per pane). Public package
`@getpipher/agent-status`.

## Scope

v1 = working / idle + animated spinner + current tool name. No blocked state,
no done-linger, no rollups, no auto-config-patching. See
[`docs/superpowers/specs/2026-07-27-agent-status-tmux-design.md`](docs/superpowers/specs/2026-07-27-agent-status-tmux-design.md).

## Conventions

- Follows the `@getpipher/term` package layout (`extensions/` + `lib/` + `pi.extensions` manifest).
- tmux interactions are pane-local (`set-option -p` on `$TMUX_PANE`), never global `set -g` — global option mutations leak across the whole server.
- Status display is cosmetic: no extension failure may block the agent or crash pi.
- Coexists with herdr's pi extension (defers when `HERDR_ENV=1`).

## Testing

`pnpm test:run` — unit (tmux lib mock + reducer) + integration (real detached tmux via `@getpipher/term` + pi RPC). 80%+ coverage on new code.