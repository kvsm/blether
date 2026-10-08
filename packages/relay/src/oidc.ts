import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { AccessProvider, Claims, Principal } from "./access.js";

/** How an `oidc` relay checks access tokens, and what it tells clients. */
export interface OidcSettings {
  /** The issuer, exactly as tokens' `iss` claim gives it. */
  issuer: string;
  /** The audience tokens must be for: the relay's API. */
  audience: string;
  /** The public client the CLI signs in as. */
  clientId: string;
  /** The scopes the CLI asks for. */
  scopes: string[];
  /** The claim naming who signed in. Defaults to `sub`. */
  subjectClaim?: string;
  /** Claims that rules can check, copied from the token. Defaults to `roles`. */
  claims?: string[];
  /** Claims a token must have, with these exact values. */
  require?: Record<string, string>;
  /** The issuer's signing keys. Defaults to the `jwks_uri` its discovery document names. */
  jwksUri?: string;
  /** The shortest gap between fetches of the signing keys. Defaults to 30 seconds. */
  jwksCooldownMs?: number;
}

/** Signing algorithms accepted: asymmetric only, so a published key can't be used to forge. */
const ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

/** Leeway for clocks that disagree a little, in seconds. */
const CLOCK_TOLERANCE_S = 60;

/**
 * Errors that mean the token is bad. Anything else (the issuer can't be
 * reached, or sends something malformed) means the relay can't check it
 * right now, which it reports differently.
 */
const REFUSALS = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
]);

/**
 * Connections need an access token from an OpenID Connect provider, signed
 * by one of the issuer's published keys. The keys are fetched when first
 * needed, and again when a token names one the relay hasn't seen, so the
 * issuer can rotate them without the relay restarting.
 */
export function oidcAccess(settings: OidcSettings): AccessProvider {
  const subjectClaim = settings.subjectClaim ?? "sub";
  const kept = settings.claims ?? ["roles"];
  let keys: Promise<JWTVerifyGetKey> | undefined;

  const signingKeys = () => {
    keys ??= (async () => {
      const uri = settings.jwksUri ?? (await jwksUriOf(settings.issuer));
      return createRemoteJWKSet(new URL(uri), {
        cooldownDuration: settings.jwksCooldownMs ?? 30_000,
      });
    })();
    // A failed lookup is tried again on the next connection.
    keys.catch(() => (keys = undefined));
    return keys;
  };

  return {
    describe: () => ({
      kind: "oidc",
      issuer: settings.issuer,
      clientId: settings.clientId,
      scopes: settings.scopes,
    }),
    authenticate: async (credential) => {
      if (credential === undefined) return undefined;
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(credential, await signingKeys(), {
          issuer: settings.issuer,
          audience: settings.audience,
          algorithms: ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_S,
          requiredClaims: ["exp", subjectClaim],
        }));
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && REFUSALS.has(code)) return undefined;
        throw error;
      }
      for (const [claim, value] of Object.entries(settings.require ?? {})) {
        if (payload[claim] !== value) return undefined;
      }
      const subject = payload[subjectClaim];
      if (typeof subject !== "string" || subject === "") return undefined;
      return {
        provider: "oidc",
        issuer: settings.issuer,
        subject,
        claims: pick(payload, kept),
        expiresAt: new Date(payload.exp! * 1000),
      } satisfies Principal;
    },
  };
}

/** The claims in `names` that hold a string or a list of strings. */
function pick(payload: JWTPayload, names: string[]): Claims {
  const claims: Claims = {};
  for (const name of names) {
    const value = payload[name];
    if (typeof value === "string") claims[name] = value;
    else if (
      Array.isArray(value) &&
      value.every((v): v is string => typeof v === "string")
    ) {
      claims[name] = value;
    }
  }
  return claims;
}

/** Reads the issuer's discovery document for where its signing keys are. */
async function jwksUriOf(issuer: string): Promise<string> {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`${url} answered with HTTP ${response.status}.`);
  }
  const { jwks_uri: uri } = (await response.json()) as { jwks_uri?: unknown };
  if (typeof uri !== "string") throw new Error(`${url} names no jwks_uri.`);
  return uri;
}

/** Microsoft Entra ID: a preset of oidcAccess for one tenant's v2 access tokens. */
export interface EntraSettings {
  /** The directory (tenant) id. */
  tenant: string;
  /** The relay API app registration's application (client) id: v2 tokens' audience. */
  apiClientId: string;
  /** The CLI app registration's application (client) id. */
  cliClientId: string;
  /** The scope the CLI asks for. Defaults to `api://<apiClientId>/Relay.Access`. */
  scope?: string;
}

export function entraSettings(entra: EntraSettings): OidcSettings {
  return {
    issuer: `https://login.microsoftonline.com/${entra.tenant}/v2.0`,
    audience: entra.apiClientId,
    clientId: entra.cliClientId,
    // offline_access gets a refresh token, so the CLI can renew without asking.
    scopes: [
      entra.scope ?? `api://${entra.apiClientId}/Relay.Access`,
      "offline_access",
    ],
    // oid is the same for the user in every app; sub differs per app.
    subjectClaim: "oid",
    claims: ["roles", "tid", "name", "preferred_username"],
    require: { tid: entra.tenant },
  };
}
