import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientFrame,
  addDevice,
  createIdentity,
  createAgent,
  createInvite,
  createTeam,
  sealMessage,
  generateDeviceKey,
  parseFrame,
  randomToken,
  verifyIdentityLog,
  verifyTeamLog,
  type IdentityLog,
  type Message,
  type RelayFrame,
  type TeamLog,
} from "@blether/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { SeenLogs, StaleLogError } from "./keystore.js";
import { RelayConnection } from "./relay-connection.js";

const device = generateDeviceKey();
const identity = createIdentity(device, "Kev");
const credentials = { device, identity };
const me = verifyIdentityLog(identity);
const signer = { device, identity: me };

/** A relay that answers hello and get-team with whatever the test says. */
async function fakeRelay(answers: {
  welcomeIdentity?: IdentityLog;
  teamLog?: TeamLog;
  identities?: IdentityLog[];
  /** After the welcome, wait this long before saying the backlog has been sent. */
  caughtUpAfterMs?: number;
  /** Deliveries to send straight after the welcome. */
  deliver?: Message[];
  /** How many get-team requests to fail before answering them. */
  failTeamRequests?: number;
}) {
  let teamFailures = answers.failTeamRequests ?? 0;
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
          identity: answers.welcomeIdentity ?? frame.identity,
        });
        for (const message of answers.deliver ?? []) {
          send({ type: "deliver", message });
        }
        if (answers.caughtUpAfterMs !== undefined) {
          setTimeout(
            () => send({ type: "caught-up" }),
            answers.caughtUpAfterMs,
          );
        }
      }
      if (frame?.type === "get-team" && teamFailures > 0) {
        teamFailures--;
        send({
          type: "error",
          id: frame.requestId,
          code: "unknown-team",
          message: "Try again.",
        });
        return;
      }
      if (frame?.type === "get-team" && answers.teamLog) {
        send({
          type: "team",
          requestId: frame.requestId,
          log: answers.teamLog,
          identities: answers.identities ?? [identity],
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

describe("RelayConnection catching up", () => {
  let closeRelay: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeRelay?.();
    closeRelay = undefined;
  });

  const connectAsAgent = async (caughtUpAfterMs: number) => {
    const relay = await fakeRelay({ caughtUpAfterMs });
    closeRelay = relay.close;
    return RelayConnection.connect(relay.url, credentials, {
      scope: { team: "team", agent: "web" },
    });
  };

  // The relay sends what was waiting after the welcome, in later frames, so
  // a mailbox read straight after connecting must wait for them.
  it("waits for the relay to finish sending the backlog", async () => {
    const connection = await connectAsAgent(300);
    const started = Date.now();

    await connection.settled();

    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await connection.close();
  });

  it("doesn't wait once the relay has caught up", async () => {
    const connection = await connectAsAgent(0);
    await connection.settled();
    const started = Date.now();

    await connection.settled();

    expect(Date.now() - started).toBeLessThan(100);
    await connection.close();
  });
});

describe("RelayConnection against a dishonest relay", () => {
  let home: string;
  let closeRelay: (() => Promise<void>) | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "blether-witness-"));
  });
  afterEach(async () => {
    await closeRelay?.();
    closeRelay = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  const connect = async (answers: Parameters<typeof fakeRelay>[0]) => {
    const relay = await fakeRelay(answers);
    closeRelay = relay.close;
    return RelayConnection.connect(relay.url, credentials, {
      witness: new SeenLogs(home),
    });
  };

  it("accepts a newer version of the developer's identity from the relay", async () => {
    const newer = addDevice(identity, device, generateDeviceKey().publicKey);

    const connection = await connect({ welcomeIdentity: newer });

    expect(connection.identity).toEqual(newer);
    await connection.close();
  });

  it("refuses someone else's identity in the welcome", async () => {
    const other = createIdentity(generateDeviceKey(), "Kev");

    await expect(connect({ welcomeIdentity: other })).rejects.toMatchObject({
      code: "untrusted-reply",
    });
  });

  it("refuses a version of the identity that diverges from this device's", async () => {
    const newer = addDevice(identity, device, generateDeviceKey().publicKey);
    const other = addDevice(identity, device, generateDeviceKey().publicKey);
    // This device already knows about `newer`.
    new SeenLogs(home).witness("identity", me.id, newer);

    await expect(connect({ welcomeIdentity: other })).rejects.toMatchObject({
      code: "untrusted-reply",
    });
  });

  it("refuses a team log older than one this device has seen", async () => {
    const created = createTeam("backend", signer);
    const team = verifyTeamLog(created, new Map([[me.id, me]]));
    const grown = [...created, createInvite(team, signer).entry];
    new SeenLogs(home).witness("team", team.id, grown);

    const connection = await connect({ teamLog: created });

    await expect(connection.getTeam(team.id)).rejects.toMatchObject({
      code: "untrusted-reply",
      message: expect.stringContaining("older version"),
    });
    await connection.close();
  });

  it("refuses a different team's log", async () => {
    const asked = verifyTeamLog(
      createTeam("backend", signer),
      new Map([[me.id, me]]),
    );
    const other = createTeam("frontend", signer);

    const connection = await connect({ teamLog: other });

    await expect(connection.getTeam(asked.id)).rejects.toMatchObject({
      code: "untrusted-reply",
    });
    await connection.close();
  });
});

