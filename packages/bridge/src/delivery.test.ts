import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientFrame,
  addDevice,
  createAgent,
  createIdentity,
  createTeam,
  generateDeviceKey,
  parseFrame,
  randomToken,
  sealMessage,
  verifyIdentityLog,
  verifyTeamLog,
  type DeviceKey,
  type Envelope,
  type Message,
  type MessagePayload,
  type RelayFrame,
  type SentMessage,
  type TeamLog,
} from "@blether/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ReadMessages } from "./keystore.js";
import { RelayConnection, type MailboxItem } from "./relay-connection.js";

// One developer with two devices, owning both agents in a one-person team.
const desktop = generateDeviceKey();
const laptop = generateDeviceKey();
const identity = addDevice(
  createIdentity(desktop, "Kev"),
  desktop,
  laptop.publicKey,
);
const me = verifyIdentityLog(identity);
const signer = { device: desktop, identity: me };

const log: TeamLog = createTeam("backend", signer);
const known = new Map([[me.id, me]]);
log.push(createAgent(verifyTeamLog(log, known), "web", [], signer));
log.push(createAgent(verifyTeamLog(log, known), "api", [], signer));
const team = verifyTeamLog(log, known);

/** A message from `web` to `api`, as the relay would deliver it. */
function delivery(
  overrides: {
    payload?: Partial<MessagePayload>;
    from?: string;
    signedBy?: DeviceKey;
    sealedFor?: string[];
    envelope?: Envelope;
  } = {},
): Message {
  const id = overrides.payload?.id ?? randomUUID();
  const payload: MessagePayload = {
    id,
    team: team.id,
    from: "web",
    to: "api",
    body: "hello api",
    sentAt: new Date().toISOString(),
    ...overrides.payload,
  };
  return {
    id,
    from: overrides.from ?? "web",
    to: "api",
    envelope:
      overrides.envelope ??
      sealMessage(
        payload,
        overrides.signedBy ?? laptop,
        overrides.sealedFor ?? [desktop.publicKey, laptop.publicKey],
      ),
    receivedAt: new Date().toISOString(),
  };
}

/** A relay that welcomes `api`, serves the team log, and delivers `messages`. */
async function fakeRelay(messages: Message[], lost: SentMessage[] = []) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    const send = (frame: RelayFrame) => socket.send(JSON.stringify(frame));
    send({ type: "challenge", challenge: randomToken() });
    socket.on("message", (data) => {
      const frame = parseFrame(ClientFrame, data.toString());
      if (frame?.type === "hello") {
        send({
          type: "welcome",
          developer: me.id,
          identity,
          team: team.id,
          agent: "api",
        });
        for (const message of messages) send({ type: "deliver", message });
        if (lost.length > 0) send({ type: "lost", messages: lost });
      }
      if (frame?.type === "get-team") {
        send({
          type: "team",
          requestId: frame.requestId,
          log,
          identities: [identity],
        });
      }
    });
  });
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

describe("receiving encrypted messages", () => {
  let home: string;
  let cleanup: (() => Promise<void>)[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "blether-delivery-"));
  });
  afterEach(async () => {
    await Promise.all(cleanup.map((c) => c()));
    cleanup = [];
    rmSync(home, { recursive: true, force: true });
  });

  /** Connects as `api` on `device` and returns what ends up in the mailbox. */
  const receive = async (
    messages: Message[],
    device: DeviceKey = desktop,
    lost: SentMessage[] = [],
  ): Promise<MailboxItem[]> => {
    const relay = await fakeRelay(messages, lost);
    const connection = await RelayConnection.connect(
      relay.url,
      { device, identity },
      {
        scope: { team: team.id, agent: "api" },
        readMessages: new ReadMessages(home, team.id, "api"),
      },
    );
    cleanup.push(async () => {
      await connection.close();
      await relay.close();
    });
    // The socket is ordered: once a reply sent after the deliveries arrives,
    // every delivery has been received.
    await connection.getTeam(team.id);
    await connection.settled();
    return connection.readMailbox();
  };

  it("decrypts and verifies a message from a teammate's agent", async () => {
    const message = delivery();

    const [item] = await receive([message]);

    expect(item).toMatchObject({
      kind: "message",
      id: message.id,
      from: "web",
      body: "hello api",
    });
  });

  it("can be read on any of the recipient's devices", async () => {
    const [item] = await receive([delivery()], laptop);

    expect(item).toMatchObject({ kind: "message", body: "hello api" });
  });

  it("discards a message signed by a device that doesn't belong to the sending agent's developer", async () => {
    const [item] = await receive([delivery({ signedBy: generateDeviceKey() })]);

    expect(item).toMatchObject({ kind: "unreadable", reason: "rejected" });
  });

  it("discards a message the relay redirected to a different agent", async () => {
    const [item] = await receive([delivery({ payload: { to: "web" } })]);

    expect(item).toMatchObject({ kind: "unreadable", reason: "rejected" });
  });

  it("discards a message whose relay-stamped sender disagrees with the signed one", async () => {
    const [item] = await receive([delivery({ from: "api" })]);

    expect(item).toMatchObject({ kind: "unreadable", reason: "rejected" });
  });

  it("discards a message signed for another team", async () => {
    const [item] = await receive([
      delivery({ payload: { team: "o".repeat(43) } }),
    ]);

    expect(item).toMatchObject({ kind: "unreadable", reason: "rejected" });
  });

  it("explains a message sealed only for the developer's other devices, and leaves it unread", async () => {
    const [item] = await receive(
      [delivery({ sealedFor: [laptop.publicKey] })],
      desktop,
    );

    expect(item).toMatchObject({ kind: "unreadable", reason: "elsewhere" });
    expect(new ReadMessages(home, team.id, "api").has(item!.id)).toBe(false);
  });

  it("drops a message the relay replays after it was read", async () => {
    const message = delivery();
    expect(await receive([message])).toHaveLength(1);

    expect(await receive([message])).toEqual([]);
  });

  it("ignores a relay's claim that a message to an agent still in the team was lost", async () => {
    const claim: SentMessage = {
      id: randomUUID(),
      to: "web",
      sentAt: new Date().toISOString(),
      status: "lost",
    };

    expect(await receive([], desktop, [claim])).toEqual([]);
  });
});
