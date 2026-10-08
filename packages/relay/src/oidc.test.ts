import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RelayConfigError, relayConfig } from "./config.js";
import { entraSettings, oidcAccess, type OidcSettings } from "./oidc.js";
import { startRelay, type Relay } from "./relay.js";

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

async function signingKey(kid: string): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
}

/**
 * An OpenID Connect issuer for tests: a discovery document and the signing
 * keys it publishes, which a test can rotate or take offline.
 */
async function fakeIssuer() {
  let published: SigningKey[] = [await signingKey("key-1")];
  let online = true;
  let keyFetches = 0;
  const server: Server = createServer((req, res) => {
    if (!online) {
      res.writeHead(503).end();
      return;
    }
    if (req.url === "/.well-known/openid-configuration") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ issuer, jwks_uri: `${issuer}/keys` }));
    } else if (req.url === "/keys") {
      keyFetches++;
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ keys: published.map((k) => k.jwk) }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    get keyFetches() {
      return keyFetches;
    },
    /** Signs an access token: for the relay, from this issuer, valid for an hour, unless `claims` say otherwise. */
    token: async (
      claims: JWTPayload = {},
      { key = published[0]!, alg = "RS256" } = {},
    ) =>
      new SignJWT({
        iss: issuer,
        aud: "relay-api",
        sub: "kev-subject",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...claims,
      })
        .setProtectedHeader({ alg, kid: key.kid })
        .sign(key.privateKey),
    /** Starts signing with a new key, and stops publishing the old ones. */
    rotate: async (kid: string) => {
      const next = await signingKey(kid);
      published = [next];
      return next;
    },
    goOffline: () => {
      online = false;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Issuer = Awaited<ReturnType<typeof fakeIssuer>>;

describe("oidc sign-in", () => {
  let issuer: Issuer;
  let relay: Relay | undefined;

  beforeEach(async () => {
    issuer = await fakeIssuer();
  });
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    await issuer.close();
  });

  const settings = (extra: Partial<OidcSettings> = {}): OidcSettings => ({
    issuer: issuer.issuer,
    audience: "relay-api",
    clientId: "blether-cli",
    scopes: ["openid", "offline_access"],
    jwksCooldownMs: 0,
    ...extra,
  });

  it("tells clients where and how to sign in", () => {
    expect(oidcAccess(settings()).describe()).toEqual({
      kind: "oidc",
      issuer: issuer.issuer,
      clientId: "blether-cli",
      scopes: ["openid", "offline_access"],
    });
  });

  it("admits a token signed by the issuer, for the relay", async () => {
    const access = oidcAccess(settings());
    const exp = Math.floor(Date.now() / 1000) + 600;

    const principal = await access.authenticate(
      await issuer.token({ exp, roles: ["Blether.Use"], email: "kev@x" }),
    );

    expect(principal).toEqual({
      provider: "oidc",
      issuer: issuer.issuer,
      subject: "kev-subject",
      claims: { roles: ["Blether.Use"] },
      expiresAt: new Date(exp * 1000),
    });
  });

  it("refuses tokens that aren't valid for this relay", async () => {
    const access = oidcAccess(settings());
    const now = Math.floor(Date.now() / 1000);
    const stranger = await signingKey("key-1");

    for (const [why, token] of [
      ["another audience", await issuer.token({ aud: "another-api" })],
      ["another issuer", await issuer.token({ iss: "https://elsewhere" })],
      ["expired", await issuer.token({ exp: now - 3600 })],
      ["not yet valid", await issuer.token({ nbf: now + 3600 })],
      ["an empty subject", await issuer.token({ sub: "" })],
      ["signed by someone else", await issuer.token({}, { key: stranger })],
      ["not a token", "not.a.token"],
    ] as const) {
      expect(await access.authenticate(token), why).toBeUndefined();
    }
  });

  it("refuses a token signed with a shared secret instead of the issuer's key", async () => {
    const access = oidcAccess(settings());
    const forged = await new SignJWT({ sub: "kev-subject", aud: "relay-api" })
      .setIssuer(issuer.issuer)
      .setExpirationTime("1h")
      .setProtectedHeader({ alg: "HS256", kid: "key-1" })
      .sign(new TextEncoder().encode("a-shared-secret-of-enough-length!!"));

    expect(await access.authenticate(forged)).toBeUndefined();
  });

  it("picks up the issuer's new signing key without restarting", async () => {
    const access = oidcAccess(settings());
    expect(await access.authenticate(await issuer.token())).toBeDefined();

    const next = await issuer.rotate("key-2");

    expect(
      await access.authenticate(await issuer.token({}, { key: next })),
    ).toBeDefined();
    expect(issuer.keyFetches).toBe(2);
  });

  it("says it can't check, rather than refusing, when the issuer is down", async () => {
    const access = oidcAccess(settings());
    const token = await issuer.token();
    issuer.goOffline();

    await expect(access.authenticate(token)).rejects.toThrow();
  });

  describe("the Entra preset", () => {
    const TENANT = "11111111-2222-3333-4444-555555555555";
    // The preset's issuer is Microsoft's; here it points at the fake.
    const entra = () =>
      oidcAccess({
        ...entraSettings({
          tenant: TENANT,
          apiClientId: "relay-api",
          cliClientId: "blether-cli",
        }),
        issuer: issuer.issuer,
        jwksCooldownMs: 0,
      });

    it("asks for the relay's scope and a refresh token", () => {
      expect(
        entraSettings({
          tenant: TENANT,
          apiClientId: "relay-api",
          cliClientId: "blether-cli",
        }),
      ).toMatchObject({
        issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        audience: "relay-api",
        clientId: "blether-cli",
        scopes: ["api://relay-api/Relay.Access", "offline_access"],
      });
    });

    it("admits a user of the tenant, as their object id, with their roles", async () => {
      const principal = await entra().authenticate(
        await issuer.token({
          tid: TENANT,
          oid: "kev-object-id",
          roles: ["Blether.Use"],
          name: "Kev Smith",
        }),
      );

      expect(principal).toMatchObject({
        subject: "kev-object-id",
        claims: { roles: ["Blether.Use"], tid: TENANT, name: "Kev Smith" },
      });
    });

    it("refuses a token from another tenant", async () => {
      expect(
        await entra().authenticate(
          await issuer.token({ tid: "another-tenant", oid: "kev-object-id" }),
        ),
      ).toBeUndefined();
    });
  });

  describe("on a relay", () => {
    /** Tries a WebSocket upgrade with `token`; resolves to the HTTP status, or 101. */
    const upgrade = (url: string, token: string) =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(url, {
          headers: { authorization: `Bearer ${token}` },
        });
        socket.once("open", () => {
          socket.terminate();
          resolve(101);
        });
        socket.once("unexpected-response", (_req, res) => {
          res.resume();
          socket.terminate();
          resolve(res.statusCode ?? 0);
        });
        socket.once("error", reject);
      });

    it("lets in only tokens with the role the connect rule asks for", async () => {
      relay = await startRelay({
        access: {
          provider: oidcAccess(settings()),
          rules: {
            connect: [{ claim: "roles", value: "Blether.Use" }],
            "team.create": "signed-in",
          },
        },
      });

      expect(
        await upgrade(
          relay.url,
          await issuer.token({ roles: ["Blether.Use"] }),
        ),
      ).toBe(101);
      expect(await upgrade(relay.url, await issuer.token())).toBe(403);
      expect(
        await upgrade(
          relay.url,
          await issuer.token({ exp: Math.floor(Date.now() / 1000) - 3600 }),
        ),
      ).toBe(401);
    });

    it("answers 503 while it can't reach the issuer", async () => {
      relay = await startRelay({
        access: { provider: oidcAccess(settings()) },
      });
      const token = await issuer.token();
      issuer.goOffline();

      expect(await upgrade(relay.url, token)).toBe(503);
    });
  });
});

