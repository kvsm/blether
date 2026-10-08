import { randomUUID } from "node:crypto";
import {
  RelayFrame,
  SIGN_IN_EXPIRED,
  createIdentity,
  generateDeviceKey,
  parseFrame,
  signChallenge,
} from "@blether/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AccessProvider } from "./access.js";
import { startRelay, type Relay } from "./relay.js";

const device = generateDeviceKey();
const identity = createIdentity(device, "Kev");

/**
 * Credentials for tests that say who they're for and when they expire:
 * `<subject>@<epoch ms>`, or just `<subject>` for one that never does.
 * `bad` is refused.
 */
const expiring: AccessProvider = {
  describe: () => ({ kind: "token" }),
  authenticate: async (credential) => {
    if (!credential || credential === "bad") return undefined;
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

const inMs = (subject: string, ms: number) => `${subject}@${Date.now() + ms}`;

/** A signed-in CLI session: says hello with `credential`, and collects what the relay sends. */
async function session(url: string, credential: string) {
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${credential}` },
  });
  const frames: RelayFrame[] = [];
  let wake: (() => void) | undefined;
  socket.on("message", (data) => {
    frames.push(parseFrame(RelayFrame, data.toString())!);
    wake?.();
  });
  const closed = new Promise<number>((resolve) =>
    socket.once("close", (code) => resolve(code)),
  );
  const next = async <T extends RelayFrame["type"]>(type: T) => {
    for (;;) {
      const i = frames.findIndex((f) => f.type === type || f.type === "error");
      if (i >= 0)
        return frames.splice(i, 1)[0]! as Extract<
          RelayFrame,
          { type: T | "error" }
        >;
      await new Promise<void>((r) => (wake = r));
    }
  };
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const { challenge } = (await next("challenge")) as { challenge: string };
  socket.send(
    JSON.stringify({
      type: "hello",
      identity,
      device: device.publicKey,
      signature: signChallenge(device, challenge, {}, credential),
    }),
  );
  expect((await next("welcome")).type).toBe("welcome");

  return {
    socket,
    next,
    closed,
    /** Sends a fresh credential, signed by `signer` (this device by default). */
    reauth: (fresh: string, signer = device) => {
      socket.send(
        JSON.stringify({
          type: "reauth",
          requestId: randomUUID(),
          credential: fresh,
          signature: signChallenge(signer, challenge, {}, fresh),
        }),
      );
      return next("reauthed");
    },
  };
}

describe("relay sign-in expiry", () => {
  let relay: Relay;
  afterEach(() => relay.close());

  const start = () =>
    startRelay({
      access: {
        provider: expiring,
        warnBeforeExpiryMs: 300,
        graceAfterExpiryMs: 0,
      },
    }).then((r) => (relay = r));

  it("warns before a sign-in expires, then closes the connection", async () => {
    await start();
    const kev = await session(relay.url, inMs("kev", 600));

    expect(await kev.next("sign-in-expiring")).toMatchObject({
      type: "sign-in-expiring",
    });
    expect(await kev.closed).toBe(SIGN_IN_EXPIRED);
  });

  it("keeps the connection open past the first expiry after a reauth", async () => {
    await start();
    const kev = await session(relay.url, inMs("kev", 600));
    await kev.next("sign-in-expiring");
    let closed = false;
    void kev.closed.then(() => (closed = true));

    const fresh = inMs("kev", 5_000);
    expect(await kev.reauth(fresh)).toEqual({
      type: "reauthed",
      requestId: expect.any(String),
      expiresAt: new Date(Number(fresh.split("@")[1])).toISOString(),
    });
    await new Promise((r) => setTimeout(r, 900));

    expect(closed).toBe(false);
    kev.socket.close();
  });

  it("never warns about a sign-in that doesn't expire", async () => {
    await start();
    const kev = await session(relay.url, "kev");
    await new Promise((r) => setTimeout(r, 400));

    expect(kev.socket.readyState).toBe(WebSocket.OPEN);
    kev.socket.close();
  });

  it("refuses a reauth as someone else, or that it doesn't accept, or another device signed", async () => {
    await start();
    const kev = await session(relay.url, inMs("kev", 60_000));

    expect(await kev.reauth(inMs("ann", 60_000))).toMatchObject({
      type: "error",
      code: "sign-in-refused",
    });
    expect(await kev.reauth("bad")).toMatchObject({
      type: "error",
      code: "sign-in-refused",
    });
    expect(
      await kev.reauth(inMs("kev", 60_000), generateDeviceKey()),
    ).toMatchObject({ type: "error", code: "authentication-failed" });
    kev.socket.close();
  });
});
