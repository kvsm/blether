import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  readInboxState,
  unreadSummary,
  type InboxState,
} from "./inbox-file.js";

/** Why a watch stopped: its session disconnected or lost the relay, or another took the agent over. */
export type WatchEnd = "disconnected" | "lost" | "taken-over";

/**
 * Watches an agent's inbox state file for one connected session (`session`,
 * the bridge's InboxFile.session) and calls `emit` with one line each time
 * new mail arrives (and once at the start if mail is already waiting), for a
 * watch the agent runs with Claude Code's Monitor tool: each line reaches
 * Claude as a notification. Like the channel notice, a line names the
 * sender and the count, never the message.
 *
 * Each watch records the arrivals it has seen beside the state file. With
 * `quietStart`, for a restart after the Monitor tool's watch expires, it
 * starts from that record instead: mail an earlier watch reported isn't
 * repeated, and mail that arrived between the two still is.
 *
 * Calls `end` and stops once the session disconnects or loses its
 * connection to the relay for good, or another session
 * takes the agent over (the file then belongs to another connection).
 * Returns a function that stops watching.
 */
export function watchInbox(
  path: string,
  session: string,
  emit: (line: string) => void,
  end: (why: WatchEnd) => void,
  {
    intervalMs = 1000,
    quietStart = false,
  }: { intervalMs?: number; quietStart?: boolean } = {},
): () => void {
  const seenPath = `${path}.watched`;
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
      end(
        state.session !== session
          ? "taken-over"
          : state.lost
            ? "lost"
            : "disconnected",
      );
      return;
    }
    const seen =
      arrivals ?? (quietStart ? readSeen(seenPath, session) : undefined);
    const summary = unreadSummary(state);
    const arrived = seen !== undefined && state.arrivals > seen;
    if (summary && (seen === undefined || arrived)) {
      emit(
        arrived && state.lastFrom
          ? `New Blether message from ${state.lastFrom}. ${summary}`
          : summary,
      );
    }
    if (state.arrivals !== arrivals) {
      arrivals = state.arrivals;
      writeSeen(seenPath, session, arrivals);
    }
  };
  check();
  if (!stopped) timer = setInterval(check, intervalMs);
  return stop;
}

/** The arrivals an earlier watch of this session saw, if it recorded them. */
function readSeen(path: string, session: string): number | undefined {
  try {
    const seen = JSON.parse(readFileSync(path, "utf8"));
    return seen.session === session && Number.isInteger(seen.arrivals)
      ? seen.arrivals
      : undefined;
  } catch {
    return undefined;
  }
}

function writeSeen(path: string, session: string, arrivals: number) {
  try {
    // Write then rename, so a restart never reads half a file.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ session, arrivals })}\n`);
    renameSync(temp, path);
  } catch {
    // Without the record, a quiet restart just repeats what's waiting.
  }
}
