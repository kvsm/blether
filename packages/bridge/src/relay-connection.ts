import { randomUUID } from "node:crypto";
import {
  IdentityError,
  RelayFrame,
  TeamError,
  heldMessageId,
  holdNoticeBody,
  compareLogs,
  openMessage,
  parseFrame,
  sealMessage,
  signChallenge,
  verifyIdentityLog,
  verifyTeamLog,
  type AgentName,
  type Attachment,
  type Audience,
  type AudienceHint,
  type ClientFrame,
  type DeliveryStatus,
  type ErrorCode,
  type Identity,
  type IdentityLog,
  type Message,
  type SentMessage,
  type SignedTeamEntry,
  type Team,
  type TeamLog,
} from "@blether/protocol";
import { WebSocket } from "ws";
import {
  StaleLogError,
  type Credentials,
  type LogWitness,
  type ReadMessageLog,
} from "./keystore.js";

/** How long a verified team log is used before it's fetched again. */
const TEAM_CACHE_MS = 30_000;
/** Longest a mailbox read waits for the relay to finish sending the backlog. */
const CAUGHT_UP_TIMEOUT_MS = 5_000;

/** The relay refused something, or its answer didn't verify. */
export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode | "disconnected" | "untrusted-reply",
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

/** The relay's answer to a send: the message id and how far it got. */
export interface SendReceipt {
  id: string;
  status: Exclude<DeliveryStatus, "read">;
}

/** A team log the bridge has verified itself, with the identities of everyone in it. */
export interface VerifiedTeam {
  team: Team;
  log: TeamLog;
  identities: Map<string, Identity>;
}

export interface ConnectOptions {
  /** The team and agent to act as. Omit for a CLI session. */
  scope?: AgentScope;
  /** Checks logs from the relay against what this device has seen before. */
  witness?: LogWitness;
  /** Remembers which messages this agent has read, so a relay replaying one is caught. */
  readMessages?: ReadMessageLog;
  /** If another session is acting as the agent, disconnect it and take its place. */
  takeover?: boolean;
  /** Where to tell the developer things about the connection, such as the relay asking for audience hints. */
  log?: (line: string) => void;
  /**
   * For an agent's session, how long to wait before each attempt to
   * reconnect after losing the relay; once they've all failed, the
   * connection closes. Defaults to RECONNECT_DELAYS_MS; [] never reconnects.
   */
  reconnectDelaysMs?: readonly number[];
  /** How often to check the relay is still answering. Defaults to 15 seconds. */
  heartbeatMs?: number;
}

/** Waits before each attempt to reconnect: about five minutes in all. */
export const RECONNECT_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000,
  60_000, 60_000,
];
const HEARTBEAT_MS = 15_000;

/** How a connection ended, other than by being closed on purpose. */
export type ConnectionEnd = "lost" | "taken-over" | "refused";

/** Who a message is for: one agent, every agent holding a role, or every other agent in the team. */
export type SendTarget =
  | { kind: "agent"; name: AgentName }
  | { kind: "role"; role: string }
  | { kind: "everyone" };

/** A message this device decrypted and verified. */
export interface ReceivedMessage {
  kind: "message";
  id: string;
  from: AgentName;
  to: AgentName;
  /** Set when it went to a role or the whole team, rather than just to this agent. */
  audience?: Audience | undefined;
  /** Set for a hold notice from the sender's bridge, rather than a message its agent wrote. */
  notice?: "hold" | undefined;
  /** The message this replies to, if it's a reply. */
  inReplyTo?: string | undefined;
  /** The thread it belongs to: the id of the message that started it (its own id if it starts one). */
  thread: string;
  attachments?: Attachment[] | undefined;
  body: string;
  /** When the sender sent it, by the sender's signed clock. */
  sentAt: string;
  /** When the relay accepted it. */
  receivedAt: string;
}

/** A message this device couldn't show, and why. */
export interface UnreadableMessage {
  kind: "unreadable";
  id: string;
  /** Who the relay says sent it. Unverified. */
  from: AgentName;
  receivedAt: string;
  /**
   * `elsewhere`: it was encrypted for the developer's other devices only
   * (sent before this device was added), and stays unread for them.
   * `rejected`: it didn't decrypt or verify, and has been discarded.
   */
  reason: "elsewhere" | "rejected";
  detail: string;
}

/**
 * A message this agent sent that will never be read: the team log shows its
 * recipient was deleted (or its developer removed) first.
 */
