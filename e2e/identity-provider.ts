import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** The client id the fake identity provider knows the CLI as. */
export const CLIENT_ID = "blether-cli";
/** The audience of the access tokens it issues: the relay's API. */
export const AUDIENCE = "relay-api";

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  return new URLSearchParams(body);
}

/**
 * An OpenID Connect identity provider for tests. It signs in whoever
 * `signInAs` names, without asking: through the authorization code flow
 * with PKCE, or with a device code that it approves on the second poll.
 * Refresh tokens work until `revokeRefreshTokens`.
 */
export async function identityProvider() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" };
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; subject: string }
  >();
  const devices = new Map<string, { subject: string; polls: number }>();
  const refreshTokens = new Map<string, string>();
  let subject = "kev-subject";
  let lifetimeSeconds = 3600;
  let denying = false;
  const grants: string[] = [];

  const tokens = async (who: string) => {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({
      iss: issuer,
      aud: AUDIENCE,
      sub: who,
      iat: now,
      exp: now + lifetimeSeconds,
      // So no two tokens are the same, even within a second.
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .sign(privateKey);
    const refreshToken = randomUUID();
    refreshTokens.set(refreshToken, who);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: lifetimeSeconds,
      refresh_token: refreshToken,
    };
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, body: unknown) =>
      res
        .writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(JSON.stringify(body));

    void (async () => {
      switch (url.pathname) {
        case "/.well-known/openid-configuration":
          return json(200, {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            device_authorization_endpoint: `${issuer}/device`,
            jwks_uri: `${issuer}/keys`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        case "/keys":
          return json(200, { keys: [jwk] });
        case "/authorize": {
          const q = url.searchParams;
          const back = new URL(q.get("redirect_uri")!);
          back.searchParams.set("state", q.get("state") ?? "");
          if (denying) {
            back.searchParams.set("error", "access_denied");
            back.searchParams.set(
              "error_description",
              "Your administrator hasn't given you access.",
            );
          } else if (
            q.get("client_id") === CLIENT_ID &&
            q.get("code_challenge_method") === "S256"
          ) {
            const code = randomUUID();
            codes.set(code, {
              challenge: q.get("code_challenge")!,
              redirectUri: q.get("redirect_uri")!,
              subject,
            });
            back.searchParams.set("code", code);
          } else {
            back.searchParams.set("error", "invalid_request");
          }
          res.writeHead(302, { location: back.href }).end();
          return;
        }
        case "/device": {
          const deviceCode = randomUUID();
          devices.set(deviceCode, { subject, polls: 0 });
          return json(200, {
            device_code: deviceCode,
            user_code: "WDJB-MJHT",
            verification_uri: `${issuer}/activate`,
            expires_in: 600,
            interval: 1,
          });
        }
        case "/token": {
          const body = await form(req);
          const grant = body.get("grant_type")!;
          grants.push(grant);
          if (body.get("client_id") !== CLIENT_ID) {
            return json(401, { error: "invalid_client" });
          }
          if (grant === "authorization_code") {
            const code = codes.get(body.get("code")!);
            codes.delete(body.get("code")!);
            const challenge = createHash("sha256")
              .update(body.get("code_verifier") ?? "")
              .digest("base64url");
            if (
              !code ||
              code.challenge !== challenge ||
              code.redirectUri !== body.get("redirect_uri")
            ) {
              return json(400, { error: "invalid_grant" });
            }
            return json(200, await tokens(code.subject));
          }
          if (grant === "refresh_token") {
            const who = refreshTokens.get(body.get("refresh_token")!);
            if (!who) {
              return json(400, {
                error: "invalid_grant",
                error_description: "The refresh token has expired.",
              });
            }
            return json(200, await tokens(who));
          }
          if (grant === DEVICE_CODE_GRANT) {
            const device = devices.get(body.get("device_code")!);
            if (!device) return json(400, { error: "expired_token" });
            if (device.polls++ === 0) {
              return json(400, { error: "authorization_pending" });
            }
            devices.delete(body.get("device_code")!);
            return json(200, await tokens(device.subject));
          }
          return json(400, { error: "unsupported_grant_type" });
        }
        default:
          res.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    /** The grant types asked for at the token endpoint, oldest first. */
    grants,
    /** Who the next sign-in is. */
    signInAs(who: string) {
      subject = who;
    },
    /** How long access tokens it issues from now on last. */
    tokensLast(seconds: number) {
      lifetimeSeconds = seconds;
    },
    /** Whether sign-ins in the browser are refused. */
    deny(on = true) {
      denying = on;
    },
    revokeRefreshTokens() {
      refreshTokens.clear();
    },
    /**
     * Plays the developer's browser: follows the sign-in page's redirect
     * back to the CLI.
     */
    browser: async (url: string) => {
      const page = await fetch(url, { redirect: "manual" });
      await fetch(page.headers.get("location")!);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
export type IdentityProvider = Awaited<ReturnType<typeof identityProvider>>;
