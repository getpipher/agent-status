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