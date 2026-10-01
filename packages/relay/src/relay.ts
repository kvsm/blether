import type { AddressInfo } from "node:net";
import {
  ClientFrame,
  IdentityError,
  parseFrame,
  randomToken,
  verifyChallenge,
  verifyIdentityLog,
  type AgentName,
  type Identity,
  type ErrorCode,
  type Message,
  type RelayFrame,
} from "@blether/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { MailboxStore } from "./mailbox-store.js";

export interface RelayOptions {
  /** Port to listen on. 0 picks a free port. */
  port?: number;
  host?: string;
  /** Path of the mailbox database. Defaults to an in-memory store. */
  databasePath?: string;
}

export interface Relay {
  /** WebSocket URL bridges connect to. */
  url: string;
  close(): Promise<void>;
}

/**
 * Starts a relay that holds agents' mailboxes and passes messages between
 * connected bridges.
 *
 * Every session must prove which developer it belongs to (see the protocol's
 * auth.ts). There are no teams or encryption yet. Until agents are created
 * deliberately (#8), the first developer to act as an agent name owns it, and
 * any agent a session has ever acted as can be messaged.
 */
export async function startRelay(options: RelayOptions = {}): Promise<Relay> {
  const store = new MailboxStore(options.databasePath ?? ":memory:");
  const wss = new WebSocketServer({
    port: options.port ?? 0,
    host: options.host ?? "127.0.0.1",
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  const sessions = new Map<AgentName, WebSocket>();

  const deliver = (socket: WebSocket, message: Message) => {
    const frame: RelayFrame = { type: "deliver", message };
    socket.send(JSON.stringify(frame));
    store.markDelivered(message.id);
  };

  wss.on("connection", (socket) => {
    let agent: AgentName | undefined;
    const challenge = randomToken();

    const send = (frame: RelayFrame) => socket.send(JSON.stringify(frame));
    const fail = (code: ErrorCode, message: string, id?: string) =>
      send({ type: "error", code, message, ...(id ? { id } : {}) });
    const refuse = (code: ErrorCode, message: string) => {
      fail(code, message);
      socket.close();
    };

    send({ type: "challenge", challenge });

    socket.on("message", (data) => {
      const frame = parseFrame(ClientFrame, data.toString());
      if (!frame) {
        fail(
          "malformed-frame",
          "Frame is not valid JSON or has the wrong shape.",
        );
        return;
      }

      if (frame.type === "hello") {
        if (agent) {
          fail("already-introduced", `This connection is already ${agent}.`);
          return;
        }
        let developer: Identity;
        try {
          developer = verifyIdentityLog(frame.identity);
        } catch (error) {
          if (!(error instanceof IdentityError)) throw error;
          refuse("authentication-failed", error.message);
          return;
        }
        if (
          !developer.machines.includes(frame.machine) ||
          !verifyChallenge(
            frame.machine,
            challenge,
            frame.agent,
            frame.signature,
          )
        ) {
          refuse(
            "authentication-failed",
            "The challenge wasn't signed by one of this developer's machines.",
          );
          return;
        }
        const owner = store.agentOwner(frame.agent);
        if (owner && owner !== developer.id) {
          refuse(
            "agent-owned-by-another",
            `${frame.agent} belongs to another developer.`,
          );
          return;
        }
        if (sessions.has(frame.agent)) {
          refuse(
            "agent-in-use",
            `Another session is already acting as ${frame.agent}.`,
          );
          return;
        }
        store.saveDeveloper(developer, frame.identity);
        store.claimAgent(frame.agent, developer.id);
        agent = frame.agent;
        sessions.set(agent, socket);
        send({ type: "welcome", agent, developer: developer.id });
        for (const message of store.unread(agent)) deliver(socket, message);
        return;
      }

      if (!agent) {
        fail(
          "not-introduced",
          "Send hello first.",
          frame.type === "send" ? frame.id : undefined,
        );
        return;
      }

      switch (frame.type) {
        case "send": {
          if (!store.agentOwner(frame.to)) {
            fail(
              "unknown-agent",
              `There is no agent called ${frame.to}.`,
              frame.id,
            );
            return;
          }
          const message: Message = {
            id: frame.id,
            from: agent,
            to: frame.to,
            body: frame.body,
            sentAt: new Date().toISOString(),
          };
          if (!store.add(message)) {
            fail(
              "duplicate-id",
              `A message with id ${frame.id} already exists.`,
              frame.id,
            );
            return;
          }
          const recipient = sessions.get(frame.to);
          if (recipient) deliver(recipient, message);
          send({
            type: "sent",
            id: frame.id,
            status: recipient ? "delivered" : "queued",
          });
          return;
        }
        case "read":
          store.markRead(agent, frame.ids);
          return;
        case "list-sent":
          send({
            type: "sent-list",
            requestId: frame.requestId,
            messages: store.sentBy(agent, frame.limit),
          });
          return;
      }
    });

    socket.on("close", () => {
      if (agent && sessions.get(agent) === socket) sessions.delete(agent);
    });
  });

  const { address, port } = wss.address() as AddressInfo;
  const host = address.includes(":") ? `[${address}]` : address;

  return {
    url: `ws://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close((err) => {
          store.close();
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