describe("oidc configuration", () => {
  it("reads a generic OpenID Connect provider", () => {
    const { access } = relayConfig({
      BLETHER_RELAY_ACCESS: "oidc",
      BLETHER_RELAY_OIDC_ISSUER: "https://id.example.com",
      BLETHER_RELAY_OIDC_AUDIENCE: "relay",
      BLETHER_RELAY_OIDC_CLIENT_ID: "blether-cli",
    });

    expect(access?.provider.describe()).toEqual({
      kind: "oidc",
      issuer: "https://id.example.com",
      clientId: "blether-cli",
      scopes: ["openid", "offline_access"],
    });
  });

  it("reads the Entra preset", () => {
    const { access } = relayConfig({
      BLETHER_RELAY_ACCESS: "entra",
      BLETHER_RELAY_ENTRA_TENANT: "tenant-id",
      BLETHER_RELAY_ENTRA_API_CLIENT_ID: "api-id",
      BLETHER_RELAY_ENTRA_CLI_CLIENT_ID: "cli-id",
    });

    expect(access?.provider.describe()).toEqual({
      kind: "oidc",
      issuer: "https://login.microsoftonline.com/tenant-id/v2.0",
      clientId: "cli-id",
      scopes: ["api://api-id/Relay.Access", "offline_access"],
    });
  });

  it("says which setting is missing", () => {
    expect(() =>
      relayConfig({
        BLETHER_RELAY_ACCESS: "entra",
        BLETHER_RELAY_ENTRA_TENANT: "tenant-id",
      }),
    ).toThrow(/BLETHER_RELAY_ENTRA_API_CLIENT_ID/);
    expect(() =>
      relayConfig({
        BLETHER_RELAY_ACCESS: "oidc",
        BLETHER_RELAY_OIDC_ISSUER: "not a url",
      }),
    ).toThrow(RelayConfigError);
  });
});