describe("RelayConnection checking deliveries", () => {
  let closeRelay: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeRelay?.();
    closeRelay = undefined;
  });

  // Kev's team, with his agents web and api; web is the agent connecting.
  const created = createTeam("backend", signer);
  const withWeb = [
    ...created,
    createAgent(
      verifyTeamLog(created, new Map([[me.id, me]])),
      "web",
      [],
      signer,
    ),
  ];
  const teamLog = [
    ...withWeb,
    createAgent(
      verifyTeamLog(withWeb, new Map([[me.id, me]])),
      "api",
      [],
      signer,
    ),
  ];
  const team = verifyTeamLog(teamLog, new Map([[me.id, me]]));

  /** A message from api to web, signed by `by`. */
  const fromApi = (body: string, by = device): Message => {
    const id = randomUUID();
    const sentAt = new Date().toISOString();
    return {
      id,
      from: "api",
      to: "web",
      envelope: sealMessage(
        { id, team: team.id, from: "api", to: "web", body, sentAt },
        by,
        [device.publicKey],
      ),
      receivedAt: sentAt,
    };
  };

  const connectAsWeb = async (answers: Parameters<typeof fakeRelay>[0]) => {
    const relay = await fakeRelay({ teamLog, caughtUpAfterMs: 0, ...answers });
    closeRelay = relay.close;
    return RelayConnection.connect(relay.url, credentials, {
      scope: { team: team.id, agent: "web" },
    });
  };

  it("discards a delivery signed by a device that isn't the sending agent's developer's", async () => {
    const connection = await connectAsWeb({
      deliver: [fromApi("Trust me.", generateDeviceKey())],
    });

    await connection.settled();

    expect(connection.readMailbox()).toEqual([
      expect.objectContaining({ kind: "unreadable", reason: "rejected" }),
    ]);
    await connection.close();
  });

  it("keeps a delivery it couldn't check because the relay didn't answer, and checks it again", async () => {
    const connection = await connectAsWeb({
      deliver: [fromApi("Schema's changed.")],
      failTeamRequests: 1,
    });

    await connection.settled();
    expect(connection.readMailbox()).toEqual([]);
    expect(connection.uncheckedCount).toBe(1);

    await connection.settled();
    expect(connection.readMailbox()).toEqual([
      expect.objectContaining({ kind: "message", body: "Schema's changed." }),
    ]);
    expect(connection.uncheckedCount).toBe(0);
    await connection.close();
  });
});

describe("SeenLogs", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "blether-seen-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const longer = addDevice(identity, device, generateDeviceKey().publicKey);
  const forked = addDevice(identity, device, generateDeviceKey().publicKey);

  it("remembers the longest version across instances", () => {
    new SeenLogs(home).witness("identity", me.id, longer);

    expect(() =>
      new SeenLogs(home).witness("identity", me.id, identity),
    ).toThrow(StaleLogError);
  });

  it("accepts the same version again and newer versions", () => {
    const seen = new SeenLogs(home);
    seen.witness("identity", me.id, identity);
    seen.witness("identity", me.id, identity);
    seen.witness("identity", me.id, longer);
  });

  it("refuses a version that diverges", () => {
    const seen = new SeenLogs(home);
    seen.witness("identity", me.id, longer);

    expect(() => seen.witness("identity", me.id, forked)).toThrow(/disagrees/);
  });
});
