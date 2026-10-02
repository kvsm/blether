import type { TeamDirectory } from "./keystore.js";
import {
  inboxPath,
  readInboxState,
  unreadSummary,
  type InboxState,
} from "./inbox-file.js";
import { findSessionFile } from "./session-file.js";

/**
 * The inbox state file for the agent a project's sessions act as, found the
 * way the bridge finds it: BLETHER_TEAM and BLETHER_AGENT, or else the
 * project's `.blether/session.json`. Undefined if no agent is chosen.
 */
export function projectInboxPath(
  dir: string,
  home: string,
  teams: TeamDirectory,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let session;
  try {
    session = findSessionFile(dir, home);
  } catch {
    return undefined;
  }
  const teamName = env.BLETHER_TEAM ?? session?.contents.team;
  const agent = env.BLETHER_AGENT ?? session?.contents.agent;
  if (!teamName || !agent) return undefined;
  let team;
  try {
    team = teams.get(teamName);
  } catch {
    return undefined;
  }
  if (!team) return undefined;
  try {
    return inboxPath(home, team.id, agent);
  } catch {
    return undefined;
  }
}

/**
 * Watches an agent's inbox state file and calls `emit` with one line each
 * time new mail arrives (and once at the start if mail is already waiting),
 * for a Claude Code plugin monitor: each line reaches Claude as a
 * notification. Like the channel notice, a line names the sender and the
 * count, never the message. Returns a function that stops watching.
 */
export function watchInbox(
  path: string,
  emit: (line: string) => void,
  { intervalMs = 1000 }: { intervalMs?: number } = {},
): () => void {
  let seen: Pick<InboxState, "session" | "arrivals"> | undefined;
  let started = false;
  const check = () => {
    const state = readInboxState(path);
    if (!state) return;
    const summary = unreadSummary(state);
    const restarted = seen?.session !== state.session;
    const arrived = !restarted && state.arrivals > (seen?.arrivals ?? 0);
    if (summary && (!started || arrived || restarted)) {
      emit(
        arrived && state.lastFrom
          ? `New Blether message from ${state.lastFrom}. ${summary}`
          : summary,
      );
    }
    seen = { session: state.session, arrivals: state.arrivals };
    started = true;
  };
  check();
  started = true;
  const timer = setInterval(check, intervalMs);
  return () => clearInterval(timer);
}

/** Hook events `blether hook` answers, as Claude Code names them. */
export const HOOK_EVENTS = ["UserPromptSubmit", "SessionStart"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * What a Claude Code hook prints for `event`: the unread summary as context
 * for Claude, or nothing when no mail is waiting (or no agent is chosen).
 */
export function hookOutput(
  event: HookEvent,
  path: string | undefined,
): string | undefined {
  const summary = path ? unreadSummary(readInboxState(path)) : undefined;
  if (!summary) return undefined;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: summary },
  });
}