export interface LostMessage {
  kind: "lost";
  id: string;
  /** The deleted agent it was sent to. */
  to: AgentName;
  sentAt: string;
}

export type MailboxItem = ReceivedMessage | UnreadableMessage | LostMessage;

interface Welcome {
  developer: string;
  identity: IdentityLog;
  audienceHints?: boolean | undefined;
}

/** One agent in a team's roster. */
export interface RosterEntry {
  name: AgentName;
  /** The name of the developer who owns it. */
  developer: string;
  roles: string[];
  /** Whether a session is currently acting as it. */
  online: boolean;
  /** Set when an earlier agent with this name was deleted: this is a different agent. */
  replacesDeleted: boolean;
}

/** The team and agent a bridge session acts as. */
export interface AgentScope {
  team: string;
  agent: AgentName;
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: RelayError) => void;
}

interface TeamReply {
  log: TeamLog;
  identities: unknown[];
}

/**
 * A connection to the relay, authenticated as a developer. A bridge's
 * connection also acts as one agent in a team, and holds the messages the
 * relay delivers until the agent reads them. The CLI's connection acts as no
 * agent, and only reads and extends team logs.
 */
export class RelayConnection {
  private readonly unread: MailboxItem[] = [];
  /** Ids of every message received, so redeliveries after reconnecting are ignored. */
  private readonly seen = new Set<string>();
  /** Messages read in this session, so they can be referred to later (e.g. to escalate). */
  private readonly readThisSession = new Map<string, ReceivedMessage>();
  /** Lost-message notices already put in the mailbox this session. */
  private readonly seenLost = new Set<string>();
  /** Why the connection isn't open, while it isn't. */
  private closedBecause: string | undefined;
  /**
   * `connecting` until first welcomed; `reconnecting` after losing the
   * relay, while it tries to get back; `closed` for good.
   */
  private state: "connecting" | "open" | "reconnecting" | "closed" =
    "connecting";
  /** Set once close() is called, so losing the connection is expected. */
  private closing = false;
  /** Ids of messages read in this session, so their read receipts can be sent again. */
  private readonly readIds = new Set<string>();
  /** Ids of lost-message notices read in this session, likewise. */
  private readonly lostAcked = new Set<string>();
  /**
   * Deliveries that couldn't be checked yet, because looking the sender up
   * failed (the relay didn't answer, say), by id. They stay unread on the
   * relay, and are checked again when redelivered or the mailbox is read.
   */
  private readonly unchecked = new Map<string, Message>();
  /**
   * The socket the relay last welcomed. Requests may go on it from then on:
   * waiting mail arrives straight after the welcome, often before the
   * handshake has finished, and checking it needs the team log.
   */
  private welcomedOn: WebSocket | undefined;
  /** Deliveries are decrypted and verified one at a time, in order. */
  private inbox: Promise<void> = Promise.resolve();
  /** Resolves when the relay says it has sent the backlog (immediately for a CLI session). */
  private caughtUp: Promise<void> = Promise.resolve();
  private markCaughtUp: () => void = () => {};
  /** The team log as last verified, refreshed when it's missing something or stale. */
  private teamCache: { team: VerifiedTeam; at: number } | undefined;
  private readonly sends = new Map<string, Pending<SendReceipt>>();
  private readonly listings = new Map<string, Pending<SentMessage[]>>();
  private readonly teamRequests = new Map<string, Pending<TeamReply>>();
  private readonly presenceRequests = new Map<string, Pending<string[]>>();
  private challenge: Pending<string> | undefined;
  private welcome: Pending<Welcome> | undefined;
  /** Whether the relay asked to be told each send's audience (debug statistics). */
  private audienceHints = false;
  /** The authenticated developer's identity id, once the relay has welcomed this session. */
  developer: string | undefined;
  /**
   * The newest verified version of the developer's identity log, once
   * welcomed. It's longer than the one this device holds if another of the
   * developer's devices has added a device since; callers should save it.
   */
  identity: IdentityLog | undefined;
  private readonly arrivalListeners = new Set<(item: MailboxItem) => void>();
  private readonly readListeners = new Set<() => void>();
  private readonly endListeners = new Set<
    (end: ConnectionEnd, why: string) => void
  >();

