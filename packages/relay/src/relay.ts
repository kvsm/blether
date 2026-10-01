import type { AddressInfo } from "node:net";
import {
  ClientFrame,
  IdentityError,
  TeamError,
  compareLogs,
  parseFrame,
  randomToken,
  verifyChallenge,
  verifyIdentityLog,
  verifyTeamLog,
  type AgentName,
  type ErrorCode,
  type Identity,
  type Message,
  type RelayFrame,
  type Team,
  type TeamLog,
} from "@blether/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { MailboxStore } from "./mailbox-store.js";

export interface RelayOptions {
  /** Port to listen on. 0 picks a free port. */
  port?: number;
  host?: string;
  /** Path of the mailbox database. Defaults to an in-memory store. */
  databasePath?: string;
  /** Clock used to enforce invite expiry. */
  now?: () => Date;
}

export interface Relay {
  /** WebSocket URL bridges connect to. */
  url: string;
  close(): Promise<void>;
}

/** The team and agent an authenticated bridge session acts as. */
interface AgentScope {
  team: string;
  agent: AgentName;
}

const sessionKey = ({ team, agent }: AgentScope) => `${team}\n${agent}`;

/**
 * Starts a relay that holds teams' membership logs and agents' mailboxes, and
 * passes messages between connected bridges.
 *
 * Every session proves which developer it belongs to (see the protocol's
 * auth.ts). A bridge session names a team and an agent; the relay only
 * accepts it from a member of the team, and its messages never leave the
 * team. A CLI session names neither, and can only read and extend team logs.
 * A session can only act as an agent its developer created in the team log.
 * Message content is end-to-end encrypted: the relay stores and forwards
 * envelopes it can't read.
 */
