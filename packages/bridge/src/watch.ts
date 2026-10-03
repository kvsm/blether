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

/**
 * Waits for a bridge to write the inbox state file at or after `since`, for
 * the SessionStart hook: it runs as the session's bridge starts, so the file
 * still holds the last session's mailbox until the bridge has caught up with
 * the relay. Gives up after `timeoutMs` and leaves the file as it stands.
 */
export async function waitForFreshInbox(
  path: string,
  since: Date,
  {
    timeoutMs = 8000,
    intervalMs = 200,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = readInboxState(path);
    if (state && Date.parse(state.updatedAt) >= since.getTime()) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Hook events `blether hook` answers, as Claude Code names them. */
export const HOOK_EVENTS = ["UserPromptSubmit", "SessionStart"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The bridge's mailbox tool, as the plugin's sessions name it. */
const READ_MAILBOX = "mcp__plugin_blether_blether__read_mailbox";

/**
 * The mail a hook has told the agent about, so the next hook can stay quiet
 * until it changes. Empty when nothing is waiting.
 */
export function mailboxMark(state: InboxState | undefined): string {
  return state && state.unread > 0
    ? `${state.session}:${state.arrivals}:${state.unread}`
    : "";
}

export interface HookAnswer {
  event: HookEvent;
  state: InboxState | undefined;
  /** What an earlier hook in this session told the agent about (`mailboxMark`). */
  told?: string | undefined;
  /**
   * The command for the agent to watch the mailbox with, when the host won't
   * run the plugin's monitor (the VS Code extension doesn't). Undefined when
   * the monitor runs, or the session isn't new. A Monitor tool watch expires
   * (after 30 minutes at most), so the agent restarts it.
   */
  watchCommand?: string | undefined;
}

/**
 * What a Claude Code hook prints: context for the agent, or nothing.
 *
 * At session start it tells the agent to read waiting mail before anything
 * else, and, where the host has no monitor, to start one itself. Hook context
 * can't start a turn, so this lands with the developer's first prompt. On
 * later prompts it reminds the agent only when the mail has changed, so the
 * notice doesn't become noise.
 */
export function hookOutput({
  event,
  state,
  told,
  watchCommand,
}: HookAnswer): string | undefined {
  const parts: string[] = [];
  const mark = mailboxMark(state);
  if (state && mark) {
    const count = `${state.unread} unread Blether message${state.unread === 1 ? "" : "s"} (from ${state.from.join(", ")})`;
    if (event === "SessionStart") {
      parts.push(
        `📬 You have ${count}. Before you respond to the developer, call ${READ_MAILBOX} (load it with ToolSearch first if it's deferred): a teammate may have sent something that affects your work.`,
      );
    } else if (mark !== told) {
      parts.push(
        `📬 New Blether mail: ${count}. Call ${READ_MAILBOX} before you carry on.`,
      );
    }
  }
  if (event === "SessionStart" && watchCommand) {
    parts.push(
      `This host doesn't run Blether's mailbox monitor, so you won't hear about new messages between prompts. On your first turn, start one with the Monitor tool (load it with ToolSearch first if it's deferred) running: ${watchCommand} — with timeout_ms at its maximum, and start it again each time it expires. Each line it prints means new mail; read it with ${READ_MAILBOX}.`,
    );
  }
  if (parts.length === 0) return undefined;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: parts.join("\n\n"),
    },
  });
}
