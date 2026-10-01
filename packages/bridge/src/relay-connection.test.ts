import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientFrame,
  addDevice,
  createIdentity,
  createInvite,
  createTeam,
  generateDeviceKey,
  parseFrame,
  randomToken,
  verifyIdentityLog,
  verifyTeamLog,
  type IdentityLog,
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
}) {
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
