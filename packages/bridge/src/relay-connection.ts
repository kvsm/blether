import { randomUUID } from "node:crypto";
import {
  RelayFrame,
  parseFrame,
  type AgentName,
  type ClientFrame,
  type ErrorCode,
  type Message,
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

interface PendingSend {
  resolve: (id: string) => void;
  reject: (error: RelayError) => void;
}

/**
 * A session's connection to the relay, acting as one agent. Delivered
 * messages are held here until the agent reads them.
 */
export class RelayConnection {
  private readonly unread: Message[] = [];
  private readonly pending = new Map<string, PendingSend>();

  private constructor(
    private readonly socket: WebSocket,
    readonly agent: AgentName,
  ) {
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", () => {
      const error = new RelayError("disconnected", "Lost connection to relay.");
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
  }

  /** Connects to the relay and starts acting as `agent`. */
  static async connect(
    url: string,
    agent: AgentName,
  ): Promise<RelayConnection> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const welcomed = new Promise<void>((resolve, reject) => {
      socket.once("message", (data) => {
        const frame = parseFrame(RelayFrame, data.toString());
        if (frame?.type === "welcome") return resolve();
        socket.close();
        reject(
          frame?.type === "error"
            ? new RelayError(frame.code, frame.message)
            : new RelayError("malformed-frame", "Unexpected reply to hello."),
        );
      });
    });
    const hello: ClientFrame = { type: "hello", agent };
    socket.send(JSON.stringify(hello));
    await welcomed;

    return new RelayConnection(socket, agent);
  }

  /** Sends a message, resolving with its id once the relay accepts it. */
  send(to: AgentName, body: string): Promise<string> {
    const id = randomUUID();
    const frame: ClientFrame = { type: "send", id, to, body };
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new RelayError("disconnected", "Not connected to relay."));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(frame));
    });
  }

  /** Returns every unread message, oldest first, and marks them read. */
  readMailbox(): Message[] {
    return this.unread.splice(0);
  }

  close(): void {
    this.socket.close();
  }

  private receive(data: string) {
    const frame = parseFrame(RelayFrame, data);
    if (!frame) return;
    switch (frame.type) {
      case "deliver":
        this.unread.push(frame.message);
        return;
      case "sent":
        this.settle(frame.id)?.resolve(frame.id);
        return;
      case "error":
        if (frame.id) {
          this.settle(frame.id)?.reject(
            new RelayError(frame.code, frame.message),
          );
        }
        return;
      case "welcome":
        return;
    }
  }

  private settle(id: string): PendingSend | undefined {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    return pending;
  }
}
