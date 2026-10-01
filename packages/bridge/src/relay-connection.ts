import { randomUUID } from "node:crypto";
import {
  IdentityError,
  RelayFrame,
  TeamError,
  parseFrame,
  signChallenge,
  verifyIdentityLog,
  verifyTeamLog,
  type AgentName,
  type ClientFrame,
  type DeliveryStatus,
  type ErrorCode,
  type Identity,
  type Message,
  type SentMessage,
  type SignedTeamEntry,
  type Team,
  type TeamLog,
} from "@blether/protocol";
import { WebSocket } from "ws";
import type { Credentials } from "./keystore.js";

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
  private readonly unread: Message[] = [];
  /** Ids of every message received, so redeliveries after reconnecting are ignored. */
  private readonly seen = new Set<string>();
  private readonly sends = new Map<string, Pending<SendReceipt>>();
  private readonly listings = new Map<string, Pending<SentMessage[]>>();
  private readonly teamRequests = new Map<string, Pending<TeamReply>>();
  private challenge: Pending<string> | undefined;
  private welcome: Pending<string> | undefined;
  /** The authenticated developer's identity id, once the relay has welcomed this session. */
  developer: string | undefined;
  private readonly arrivalListeners = new Set<(message: Message) => void>();

  private constructor(
    private readonly socket: WebSocket,
    readonly scope: AgentScope | undefined,
  ) {
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", () => {
      const error = new RelayError("disconnected", "Lost connection to relay.");
      this.challenge?.reject(error);
      this.welcome?.reject(error);
      for (const pending of [
        ...this.sends.values(),
        ...this.listings.values(),
        ...this.teamRequests.values(),
      ])
        pending.reject(error);
      this.sends.clear();
      this.listings.clear();
      this.teamRequests.clear();
    });
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
    scope?: AgentScope,
  ): Promise<RelayConnection> {
    const socket = new WebSocket(url);
    // Attach the frame handler at once: the relay sends its challenge as soon
    // as the connection opens, and pending messages straight after welcome.
    const connection = new RelayConnection(socket, scope);
    const challenged = new Promise<string>((resolve, reject) => {
      connection.challenge = { resolve, reject };
    });
    const welcomed = new Promise<string>((resolve, reject) => {
      connection.welcome = { resolve, reject };
    });
    // Avoid unhandled rejections if the socket fails before we await these.
    challenged.catch(() => {});
    welcomed.catch(() => {});

    try {
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const challenge = await challenged;
      connection.write({
        type: "hello",
        ...(scope ?? {}),
        identity: credentials.identity,
        machine: credentials.machine.publicKey,
        signature: signChallenge(credentials.machine, challenge, scope ?? {}),
      });
      connection.developer = await welcomed;
    } catch (error) {
      socket.close();
      throw error;
    }
    return connection;
  }

  /** Sends a message, resolving once the relay has accepted it. */
  send(to: AgentName, body: string): Promise<SendReceipt> {
    const id = randomUUID();
    return this.request(this.sends, id, { type: "send", id, to, body });
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

  /** Calls `listener` whenever a new message arrives. Returns a function that unsubscribes. */
  onArrival(listener: (message: Message) => void): () => void {
    this.arrivalListeners.add(listener);
    return () => this.arrivalListeners.delete(listener);
  }

  /** Returns every unread message, oldest first, and marks them read. */
  readMailbox(): Message[] {
    const messages = this.unread.splice(0);
    if (messages.length > 0 && this.socket.readyState === WebSocket.OPEN) {
      this.write({ type: "read", ids: messages.map((m) => m.id) });
    }
    return messages;
  }

  /** Starts a team whose log is `log`, returning it as the relay stored it. */
  async createTeam(log: TeamLog): Promise<VerifiedTeam> {
    const requestId = randomUUID();
    const reply = await this.request(this.teamRequests, requestId, {
      type: "create-team",
      requestId,
      log,
    });
    return verifyReply(reply);
  }

  /** Fetches team `id`'s log and verifies it. */
  async getTeam(id: string): Promise<VerifiedTeam> {
    const requestId = randomUUID();
    const reply = await this.request(this.teamRequests, requestId, {
      type: "get-team",
      requestId,
      team: id,
    });
    return verifyReply(reply, id);
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
    return verifyReply(reply, id);
  }

  /** Disconnects from the relay, resolving once the connection has closed. */
  close(): Promise<void> {
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
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new RelayError("disconnected", "Not connected to relay."));
        return;
      }
      pending.set(key, { resolve, reject });
      this.write(frame);
    });
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
        this.welcome?.resolve(frame.developer);
        this.welcome = undefined;
        return;
      case "deliver":
        if (this.seen.has(frame.message.id)) return;
        this.seen.add(frame.message.id);
        this.unread.push(frame.message);
        for (const listener of this.arrivalListeners) listener(frame.message);
        return;
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
      case "error": {
        const error = new RelayError(frame.code, frame.message);
        if (frame.id) {
          (
            take(this.sends, frame.id) ??
            take(this.listings, frame.id) ??
            take(this.teamRequests, frame.id)
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

/**
 * Verifies a team log the relay sent, rather than trusting the relay: every
 * identity and every entry is checked, and the team must be the one asked for.
 */
function verifyReply(reply: TeamReply, expectedId?: string): VerifiedTeam {
  try {
    const identities = new Map<string, Identity>();
    for (const log of reply.identities) {
      const identity = verifyIdentityLog(log);
      identities.set(identity.id, identity);
    }
    const team = verifyTeamLog(reply.log, identities);
    if (expectedId && team.id !== expectedId) {
      throw new TeamError("The relay sent a different team's log.");
    }
    return { team, log: reply.log, identities };
  } catch (error) {
    if (error instanceof TeamError || error instanceof IdentityError) {
      throw new RelayError(
        "untrusted-reply",
        `The relay's copy of the team doesn't verify: ${error.message}`,
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
