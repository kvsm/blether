import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * What a bridge tells the rest of the device about its agent's mailbox, for
 * hosts without channels: how many messages are waiting and who from, never
 * their content. `blether watch` reads it; only the bridge holds the agent's
 * relay session, so the watch can't ask the relay itself.
 */
export const InboxState = z.object({
  /** Changes each time a bridge starts, so a watcher can tell a restart from new mail. */
  session: z.string(),
  /** Messages that have arrived since this bridge started, counting up. */
  arrivals: z.number().int().min(0),
  unread: z.number().int().min(0),
  /** Who the waiting messages are from, oldest first, each once. */
  from: z.array(z.string()),
  /** The latest arrival's sender, if any has arrived this session. */
  lastFrom: z.string().optional(),
  updatedAt: z.string(),
  /** Set when the bridge disconnected this session from the relay. */
  closed: z.boolean().optional(),
  /** Set with closed when the connection was lost and couldn't be got back. */
  lost: z.boolean().optional(),
});
export type InboxState = z.infer<typeof InboxState>;

/** The state file for one agent: `<home>/inbox/<team id>.<agent>.json`. */
export function inboxPath(home: string, team: string, agent: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(team + agent)) {
    throw new Error("Bad team or agent name.");
  }
  return join(home, "inbox", `${team}.${agent}.json`);
}

/** Written by the bridge whenever its agent's unread mail changes. */
export class InboxFile {
  /** Identifies this connection, so a watch can tell when it has ended. */
  readonly session = randomUUID();
  private arrivals = 0;
  private lastFrom: string | undefined;
  private closed = false;

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Records an arrival (from `from`), then the mailbox as it now stands. */
  arrived(from: string | undefined, unread: number, senders: string[]) {
    this.arrivals++;
    if (from) this.lastFrom = from;
    this.write(unread, senders);
  }

  /**
   * Records that this session has disconnected, so its watch stops: on
   * purpose, or (`lost`) because the relay connection was lost for good.
   */
  close({ lost = false }: { lost?: boolean } = {}) {
    this.write(0, [], true, lost);
    this.closed = true;
  }

  /** Records the mailbox as it now stands, after a read or at start-up. */
  write(unread: number, senders: string[], closed = false, lost = false) {
    // A late write mustn't reopen a closed session.
    if (this.closed) return;
    const state: InboxState = {
      session: this.session,
      arrivals: this.arrivals,
      unread,
      from: senders,
      ...(this.lastFrom ? { lastFrom: this.lastFrom } : {}),
      updatedAt: this.now().toISOString(),
      ...(closed ? { closed } : {}),
      ...(lost ? { lost } : {}),
    };
    mkdirSync(join(this.path, ".."), { recursive: true });
    // Write then rename, so a reader never sees half a file.
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`);
    renameSync(temp, this.path);
  }
}

/** The agent's inbox state, or undefined if no bridge has written it (or it's unreadable). */
export function readInboxState(path: string): InboxState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return InboxState.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

/** The one-line summary hooks and the watcher show, or undefined when nothing is waiting. */
export function unreadSummary(state: InboxState | undefined) {
  if (!state || state.unread === 0) return undefined;
  return `📬 ${state.unread} unread Blether message${state.unread === 1 ? "" : "s"} (from ${state.from.join(", ")}). Call read_mailbox to read them.`;
}
