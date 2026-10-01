import type { AddressInfo } from "node:net";
import {
  ClientFrame,
  parseFrame,
  type AgentName,
  type ErrorCode,
  type RelayFrame,
} from "@blether/protocol";
import { WebSocketServer, type WebSocket } from "ws";

export interface RelayOptions {
  /** Port to listen on. 0 picks a free port. */
  port?: number;
  host?: string;
}

export interface Relay {
  /** WebSocket URL bridges connect to. */
  url: string;
  close(): Promise<void>;
}

/**
 * Starts a relay that passes messages between connected bridges.
 *
 * Walking-skeleton behaviour: there is no identity, team or encryption, and
 * messages to an agent with no connected session are refused rather than
 * queued (mailboxes arrive in #10).
 */
export async function startRelay(options: RelayOptions = {}): Promise<Relay> {
  const wss = new WebSocketServer({
    port: options.port ?? 0,
    host: options.host ?? "127.0.0.1",
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  const sessions = new Map<AgentName, WebSocket>();

  wss.on("connection", (socket) => {
    let agent: AgentName | undefined;

    const send = (frame: RelayFrame) => socket.send(JSON.stringify(frame));
    const fail = (code: ErrorCode, message: string, id?: string) =>
      send({ type: "error", code, message, ...(id ? { id } : {}) });

    socket.on("message", (data) => {
      const frame = parseFrame(ClientFrame, data.toString());
      if (!frame) {
        fail(
          "malformed-frame",
          "Frame is not valid JSON or has the wrong shape.",
        );
        return;
      }

      switch (frame.type) {
        case "hello": {
          if (agent) {
            fail("already-introduced", `This connection is already ${agent}.`);
            return;
          }
          if (sessions.has(frame.agent)) {
            fail(
              "agent-in-use",
              `Another session is already acting as ${frame.agent}.`,
            );
            socket.close();
            return;
          }
          agent = frame.agent;
          sessions.set(agent, socket);
          send({ type: "welcome", agent });
          return;
        }
        case "send": {
          if (!agent) {
            fail(
              "not-introduced",
              "Send hello before sending messages.",
              frame.id,
            );
            return;
          }
          const recipient = sessions.get(frame.to);
          if (!recipient) {
            fail(
              "recipient-offline",
              `No session is acting as ${frame.to}.`,
              frame.id,
            );
            return;
          }
          const deliver: RelayFrame = {
            type: "deliver",
            message: {
              id: frame.id,
              from: agent,
              to: frame.to,
              body: frame.body,
              sentAt: new Date().toISOString(),
            },
          };
          recipient.send(JSON.stringify(deliver));
          send({ type: "sent", id: frame.id });
          return;
        }
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
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