  private constructor(
    private socket: WebSocket,
    private readonly url: string,
    private readonly credentials: Credentials,
    readonly scope: AgentScope | undefined,
    private readonly witness: LogWitness | undefined,
    private readonly readMessages: ReadMessageLog | undefined,
    private readonly reconnectDelaysMs: readonly number[],
    private readonly heartbeatMs: number,
    private readonly log: ((line: string) => void) | undefined,
  ) {
    this.attach(socket);
  }

  /** Handles `socket`'s frames, and notices when it closes or goes quiet. */
  private attach(socket: WebSocket) {
    socket.on("message", (data) => this.receive(data.toString()));
    // A close follows any error.
    socket.on("error", () => {});
    // A connection can die without closing (a sleeping laptop, a dropped
    // network). The relay answers pings, so one unanswered for a whole
    // interval means it's gone.
    let answered = true;
    socket.on("pong", () => {
      answered = true;
    });
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!answered) {
        socket.terminate();
        return;
      }
      answered = false;
      socket.ping();
    }, this.heartbeatMs);
    heartbeat.unref();
    socket.on("close", (code, reason) => {
      clearInterval(heartbeat);
      // A failed attempt to reconnect closing after the next has begun.
      if (socket !== this.socket) return;
      this.dropped(code, reason.toString());
    });
  }

  /** The socket closed: fail what was waiting on it, then reconnect or end. */
  private dropped(code: number, reason: string) {
    const takenOver = code === 4002;
    const refused = code === 4000 || code === 4001;
    if (this.state !== "reconnecting") {
      this.closedBecause = takenOver
        ? "Another session took over this agent, so this one has been disconnected."
        : refused
          ? `The relay disconnected this session: ${reason}`
          : "Lost connection to relay.";
    }
    const error = new RelayError("disconnected", this.closedBecause!);
    this.challenge?.reject(error);
    this.welcome?.reject(error);
    for (const pending of [
      ...this.sends.values(),
      ...this.listings.values(),
      ...this.teamRequests.values(),
      ...this.presenceRequests.values(),
    ])
      pending.reject(error);
    this.sends.clear();
    this.listings.clear();
    this.teamRequests.clear();
    this.presenceRequests.clear();

    // A failed attempt to reconnect: reconnect() decides what's next.
    if (this.state === "reconnecting") return;
    const wasOpen = this.state === "open";
    if (
      wasOpen &&
      !this.closing &&
      !takenOver &&
      !refused &&
      this.reconnectDelaysMs.length > 0
    ) {
      this.state = "reconnecting";
      this.closedBecause =
        "Lost connection to the relay; reconnecting. Try again shortly.";
      this.log?.("Lost connection to the relay; reconnecting.");
      void this.reconnect();
      return;
    }
    this.state = "closed";
    if (wasOpen && !this.closing) {
      this.ended(takenOver ? "taken-over" : refused ? "refused" : "lost");
    }
  }

  /** Tries to get back to the relay, waiting before each attempt, and ends the connection if it can't. */
  private async reconnect() {
    for (const delay of this.reconnectDelaysMs) {
      await new Promise((resolve) => setTimeout(resolve, delay).unref());
      if (this.closing) break;
      const socket = new WebSocket(this.url);
      this.socket = socket;
      this.attach(socket);
      try {
        // Not taking over: if another session has the agent now, it's theirs.
        // (If it's this session's old connection, the relay soon drops it.)
        await this.handshake(false);
        this.closedBecause = undefined;
        this.log?.("Reconnected to the relay.");
        return;
      } catch (error) {
        socket.terminate();
        if (this.closing) break;
        if (
          error instanceof RelayError &&
          error.code !== "disconnected" &&
          error.code !== "agent-in-use"
        ) {
          this.state = "closed";
          this.closedBecause = `The relay refused to reconnect this session: ${error.message}`;
          this.ended("refused");
          return;
        }
      }
    }
    this.state = "closed";
    if (this.closing) return;
    this.closedBecause =
      "Lost connection to the relay, and couldn't reconnect.";
    this.ended("lost");
  }

  private ended(end: ConnectionEnd) {
    this.log?.(this.closedBecause!);
    for (const listener of this.endListeners) {
      listener(end, this.closedBecause!);
    }
  }

  /**
   * Calls `listener` once if the connection ends without close() being
   * called: lost (and not got back), taken over, or refused by the relay.
   */
  onEnd(listener: (end: ConnectionEnd, why: string) => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  /** Why the connection isn't open, or undefined while it is. */
  get problem(): string | undefined {
    return this.state === "open" ? undefined : this.closedBecause;
  }

  /** The agent this session acts as. Throws for a CLI session. */
  get agent(): AgentName {
    if (!this.scope) throw new Error("This session isn't acting as an agent.");
    return this.scope.agent;
  }

  /**
   * Connects to the relay and authenticates as the developer in
   * `credentials`. With a `scope`, the session acts as that agent in that
   * team, and anything already waiting in the agent's mailbox is delivered
   * straight away.
   */
  static async connect(
    url: string,
    credentials: Credentials,
    {
      scope,
      witness,
      readMessages,
      takeover,
      log,
      reconnectDelaysMs = RECONNECT_DELAYS_MS,
      heartbeatMs = HEARTBEAT_MS,
    }: ConnectOptions = {},
  ): Promise<RelayConnection> {
    const socket = new WebSocket(url);
    const connection = new RelayConnection(
      socket,
      url,
      credentials,
      scope,
      witness,
      readMessages,
      // Only an agent's session lives long enough to need reconnecting.
      scope ? reconnectDelaysMs : [],
      heartbeatMs,
      log,
    );
    try {
      await connection.handshake(takeover === true);
    } catch (error) {
      socket.close();
      throw error;
    }
    if (connection.audienceHints) {
      log?.(
        `The relay at ${url} is in debug mode and asked for audience hints: it will be told whether each message goes to one agent, a role, or everyone, for its statistics.`,
      );
    }
    return connection;
  }

  /**
   * Authenticates on the current socket, which must have been attached in
   * this same tick: the relay sends its challenge as soon as the connection
   * opens, and anything waiting in the mailbox straight after welcome.
   */
  private async handshake(takeover: boolean): Promise<void> {
    const socket = this.socket;
    const { scope } = this;
    const challenged = new Promise<string>((resolve, reject) => {
      this.challenge = { resolve, reject };
    });
    const welcomed = new Promise<Welcome>((resolve, reject) => {
      this.welcome = { resolve, reject };
    });
    if (scope) {
      this.caughtUp = new Promise((resolve) => {
        this.markCaughtUp = resolve;
        // Don't hold mailbox reads for ever if the relay never says so.
        setTimeout(resolve, CAUGHT_UP_TIMEOUT_MS).unref();
      });
    }
    // Avoid unhandled rejections if the socket fails before we await these.
    challenged.catch(() => {});
    welcomed.catch(() => {});
    // A relay (or a proxy before it) can accept the connection and then say
    // nothing; the heartbeat only watches open sockets, so give up here.
    const deadline = setTimeout(() => socket.terminate(), this.heartbeatMs * 2);
    deadline.unref();
    try {
      await this.greet(socket, challenged, welcomed, takeover);
    } finally {
      clearTimeout(deadline);
    }
    this.state = "open";
  }

  /** Opens `socket`, answers the relay's challenge, and takes in its welcome. */
  private async greet(
    socket: WebSocket,
    challenged: Promise<string>,
    welcomed: Promise<Welcome>,
    takeover: boolean,
  ): Promise<void> {
    const { credentials, scope } = this;
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const challenge = await challenged;
    this.write({
      type: "hello",
      ...(scope ?? {}),
      ...(takeover ? { takeover: true } : {}),
      identity: credentials.identity,
      device: credentials.device.publicKey,
      signature: signChallenge(credentials.device, challenge, scope ?? {}),
    });
    const welcome = await welcomed;
    this.identity = this.checkOwnIdentity(
      credentials.identity,
      welcome.identity,
    );
    this.developer = welcome.developer;
    this.audienceHints = welcome.audienceHints === true;
  }

  /**
   * Encrypts a message for every device of the developer who owns agent
   * `to`, as recorded in the verified team log, and sends it. Resolves once
   * the relay has accepted it.
   */
  async send(
    to: AgentName,
    body: string,
    {
      audience,
      fanout,
      kind,
      inReplyTo,
      thread,
      attachments,
    }: {
      audience?: Audience | undefined;
      /** Shared by every copy of one send to several agents, for a relay that asks for audience hints. */
      fanout?: string | undefined;
      kind?: "hold-notice";
      inReplyTo?: string | undefined;
      thread?: string | undefined;
      attachments?: Attachment[] | undefined;
    } = {},
  ): Promise<SendReceipt> {
    const scope = this.requireScope();
    const recipient = await this.findAgent(to);
    if (!recipient) {
      throw new RelayError(
        "unknown-agent",
        `There is no agent called ${to} in this team.`,
      );
    }
    const devices = recipient.identity?.devices ?? [];
    if (devices.length === 0) {
      throw new RelayError(
        "untrusted-reply",
        `Couldn't find the devices of ${to}'s developer to encrypt for.`,
      );
    }
    const id = randomUUID();
    const envelope = sealMessage(
      {
        id,
        team: scope.team,
        from: scope.agent,
        to,
        ...(audience ? { audience } : {}),
        ...(kind ? { kind } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(thread ? { thread } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        body,
        sentAt: new Date().toISOString(),
      },
      this.credentials.device,
      devices,
    );
    const hint: AudienceHint | undefined = this.audienceHints
      ? { audience: audience ?? { kind: "agent" }, fanout: fanout ?? id }
      : undefined;
    return this.request(this.sends, id, {
      type: "send",
      id,
      to,
      envelope,
      ...(hint ? { hint } : {}),
    });
  }

  /**
   * The agents a message to `target` would go to, from the verified team
   * log, never including this session's own agent. Throws RelayError with
   * an explanation if there are none.
   */
  async recipientsFor(target: SendTarget): Promise<AgentName[]> {
    const scope = this.requireScope();
    if (target.kind === "agent") return [target.name];
    const { team } = await this.currentTeam(true);
    const others = team.agents.filter((a) => a.name !== scope.agent);
    if (target.kind === "everyone") {
      if (others.length === 0) {
        throw new RelayError(
          "unknown-agent",
          "There are no other agents in this team.",
        );
      }
      return others.map((a) => a.name);
    }
    if (!team.roles.includes(target.role)) {
      throw new RelayError(
        "unknown-agent",
        `This team has no ${target.role} role. Its roles are: ${team.roles.join(", ") || "none yet"}.`,
      );
    }
    const holders = others.filter((a) => a.roles.includes(target.role));
    if (holders.length === 0) {
      throw new RelayError(
        "unknown-agent",
        `No other agent holds the ${target.role} role.`,
      );
    }
    return holders.map((a) => a.name);
  }

  /** The `limit` messages this agent sent most recently, newest first. */
  listSent(limit = 20): Promise<SentMessage[]> {
    const requestId = randomUUID();
    return this.request(this.listings, requestId, {
      type: "list-sent",
      requestId,
      limit,
    });
  }

  /** Number of messages waiting to be read. */
  get unreadCount(): number {
    return this.unread.length;
  }

  /** Who the waiting messages are from, without reading them: agent names, oldest first, each once. */
  unreadFrom(): string[] {
    const from = this.unread.map((item) =>
      item.kind === "lost" ? "lost-message notices" : item.from,
    );
    return [...new Set(from)];
  }

  /** Calls `listener` after each mailbox read. Returns a function that unsubscribes. */
  onRead(listener: () => void): () => void {
    this.readListeners.add(listener);
    return () => this.readListeners.delete(listener);
  }

  /** Calls `listener` whenever a new message arrives. Returns a function that unsubscribes. */
  onArrival(listener: (item: MailboxItem) => void): () => void {
    this.arrivalListeners.add(listener);
    return () => this.arrivalListeners.delete(listener);
  }

  /**
   * Returns everything waiting in the mailbox, oldest first, and marks it
   * read, except messages encrypted only for the developer's other devices,
   * which stay unread for them.
   */
  readMailbox(): MailboxItem[] {
    const items = this.unread.splice(0);
    const read = items
      .filter(
        (item) =>
          item.kind === "message" ||
          (item.kind === "unreadable" && item.reason === "rejected"),
      )
      .map((item) => item.id);
    const lost = items.filter((i) => i.kind === "lost").map((i) => i.id);
    for (const id of lost) this.lostAcked.add(id);
    if (lost.length > 0 && this.isOpen()) {
      this.write({ type: "ack-lost", ids: lost });
    }
    this.readMessages?.add(read);
    for (const id of read) this.readIds.add(id);
    for (const item of items) {
      if (item.kind === "message") this.readThisSession.set(item.id, item);
    }
    if (read.length > 0 && this.isOpen()) {
      this.write({ type: "read", ids: read });
    }
    for (const listener of this.readListeners) listener();
    return items;
  }

  /** A message read earlier in this session, by id. */
  readMessage(id: string): ReceivedMessage | undefined {
    return this.readThisSession.get(id);
  }

  /** The identity id of the developer who owns agent `name` in the verified team log. */
  async ownerOf(name: string): Promise<string | undefined> {
    return (await this.findAgent(name))?.agent.owner;
  }

  /**
   * Resolves once the relay has sent everything that was waiting when the
   * session connected, and every delivery received so far has been
   * decrypted and verified.
   */
  async settled(): Promise<void> {
    await this.caughtUp;
    this.recheck();
    await this.inbox;
  }

  /** Checks again the deliveries that couldn't be checked before. */
  private recheck() {
    if (this.unchecked.size === 0) return;
    const waiting = [...this.unchecked.values()];
    this.inbox = this.inbox.then(async () => {
      for (const message of waiting) {
        if (this.unchecked.has(message.id)) await this.accept(message);
      }
    });
  }

  /** Number of messages that arrived but couldn't be checked yet. */
  get uncheckedCount(): number {
    return this.unchecked.size;
  }

  /** Starts a team whose log is `log`, returning it as the relay stored it. */
  async createTeam(log: TeamLog): Promise<VerifiedTeam> {
    const requestId = randomUUID();
    const reply = await this.request(this.teamRequests, requestId, {
      type: "create-team",
      requestId,
      log,
    });
    return this.verifyReply(reply);
  }

  /** The names of team `id`'s agents that have a session connected. */
  getPresence(id: string): Promise<string[]> {
    const requestId = randomUUID();
    return this.request(this.presenceRequests, requestId, {
      type: "get-presence",
      requestId,
      team: id,
    });
  }

  /** The roster of this session's team: every agent, its developer and roles, and whether it's online. */
  async roster(): Promise<RosterEntry[]> {
    const scope = this.requireScope();
    const [{ team, identities }, online] = await Promise.all([
      this.currentTeam(true),
      this.getPresence(scope.team),
    ]);
    return team.agents.map((agent) => ({
      name: agent.name,
      developer: identities.get(agent.owner)?.name ?? "(unknown)",
      roles: agent.roles,
      online: online.includes(agent.name),
      replacesDeleted: agent.replacesDeleted === true,
    }));
  }

  /** Fetches team `id`'s log and verifies it. */
  async getTeam(id: string): Promise<VerifiedTeam> {
    const requestId = randomUUID();
    const reply = await this.request(this.teamRequests, requestId, {
      type: "get-team",
      requestId,
      team: id,
    });
    return this.verifyReply(reply, id);
  }

  /** Appends `entry` to team `id`'s log, returning the verified result. */
  async appendTeam(id: string, entry: SignedTeamEntry): Promise<VerifiedTeam> {
    const requestId = randomUUID();
    const reply = await this.request(this.teamRequests, requestId, {
      type: "append-team",
      requestId,
      team: id,
      entry,
    });
    return this.verifyReply(reply, id);
  }

  private requireScope(): AgentScope {
    if (!this.scope) throw new Error("This session isn't acting as an agent.");
    return this.scope;
  }

  /**
   * The verified team log: fetched again if `refresh`, or if the cached copy
   * is more than TEAM_CACHE_MS old, so a revoked device or a removed member
   * stops being encrypted for within seconds.
   */
  private async currentTeam(refresh = false): Promise<VerifiedTeam> {
    const stale =
      !this.teamCache || Date.now() - this.teamCache.at > TEAM_CACHE_MS;
    if (refresh || stale) {
      this.teamCache = {
        team: await this.getTeam(this.requireScope().team),
        at: Date.now(),
      };
    }
    return this.teamCache!.team;
  }

  /**
   * Finds agent `name` in the team log, with its owner's identity. If the
   * cached log doesn't have it (or its owner doesn't have `mustHaveDevice`),
   * fetches the log again, since the agent may have been created, or a device
   * added, since.
   */
  private async findAgent(name: string, mustHaveDevice?: string) {
    for (const refresh of [false, true]) {
      const { team, identities } = await this.currentTeam(refresh);
      const agent = team.agents.find((a) => a.name === name);
      const identity = agent && identities.get(agent.owner);
      if (
        agent &&
        (!mustHaveDevice || identity?.devices.includes(mustHaveDevice))
      ) {
        return { agent, identity };
      }
    }
    return undefined;
  }

  /**
   * Puts lost-message notices in the mailbox, but only those the verified
   * team log bears out: the recipient must no longer be in the team. A relay
   * can't make an agent think a message to a live agent was lost.
   */
  private async acceptLost(messages: SentMessage[]): Promise<void> {
    // Read already: the acknowledgement may have been lost with an old connection.
    const acked = messages
      .filter((m) => this.lostAcked.has(m.id))
      .map((m) => m.id);
    if (acked.length > 0 && this.isOpen()) {
      this.write({ type: "ack-lost", ids: acked });
    }
    const fresh = messages.filter((m) => !this.seenLost.has(m.id));
    if (fresh.length === 0) return;
    let team: Team;
    try {
      ({ team } = await this.currentTeam(true));
    } catch {
      return;
    }
    for (const message of fresh) {
      const stillThere = team.agents.some((a) => a.name === message.to);
      const deleted = team.deletedAgents.some((d) => d.name === message.to);
      if (stillThere && !deleted) continue;
      this.seenLost.add(message.id);
      const item: LostMessage = {
        kind: "lost",
        id: message.id,
        to: message.to,
        sentAt: message.sentAt,
      };
      this.unread.push(item);
      for (const listener of this.arrivalListeners) listener(item);
    }
  }

  /** Decrypts and verifies one delivery, then puts it in the mailbox. */
  private async accept(message: Message): Promise<void> {
    // A message already read coming back means the relay is replaying it.
    if (this.readMessages?.has(message.id)) return;
    let item: MailboxItem;
    try {
      item = await this.verifyDelivery(message);
    } catch {
      // Not knowing who signed it isn't the same as a bad signature: keep it
      // to check again, rather than discarding it as forged.
      this.unchecked.set(message.id, message);
      return;
    }
    this.unchecked.delete(message.id);
    this.unread.push(item);
    for (const listener of this.arrivalListeners) listener(item);
  }

  /**
   * Opens this device's copy of a delivery and checks it: the signature, that
   * its signed addressing matches how the relay delivered it, and that it was
   * signed by a device of the developer who owns the sending agent.
   */
  private async verifyDelivery(message: Message): Promise<MailboxItem> {
    const scope = this.requireScope();
    const unreadable = (
      reason: UnreadableMessage["reason"],
      detail: string,
    ): UnreadableMessage => ({
      kind: "unreadable",
      id: message.id,
      from: message.from,
      receivedAt: message.receivedAt,
      reason,
      detail,
    });

    const opened = openMessage(message.envelope, this.credentials.device);
    if (!opened.ok) {
      return opened.reason === "elsewhere"
        ? unreadable(
            "elsewhere",
            "It was encrypted for another of your devices, probably because it was sent before this device was added. Read it there.",
          )
        : unreadable(
            "rejected",
            "It couldn't be decrypted or its signature is invalid, so it was discarded.",
          );
    }
    const { payload, signer } = opened;
    if (
      payload.id !== message.id ||
      payload.team !== scope.team ||
      payload.to !== scope.agent ||
      payload.from !== message.from
    ) {
      return unreadable(
        "rejected",
        "Its signed addressing doesn't match how it was delivered, so it was discarded.",
      );
    }
    // Throws if the team log can't be fetched or doesn't verify: then the
    // delivery can't be checked yet, which accept() handles.
    const sender = await this.findAgent(payload.from, signer);
    if (!sender) {
      return unreadable(
        "rejected",
        `It wasn't signed by a device of the developer who owns ${payload.from}, so it was discarded.`,
      );
    }
    // A hold notice's text is written here, never taken from the sender.
    const held = heldMessageId(payload);
    return {
      kind: "message",
      id: payload.id,
      from: payload.from,
      to: payload.to,
      audience: payload.audience,
      notice: held !== undefined ? "hold" : undefined,
      inReplyTo: payload.inReplyTo,
      thread: payload.thread ?? payload.id,
      body: held !== undefined ? holdNoticeBody(held) : payload.body,
      attachments: payload.attachments,
      sentAt: payload.sentAt,
      receivedAt: message.receivedAt,
    };
  }

  /**
   * Checks the identity log the relay returned on welcome: it must be this
   * developer's, and the same as or newer than the one this device holds.
   */
  private checkOwnIdentity(
    local: IdentityLog,
    fromRelay: IdentityLog,
  ): IdentityLog {
    return untrusted(() => {
      const mine = verifyIdentityLog(local);
      const theirs = verifyIdentityLog(fromRelay);
      const relation = compareLogs(fromRelay, local);
      if (
        theirs.id !== mine.id ||
        relation === "behind" ||
        relation === "diverged"
      ) {
        throw new IdentityError(
          "The relay's copy of your identity doesn't match this device's.",
        );
      }
      this.witness?.witness("identity", mine.id, fromRelay);
      return fromRelay;
    });
  }

  /**
   * Verifies a team log the relay sent, rather than trusting the relay: every
   * identity and entry is checked, the team must be the one asked for, and no
   * log may be older than one this device has already seen.
   */
  private verifyReply(reply: TeamReply, expectedId?: string): VerifiedTeam {
    return untrusted(() => {
      const identities = new Map<string, Identity>();
      for (const log of reply.identities) {
        const identity = verifyIdentityLog(log);
        this.witness?.witness("identity", identity.id, log as unknown[]);
        identities.set(identity.id, identity);
      }
      const team = verifyTeamLog(reply.log, identities);
      if (expectedId && team.id !== expectedId) {
        throw new TeamError("The relay sent a different team's log.");
      }
      this.witness?.witness("team", team.id, reply.log);
      return { team, log: reply.log, identities };
    });
  }

  /** Disconnects from the relay, resolving once the connection has closed. */
  close(): Promise<void> {
    this.closing = true;
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    const closed = new Promise<void>((resolve) =>
      this.socket.once("close", () => resolve()),
    );
    this.socket.close();
    return closed;
  }

  private request<T>(
    pending: Map<string, Pending<T>>,
    key: string,
    frame: ClientFrame,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) {
        reject(
          new RelayError(
            "disconnected",
            this.closedBecause ?? "Not connected to relay.",
          ),
        );
        return;
      }
      pending.set(key, { resolve, reject });
      this.write(frame);
    });
  }

  /** Whether the relay has welcomed the current socket and it's still open. */
  private isOpen(): boolean {
    return (
      this.state !== "closed" &&
      this.welcomedOn === this.socket &&
      this.socket.readyState === WebSocket.OPEN
    );
  }

  private write(frame: ClientFrame) {
    this.socket.send(JSON.stringify(frame));
  }

  private receive(data: string) {
    const frame = parseFrame(RelayFrame, data);
    if (!frame) return;
    switch (frame.type) {
      case "challenge":
        this.challenge?.resolve(frame.challenge);
        this.challenge = undefined;
        return;
      case "welcome":
        this.welcomedOn = this.socket;
        this.welcome?.resolve(frame);
        this.welcome = undefined;
        return;
      case "lost": {
        const { messages } = frame;
        this.inbox = this.inbox.then(() => this.acceptLost(messages));
        return;
      }
      case "caught-up":
        this.markCaughtUp();
        return;
      case "deliver": {
        const { message } = frame;
        if (this.seen.has(message.id)) {
          // Read already, but delivered again after reconnecting: the read
          // receipt may have been lost with the old connection.
          if (this.readIds.has(message.id)) {
            this.write({ type: "read", ids: [message.id] });
          }
          // Couldn't be checked before; the connection may be back now.
          if (this.unchecked.has(message.id)) this.recheck();
          return;
        }
        this.seen.add(message.id);
        this.inbox = this.inbox.then(() => this.accept(message));
        return;
      }
      case "sent":
        take(this.sends, frame.id)?.resolve({
          id: frame.id,
          status: frame.status,
        });
        return;
      case "sent-list":
        take(this.listings, frame.requestId)?.resolve(frame.messages);
        return;
      case "team":
        take(this.teamRequests, frame.requestId)?.resolve(frame);
        return;
      case "presence":
        take(this.presenceRequests, frame.requestId)?.resolve(frame.online);
        return;
      case "error": {
        const error = new RelayError(frame.code, frame.message);
        if (frame.id) {
          (
            take(this.sends, frame.id) ??
            take(this.listings, frame.id) ??
            take(this.teamRequests, frame.id) ??
            take(this.presenceRequests, frame.id)
          )?.reject(error);
        } else if (this.welcome) {
          this.welcome.reject(error);
          this.welcome = undefined;
        }
        return;
      }
    }
  }
}

/** Runs `check`, reporting anything that doesn't verify as an untrusted reply from the relay. */
function untrusted<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (
      error instanceof TeamError ||
      error instanceof IdentityError ||
      error instanceof StaleLogError
    ) {
      throw new RelayError(
        "untrusted-reply",
        `The relay's reply doesn't verify: ${error.message}`,
      );
    }
    throw error;
  }
}

function take<T>(map: Map<string, T>, key: string): T | undefined {
  const value = map.get(key);
  map.delete(key);
  return value;
}
