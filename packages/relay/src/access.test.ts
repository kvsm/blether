import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISCOVERY_PATH,
  RelayFrame,
  createIdentity,
  createTeam,
  generateDeviceKey,
  parseFrame,
  signChallenge,
  verifyIdentityLog,
} from "@blether/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  allows,
  parseRule,
  tokenAccess,
  tokenHash,
  type Principal,
  type Rules,
} from "./access.js";
import { RelayConfigError, relayConfig } from "./config.js";
import { startRelay, type Relay, type RelayOptions } from "./relay.js";

const device = generateDeviceKey();
const identity = createIdentity(device, "Alice");

const KEV_TOKEN = "kev-token-kev-token-kev-token-kev-token";
const ANN_TOKEN = "ann-token-ann-token-ann-token-ann-token";
const tokens = tokenAccess([
  { subject: "kev", sha256: tokenHash(KEV_TOKEN) },
  {
    subject: "ann",
    sha256: tokenHash(ANN_TOKEN),
    claims: { roles: ["team-creator"] },
  },
]);

/** The outcome of trying to open a WebSocket to the relay. */
type Upgrade =
  | { opened: WebSocket; frames: RelayFrame[]; next: () => Promise<RelayFrame> }
  | { status: number; authenticate: string | undefined };

/** Opens a WebSocket, sending `authorization` if given. */
function upgrade(url: string, authorization?: string): Promise<Upgrade> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: authorization ? { authorization } : {},
    });
    const frames: RelayFrame[] = [];
    let wake: (() => void) | undefined;
    socket.on("message", (data) => {
      frames.push(parseFrame(RelayFrame, data.toString())!);
      wake?.();
    });
    const next = async () => {
      while (frames.length === 0) {
        await new Promise<void>((r) => (wake = r));
      }
      return frames.shift()!;
    };
    socket.once("open", () => resolve({ opened: socket, frames, next }));
    socket.once("unexpected-response", (_req, res) => {
      resolve({
        status: res.statusCode ?? 0,
        authenticate: res.headers["www-authenticate"],
      });
      res.resume();
      socket.terminate();
    });
    socket.once("error", reject);
  });
}

/** Opens a connection with `token` and says hello, signing for `signedFor` (null: no credential). */
async function hello(
  url: string,
  token: string | undefined,
  signedFor: string | null | undefined = token,
) {
  const result = await upgrade(url, token && `Bearer ${token}`);
  if (!("opened" in result)) throw new Error(`refused: ${result.status}`);
  const challenge = await result.next();
  if (challenge.type !== "challenge") throw new Error("expected a challenge");
  result.opened.send(
    JSON.stringify({
      type: "hello",
      identity,
      device: device.publicKey,
      signature: signChallenge(
        device,
        challenge.challenge,
        {},
        signedFor ?? undefined,
      ),
    }),
  );
  return { reply: await result.next(), ...result };
}

describe("relay sign-in", () => {
  let relay: Relay | undefined;
  const sockets: WebSocket[] = [];

  const start = async (options: RelayOptions = {}) => {
    relay = await startRelay(options);
    return relay;
  };
  const discovery = async (relay: Relay) => {
    const response = await fetch(
      relay.url.replace(/^ws/, "http") + DISCOVERY_PATH,
    );
    return response.json();
  };

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await relay?.close();
    relay = undefined;
  });

  describe("an open relay", () => {
    it("says anyone may connect", async () => {
      expect(await discovery(await start())).toEqual({
        access: { kind: "open" },
      });
    });

    it("welcomes a connection with no credential", async () => {
      const { reply, opened } = await hello((await start()).url, undefined);
      sockets.push(opened);
      expect(reply.type).toBe("welcome");
    });
  });

  describe("a token relay", () => {
    const tokenRelay = (rules?: Rules) =>
      start({ access: { provider: tokens, ...(rules ? { rules } : {}) } });

    it("says it needs a token", async () => {
      expect(await discovery(await tokenRelay())).toEqual({
        access: { kind: "token" },
      });
    });

    it("refuses an upgrade with no token, before any WebSocket opens", async () => {
      const result = await upgrade((await tokenRelay()).url);

      expect(result).toEqual({
        status: 401,
        authenticate: 'Bearer realm="blether"',
      });
    });

    it("refuses an upgrade with a token it didn't issue", async () => {
      const result = await upgrade(
        (await tokenRelay()).url,
        "Bearer not-a-token-it-issued",
      );

      expect(result).toEqual({
        status: 401,
        authenticate: 'Bearer realm="blether", error="invalid_token"',
      });
    });

    it("refuses a credential that isn't a bearer token", async () => {
      const result = await upgrade(
        (await tokenRelay()).url,
        `Basic ${KEV_TOKEN}`,
      );

      expect(result).toMatchObject({ status: 401 });
    });

    it("welcomes a device that signs for the token it connected with", async () => {
      const { reply, opened } = await hello(
        (await tokenRelay()).url,
        KEV_TOKEN,
      );
      sockets.push(opened);

      expect(reply.type).toBe("welcome");
    });

    it("refuses a hello that doesn't cover the token the connection sent", async () => {
      const url = (await tokenRelay()).url;
      const unsigned = await hello(url, KEV_TOKEN, null);
      const otherToken = await hello(url, KEV_TOKEN, ANN_TOKEN);
      sockets.push(unsigned.opened, otherToken.opened);

      expect(unsigned.reply).toMatchObject({
        type: "error",
        code: "authentication-failed",
      });
      expect(otherToken.reply).toMatchObject({
        type: "error",
        code: "authentication-failed",
      });
    });

    it("refuses a connection the connect rule doesn't allow", async () => {
      const url = (
        await tokenRelay({
          connect: [{ claim: "roles", value: "team-creator" }],
          "team.create": "signed-in",
        })
      ).url;

      expect(await upgrade(url, `Bearer ${KEV_TOKEN}`)).toMatchObject({
        status: 403,
      });
    });

    it("lets a rule allow connecting but not creating teams", async () => {
      const url = (
        await tokenRelay({
          connect: "signed-in",
          "team.create": [{ claim: "roles", value: "team-creator" }],
        })
      ).url;
      const createAs = async (token: string) => {
        const { opened, next } = await hello(url, token);
        sockets.push(opened);
        opened.send(
          JSON.stringify({
            type: "create-team",
            requestId: randomUUID(),
            log: createTeam("backend", {
              device,
              identity: verifyIdentityLog(identity),
            }),
          }),
        );
        return next();
      };

      expect(await createAs(KEV_TOKEN)).toMatchObject({
        type: "error",
        code: "not-allowed",
      });
      expect(await createAs(ANN_TOKEN)).toMatchObject({ type: "team" });
    });
  });
});

