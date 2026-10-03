import {
  readInboxState,
  unreadSummary,
  type InboxState,
} from "./inbox-file.js";

/** Why a watch stopped: its session disconnected, or another took the agent over. */
export type WatchEnd = "disconnected" | "taken-over";

/**
 * Watches an agent's inbox state file for one connected session (`session`,
 * the bridge's InboxFile.session) and calls `emit` with one line each time
 * new mail arrives (and once at the start if mail is already waiting), for a
 * watch the agent runs with Claude Code's Monitor tool: each line reaches
 * Claude as a notification. Like the channel notice, a line names the
 * sender and the count, never the message.
 *
 * Calls `end` and stops once the session disconnects, or another session
 * takes the agent over (the file then belongs to another connection).
 * Returns a function that stops watching.
 */
export function watchInbox(
  path: string,
  session: string,
  emit: (line: string) => void,
  end: (why: WatchEnd) => void,
  { intervalMs = 1000 }: { intervalMs?: number } = {},
): () => void {
  let arrivals: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const check = () => {
    const state: InboxState | undefined = readInboxState(path);
    if (!state) return;
    if (state.session !== session || state.closed) {
      stop();
      end(state.session === session ? "disconnected" : "taken-over");
      return;
    }
    const summary = unreadSummary(state);
    const arrived = arrivals !== undefined && state.arrivals > arrivals;
    if (summary && (arrivals === undefined || arrived)) {
      emit(
        arrived && state.lastFrom
          ? `New Blether message from ${state.lastFrom}. ${summary}`
          : summary,
      );
    }
    arrivals = state.arrivals;
  };
  check();
  if (!stopped) timer = setInterval(check, intervalMs);
  return stop;
}
