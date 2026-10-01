import { randomUUID } from "node:crypto";
import {
  RelayFrame,
  parseFrame,
  type AgentName,
  type ClientFrame,
  type DeliveryStatus,
  type ErrorCode,
  type Message,
  type SentMessage,
} from "@blether/protocol";
import { WebSocket } from "ws";

/** The relay refused something the bridge asked for. */
export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode | "disconnected",
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

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: RelayError) => void;
}

/**
 * A session's connection to the relay, acting as one agent. Messages the
 * relay delivers are held here until the agent reads them.
 */
export class RelayConnection {
  private readonly unread: Message[] = [];
  /** Ids of every message received, so redeliveries after reconnecting are ignored. */
  private readonly seen = new Set<string>();
  private readonly sends = new Map<string, Pending<SendReceipt>>();
  private readonly listings = new Map<string, Pending<SentMessage[]>>();
  private welcome: Pending<void> | undefined;

  private constructor(
    private readonly socket: WebSocket,
    readonly agent: AgentName,
  ) {
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", () => {
      const error = new RelayError("disconnected", "Lost connection to relay.");
      this.welcome?.reject(error);
      for (const pending of [...this.sends.values(), ...this.listings.values()])
        pending.reject(error);
      this.sends.clear();
      this.listings.clear();
    });
  }

  /**
   * Connects to the relay and starts acting as `agent`. Anything already
   * waiting in the agent's mailbox is delivered straight away.
   */
  static async connect(
    url: string,
    agent: AgentName,
  ): Promise<RelayConnection> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    // Attach the handler before saying hello: the relay sends pending
    // messages immediately after its welcome.
    const connection = new RelayConnection(socket, agent);
    const welcomed = new Promise<void>((resolve, reject) => {
      connection.welcome = { resolve, reject };
    });
    connection.write({ type: "hello", agent });
    try {
      await welcomed;
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

  /** Returns every unread message, oldest first, and marks them read. */
  readMailbox(): Message[] {
    const messages = this.unread.splice(0);
    if (messages.length > 0 && this.socket.readyState === WebSocket.OPEN) {
      this.write({ type: "read", ids: messages.map((m) => m.id) });
    }
    return messages;
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
      case "welcome":
        this.welcome?.resolve();
        this.welcome = undefined;
        return;
      case "deliver":
        if (this.seen.has(frame.message.id)) return;
        this.seen.add(frame.message.id);
        this.unread.push(frame.message);
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
      case "error": {
        const error = new RelayError(frame.code, frame.message);
        if (frame.id) take(this.sends, frame.id)?.reject(error);
        else if (this.welcome) {
          this.welcome.reject(error);
          this.welcome = undefined;
        }
        return;
      }
    }
  }
}

function take<T>(map: Map<string, T>, key: string): T | undefined {
  const value = map.get(key);
  map.delete(key);
  return value;
}