describe("access rules", () => {
  const principal = (claims: Principal["claims"]): Principal => ({
    provider: "token",
    issuer: "tokens",
    subject: "kev",
    claims,
  });

  it("reads signed-in, and claim=value pairs", () => {
    expect(parseRule("signed-in")).toBe("signed-in");
    expect(parseRule("roles=admin, team=web")).toEqual([
      { claim: "roles", value: "admin" },
      { claim: "team", value: "web" },
    ]);
    expect(parseRule("admin")).toBeUndefined();
    expect(parseRule("roles=")).toBeUndefined();
  });

  it("matches a claim that equals the value, or lists it", () => {
    const rules: Rules = {
      connect: "signed-in",
      "team.create": [{ claim: "roles", value: "admin" }],
    };

    expect(allows(rules, principal({}), "connect")).toBe(true);
    expect(allows(rules, principal({ roles: "admin" }), "team.create")).toBe(
      true,
    );
    expect(
      allows(rules, principal({ roles: ["dev", "admin"] }), "team.create"),
    ).toBe(true);
    expect(allows(rules, principal({ roles: "dev" }), "team.create")).toBe(
      false,
    );
  });
});

describe("access configuration", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blether-access-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults to an open relay that lets anyone signed in do anything", async () => {
    const { access } = relayConfig({});

    expect(access?.provider.describe()).toEqual({ kind: "open" });
    expect(access?.rules).toEqual({
      connect: "signed-in",
      "team.create": "signed-in",
    });
  });

  it("reads tokens from the tokens file", async () => {
    const file = join(dir, "tokens.json");
    writeFileSync(
      file,
      JSON.stringify([{ subject: "kev", sha256: tokenHash(KEV_TOKEN) }]),
    );
    const { access } = relayConfig({
      BLETHER_RELAY_ACCESS: "token",
      BLETHER_RELAY_TOKENS_FILE: file,
      BLETHER_RELAY_ALLOW_TEAM_CREATE: "roles=admin",
    });

    expect(await access?.provider.authenticate(KEV_TOKEN)).toMatchObject({
      subject: "kev",
    });
    expect(access?.rules?.["team.create"]).toEqual([
      { claim: "roles", value: "admin" },
    ]);
  });

  it("explains what's wrong with the access settings", () => {
    expect(() => relayConfig({ BLETHER_RELAY_ACCESS: "ldap" })).toThrow(
      RelayConfigError,
    );
    expect(() => relayConfig({ BLETHER_RELAY_ACCESS: "token" })).toThrow(
      /BLETHER_RELAY_TOKENS_FILE/,
    );
    const bad = join(dir, "bad.json");
    writeFileSync(bad, '[{"subject":"kev"}]');
    expect(() =>
      relayConfig({
        BLETHER_RELAY_ACCESS: "token",
        BLETHER_RELAY_TOKENS_FILE: bad,
      }),
    ).toThrow(RelayConfigError);
    expect(() =>
      relayConfig({ BLETHER_RELAY_ALLOW_CONNECT: "everyone" }),
    ).toThrow(RelayConfigError);
  });
});
