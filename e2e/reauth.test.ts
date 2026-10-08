import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayConnection, SignIns } from "@blether/bridge";
import { startRelay, type AccessProvider, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

/**
 * Credentials that say who they're for and when they expire:
 * `<subject>@<epoch ms>`, or just `<subject>` for one that never does.
 */
const expiring: AccessProvider = {
  describe: () => ({ kind: "token" }),
  authenticate: async (credential) => {
    if (!credential) return undefined;
    const [subject, at] = credential.split("@");
    return {
      provider: "token",
      issuer: "tests",
      subject: subject!,
      claims: {},
      ...(at ? { expiresAt: new Date(Number(at)) } : {}),
    };
  },
};
const inMs = (ms: number) => `kev@${Date.now() + ms}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("renewing a sign-in on a long-lived session", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let team: string;
  const connections: RelayConnection[] = [];

  beforeEach(async () => {
    relay = await startRelay({
      access: {
        provider: expiring,
        warnBeforeExpiryMs: 600,
        graceAfterExpiryMs: 0,
      },
    });
    root = mkdtempSync(join(tmpdir(), "blether-reauth-"));
    kev = device(root, "kev");
    await kev.run("init", "--name", "Kev");
    // A sign-in that never expires, for setting up.
    new SignIns(kev.store.home).save(relay.url, {
      kind: "token",
      credential: "kev",
      signedInAt: new Date().toISOString(),
    });
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await kev.run("agent", "create", "backend", "web");
    team = kev.teams.get("backend")!.id;
  });
  afterEach(async () => {
    await Promise.all(connections.splice(0).map((c) => c.close()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  const connect = async (
    credential: string,
    renewCredential?: () => Promise<string>,
  ) => {
    const connection = await RelayConnection.connect(
      relay.url,
      kev.store.load()!,
      {
        scope: { team, agent: "web" },
        credential,
        ...(renewCredential ? { renewCredential } : {}),
      },
    );
    connections.push(connection);
    return connection;
  };

  it("renews before each expiry, so the session stays connected", async () => {
    let renewals = 0;
    const connection = await connect(inMs(1_200), async () => {
      renewals++;
      return inMs(1_200);
    });

    await wait(2_600);

    expect(renewals).toBeGreaterThanOrEqual(2);
    expect(connection.problem).toBeUndefined();
    expect(await connection.roster()).toHaveLength(1);
  });

  it("ends the session, saying to sign in again, when it can't renew", async () => {
    for (const renew of [
      undefined,
      () => Promise.reject(new Error("the identity provider said no")),
    ]) {
      const connection = await connect(inMs(600), renew);
      const ended = new Promise<[string, string]>((resolve) =>
        connection.onEnd((end, why) => resolve([end, why])),
      );

      const [end, why] = await ended;

      expect(end).toBe("refused");
      expect(why).toContain(`blether sign-in ${relay.url}`);
    }
  });
});