export async function startRelay(options: RelayOptions = {}): Promise<Relay> {
  const store = new MailboxStore(options.databasePath ?? ":memory:");
  const now = options.now ?? (() => new Date());
  const wss = new WebSocketServer({
    port: options.port ?? 0,
    host: options.host ?? "127.0.0.1",
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  const sessions = new Map<string, WebSocket>();
  /** The developer behind each agent session, by session key. */
  const sessionOwners = new Map<string, string>();

  /** Sends an agent session the lost-message notices it hasn't acknowledged. */
  const sendLost = (socket: WebSocket, team: string, agent: AgentName) => {
    const messages = store.unackedLost(team, agent);
    if (messages.length === 0) return;
    const frame: RelayFrame = { type: "lost", messages };
    socket.send(JSON.stringify(frame));
  };

  /**
   * After an entry deletes agents (directly, or by removing their
   * developer): their mailboxes are lost, their sessions and any of a
   * removed developer's are closed, and senders who are online are told.
   */
  const applyRemovals = (team: string, before: Team, after: Team) => {
    const deleted = after.deletedAgents.slice(before.deletedAgents.length);
    const removed = before.members.filter((m) => !after.members.includes(m));
    if (deleted.length === 0 && removed.length === 0) return;
    for (const agent of deleted) store.loseMailbox(team, agent.name);
    for (const [key, socket] of sessions) {
      const [sessionTeam, agent] = key.split("\n") as [string, string];
      if (sessionTeam !== team) continue;
      const gone =
        deleted.some((d) => d.name === agent) ||
        removed.includes(sessionOwners.get(key) ?? "");
      if (gone) socket.close(4000, "This agent was deleted from the team.");
      else sendLost(socket, team, agent);
    }
  };

  const deliver = (socket: WebSocket, message: Message) => {
    const frame: RelayFrame = { type: "deliver", message };
    socket.send(JSON.stringify(frame));
    store.markDelivered(message.id);
  };

  /** Verifies a team log using the identities the relay holds for its authors. */
  const verifyTeam = (log: TeamLog): Team => {
    const identities = new Map<string, Identity>();
    for (const identityLog of store.developerLogs(log.map((e) => e.author))) {
      const identity = verifyIdentityLog(identityLog);
      identities.set(identity.id, identity);
    }
    return verifyTeamLog(log, identities);
  };

  const teamReply = (requestId: string, log: TeamLog): RelayFrame => ({
    type: "team",
    requestId,
    log,
    identities: store.developerLogs(log.map((e) => e.author)),
  });

  wss.on("connection", (socket) => {
    const challenge = randomToken();
    let developer: Identity | undefined;
    let scope: AgentScope | undefined;

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
        if (developer) {
          fail("already-introduced", "This connection has already said hello.");
          return;
        }
        if (!frame.team !== !frame.agent) {
          refuse(
            "malformed-frame",
            "A hello names both a team and an agent, or neither.",
          );
          return;
        }
        let identity: Identity;
        try {
          identity = verifyIdentityLog(frame.identity);
        } catch (error) {
          if (!(error instanceof IdentityError)) throw error;
          refuse("authentication-failed", error.message);
          return;
        }
        // Keep the longest version of the identity log: a device that hasn't
        // heard about a newer entry presents an older prefix, and two
        // versions that disagree mean someone has forked the identity.
        let identityLog = frame.identity;
        const stored = store.developerLog(identity.id);
        if (stored) {
          const relation = compareLogs(frame.identity, stored);
          if (relation === "diverged") {
            refuse(
              "identity-conflict",
              "This identity log disagrees with the copy the relay holds.",
            );
            return;
          }
          if (relation === "behind") {
            identityLog = stored;
            identity = verifyIdentityLog(stored);
          }
        }
        if (
          !identity.devices.includes(frame.device) ||
          !verifyChallenge(
            frame.device,
            challenge,
            { team: frame.team, agent: frame.agent },
            frame.signature,
          )
        ) {
          refuse(
            "authentication-failed",
            "The challenge wasn't signed by one of this developer's devices.",
          );
          return;
        }
        store.saveDeveloper(identity, identityLog);

        if (frame.team && frame.agent) {
          const requested = { team: frame.team, agent: frame.agent };
          const log = store.teamLog(requested.team);
          if (!log) {
            refuse("unknown-team", "This relay has no such team.");
            return;
          }
          const team = verifyTeam(log);
          if (!team.members.includes(identity.id)) {
            refuse("not-a-member", "You aren't a member of this team.");
            return;
          }
          const agent = team.agents.find((a) => a.name === requested.agent);
          if (!agent) {
            refuse(
              "unknown-agent",
              `The team has no agent called ${requested.agent}. Create it with \`blether agent create ${team.name} ${requested.agent}\`.`,
            );
            return;
          }
          if (agent.owner !== identity.id) {
            refuse(
              "agent-owned-by-another",
              `${requested.agent} belongs to another developer.`,
            );
            return;
          }
          if (sessions.has(sessionKey(requested))) {
            refuse(
              "agent-in-use",
              `Another session is already acting as ${requested.agent}.`,
            );
            return;
          }
          scope = requested;
          sessions.set(sessionKey(scope), socket);
          sessionOwners.set(sessionKey(scope), identity.id);
        }

        developer = identity;
        send({
          type: "welcome",
          developer: identity.id,
          identity: identityLog,
          ...(scope ? { team: scope.team, agent: scope.agent } : {}),
        });
        if (scope) {
          for (const message of store.unread(scope.team, scope.agent)) {
            deliver(socket, message);
          }
          sendLost(socket, scope.team, scope.agent);
        }
        return;
      }

      if (!developer) {
        fail(
          "not-introduced",
          "Send hello first.",
          "id" in frame
            ? frame.id
            : "requestId" in frame
              ? frame.requestId
              : undefined,
        );
        return;
      }

      switch (frame.type) {
        case "create-team": {
          const [first] = frame.log;
          if (frame.log.length !== 1 || first!.author !== developer.id) {
            fail(
              "team-rejected",
              "A new team's log is a single team-created entry by you.",
              frame.requestId,
            );
            return;
          }
          let team: Team;
          try {
            team = verifyTeam(frame.log);
          } catch (error) {
            if (!(error instanceof TeamError)) throw error;
            fail("team-rejected", error.message, frame.requestId);
            return;
          }
          if (!store.createTeam(team.id, frame.log)) {
            fail("team-conflict", "That team already exists.", frame.requestId);
            return;
          }
          send(teamReply(frame.requestId, frame.log));
          return;
        }

        case "get-team": {
          const log = store.teamLog(frame.team);
          if (!log) {
            fail(
              "unknown-team",
              "This relay has no such team.",
              frame.requestId,
            );
            return;
          }
          send(teamReply(frame.requestId, log));
          return;
        }

        case "append-team": {
          const current = store.teamLog(frame.team);
          if (!current) {
            fail(
              "unknown-team",
              "This relay has no such team.",
              frame.requestId,
            );
            return;
          }
          if (frame.entry.author !== developer.id) {
            fail(
              "team-rejected",
              "You can only append entries you author.",
              frame.requestId,
            );
            return;
          }
          let before: Team;
          try {
            before = verifyTeam(current);
          } catch (error) {
            if (!(error instanceof TeamError)) throw error;
            fail("team-rejected", error.message, frame.requestId);
            return;
          }
          if (frame.entry.prev !== before.head) {
            fail(
              "team-conflict",
              "The team log has changed since you read it. Fetch it and try again.",
              frame.requestId,
            );
            return;
          }
          const { entry } = frame.entry;
          if (entry.type === "member-added") {
            const invite = before.invites.find((i) => i.id === entry.invite);
            if (invite && now().toISOString() > invite.expiresAt) {
              fail(
                "team-rejected",
                "This invite has expired.",
                frame.requestId,
              );
              return;
            }
          }
          const log = [...current, frame.entry];
          let after: Team;
          try {
            after = verifyTeam(log);
          } catch (error) {
            if (!(error instanceof TeamError)) throw error;
            fail("team-rejected", error.message, frame.requestId);
            return;
          }
          if (!store.updateTeam(frame.team, log, current.length)) {
            fail(
              "team-conflict",
              "The team log has changed since you read it. Fetch it and try again.",
              frame.requestId,
            );
            return;
          }
          send(teamReply(frame.requestId, log));
          applyRemovals(frame.team, before, after);
          return;
        }

        case "get-presence": {
          const log = store.teamLog(frame.team);
          if (!log || !verifyTeam(log).members.includes(developer.id)) {
            fail(
              "not-a-member",
              "You aren't a member of this team.",
              frame.requestId,
            );
            return;
          }
          const prefix = sessionKey({ team: frame.team, agent: "" });
          send({
            type: "presence",
            requestId: frame.requestId,
            online: [...sessions.keys()]
              .filter((key) => key.startsWith(prefix))
              .map((key) => key.slice(prefix.length))
              .sort(),
          });
          return;
        }
      }

      if (!scope) {
        fail(
          "no-agent",
          "This session isn't acting as an agent.",
          frame.type === "send" ? frame.id : undefined,
        );
        return;
      }

      switch (frame.type) {
        case "send": {
          const team = verifyTeam(store.teamLog(scope.team)!);
          if (!team.agents.some((a) => a.name === frame.to)) {
            fail(
              "unknown-agent",
              `There is no agent called ${frame.to} in this team.`,
              frame.id,
            );
            return;
          }
          const message: Message = {
            id: frame.id,
            from: scope.agent,
            to: frame.to,
            envelope: frame.envelope,
            receivedAt: now().toISOString(),
          };
          if (!store.add(scope.team, message)) {
            fail(
              "duplicate-id",
              `A message with id ${frame.id} already exists.`,
              frame.id,
            );
            return;
          }
          const recipient = sessions.get(
            sessionKey({ team: scope.team, agent: frame.to }),
          );
          if (recipient) deliver(recipient, message);
          send({
            type: "sent",
            id: frame.id,
            status: recipient ? "delivered" : "queued",
          });
          return;
        }
        case "read":
          store.markRead(scope.team, scope.agent, frame.ids);
          return;
        case "ack-lost":
          store.ackLost(scope.team, scope.agent, frame.ids);
          return;
        case "list-sent":
          send({
            type: "sent-list",
            requestId: frame.requestId,
            messages: store.sentBy(scope.team, scope.agent, frame.limit),
          });
          return;
      }
    });

    socket.on("close", () => {
      if (scope && sessions.get(sessionKey(scope)) === socket) {
        sessions.delete(sessionKey(scope));
        sessionOwners.delete(sessionKey(scope));
      }
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
