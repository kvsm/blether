import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RelayAccess } from "@blether/protocol";
import * as oidc from "openid-client";
import type { SignIn, SignIns } from "./keystore.js";
import { isLoopback } from "./relay-connection.js";

/** What a relay that wants an OpenID Connect sign-in says to sign in with. */
export type OidcAccess = Omit<Extract<RelayAccess, { kind: "oidc" }>, "kind">;

/** What an identity provider handed over when the developer signed in. */
export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

/** How long to wait for the developer to finish signing in in their browser. */
export const BROWSER_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a saved access token must still be good for, or it's refreshed
 * before use: longer than the relay's warning before a sign-in expires.
 */
export const REFRESH_WITHIN_MS = 10 * 60_000;

/** The identity provider's endpoints, from its discovery document. */
async function configure(access: OidcAccess): Promise<oidc.Configuration> {
  const issuer = new URL(access.issuer);
  // Only https, except for an identity provider on this machine.
  const local = issuer.protocol === "http:" && isLoopback(issuer.hostname);
  return local
    ? oidc.discovery(issuer, access.clientId, undefined, oidc.None(), {
        execute: [oidc.allowInsecureRequests],
      })
    : oidc.discovery(issuer, access.clientId, undefined, oidc.None());
}

function tokensFrom(
  response: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
): Tokens {
  const expiresIn = response.expiresIn();
  return {
    accessToken: response.access_token,
    ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
    ...(expiresIn !== undefined
      ? { expiresAt: new Date(Date.now() + expiresIn * 1000) }
      : {}),
  };
}

/** What went wrong, in the identity provider's words when it gave some. */
export function signInFailure(error: unknown): string {
  if (
    error instanceof oidc.ResponseBodyError ||
    error instanceof oidc.AuthorizationResponseError
  ) {
    return error.error_description
      ? `${error.error_description} (${error.error})`
      : error.error;
  }
  return (error as Error).message;
}

/**
 * Signs in through the developer's browser: the authorization code flow
 * with PKCE, coming back to a one-off server on this machine (RFC 8252).
 */
export async function signInWithBrowser(
  access: OidcAccess,
  {
    open,
    say,
    timeoutMs = BROWSER_SIGN_IN_TIMEOUT_MS,
  }: {
    open: (url: string) => Promise<void>;
    say: (line: string) => void;
    timeoutMs?: number;
  },
): Promise<Tokens> {
  const config = await configure(access);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  try {
    const redirectUri = `http://localhost:${(server.address() as AddressInfo).port}/`;
    const returned = redirectTo(server, redirectUri, timeoutMs);
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: access.scopes.join(" "),
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
    });
    say("Opening your browser to sign in. If it doesn't open, go to:");
    say("");
    say(`  ${url.href}`);
    say("");
    await open(url.href).catch(() => {});
    return tokensFrom(
      await oidc.authorizationCodeGrant(config, await returned, {
        pkceCodeVerifier: verifier,
        expectedState: state,
      }),
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/** Waits for the browser to come back to `redirectUri`, and returns where it came back to. */
function redirectTo(
  server: Server,
  redirectUri: string,
  timeoutMs: number,
): Promise<URL> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          "Gave up waiting for the browser. Try again, or use --device-code to sign in on another device.",
        ),
      );
    }, timeoutMs);
    server.on("request", (req: IncomingMessage, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const { searchParams } = url;
      if (
        url.pathname !== "/" ||
        !(searchParams.has("code") || searchParams.has("error"))
      ) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end(
          searchParams.has("error")
            ? "Blether didn't get a sign-in. Go back to your terminal to see why."
            : "Blether got your sign-in. You can close this tab and go back to your terminal.",
        );
      clearTimeout(timer);
      resolve(url);
    });
  });
}

/**
 * Signs in with the device authorization grant (RFC 8628): the developer
 * enters a code in a browser anywhere, such as on their phone.
 */
export async function signInWithDeviceCode(
  access: OidcAccess,
  { say }: { say: (line: string) => void },
): Promise<Tokens> {
  const config = await configure(access);
  if (!config.serverMetadata().device_authorization_endpoint) {
    throw new Error(
      "The relay's identity provider doesn't offer sign-in with a device code. Sign in without --device-code.",
    );
  }
  const started = await oidc.initiateDeviceAuthorization(config, {
    scope: access.scopes.join(" "),
  });
  say(
    `To sign in, go to ${started.verification_uri} and enter the code ${started.user_code}`,
  );
  return tokensFrom(await oidc.pollDeviceAuthorizationGrant(config, started));
}

/** Gets a new access token with a refresh token. */
export async function refreshTokens(
  access: OidcAccess,
  refreshToken: string,
): Promise<Tokens> {
  const config = await configure(access);
  const tokens = tokensFrom(
    await oidc.refreshTokenGrant(config, refreshToken, {
      scope: access.scopes.join(" "),
    }),
  );
  // Some identity providers hand out a new refresh token each time, some don't.
  return { refreshToken, ...tokens };
}

/** What to save for an OpenID Connect sign-in. */
export function oidcSignIn(
  access: OidcAccess,
  tokens: Tokens,
  signedInAt: Date,
): SignIn {
  return {
    kind: "oidc",
    credential: tokens.accessToken,
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt.toISOString() } : {}),
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    access: {
      issuer: access.issuer,
      clientId: access.clientId,
      scopes: access.scopes,
    },
    signedInAt: signedInAt.toISOString(),
  };
}

/**
 * The credential to sign in to the relay at `url` with, or undefined if
 * this device hasn't signed in to it. An OpenID Connect access token that
 * expires within `refreshWithinMs` is refreshed first, and the new one
 * saved; this throws if that fails. The sign-in is read afresh each time,
 * so a token another process refreshed is used rather than refreshed again.
 */
export async function signInCredential(
  signIns: SignIns,
  url: string,
  { refreshWithinMs = REFRESH_WITHIN_MS }: { refreshWithinMs?: number } = {},
): Promise<string | undefined> {
  const signIn = signIns.get(url);
  if (
    signIn?.kind !== "oidc" ||
    !signIn.expiresAt ||
    Date.parse(signIn.expiresAt) - Date.now() > refreshWithinMs
  ) {
    return signIn?.credential;
  }
  if (!signIn.refreshToken) {
    throw new Error(
      `Your sign-in to the relay at ${url} is running out, and can't be renewed.`,
    );
  }
  let tokens;
  try {
    tokens = await refreshTokens(signIn.access, signIn.refreshToken);
  } catch (error) {
    throw new Error(
      `Couldn't renew your sign-in to the relay at ${url}: ${signInFailure(error)}`,
      { cause: error },
    );
  }
  signIns.save(
    url,
    oidcSignIn(signIn.access, tokens, new Date(signIn.signedInAt)),
  );
  return tokens.accessToken;
}

/**
 * Opens `url` in the developer's browser. Only http(s) URLs: anything else
 * could start a program.
 */
export function openBrowser(url: string): Promise<void> {
  const { protocol } = new URL(url);
  if (protocol !== "https:" && protocol !== "http:") {
    return Promise.reject(new Error(`Not opening ${url}.`));
  }
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
