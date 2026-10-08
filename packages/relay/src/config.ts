import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  TokenEntry,
  openAccess,
  parseRule,
  tokenAccess,
  type AccessProvider,
  type Rules,
} from "./access.js";
import { entraSettings, oidcAccess } from "./oidc.js";
import type { RelayOptions } from "./relay.js";

/** A setting the operator got wrong, explained without a stack trace. */
export class RelayConfigError extends Error {}

/** Every environment variable the relay reads, for the help text and docs. */
export const RELAY_ENV = {
  BLETHER_RELAY_HOST:
    "Address to listen on (default 127.0.0.1; 0.0.0.0 for every interface)",
  BLETHER_RELAY_PORT: "Port to listen on (default 7357)",
  BLETHER_RELAY_DB: "Mailbox database file (default ./blether-relay.db)",
  BLETHER_RELAY_TLS_CERT: "Certificate file (PEM), to serve wss:// directly",
  BLETHER_RELAY_TLS_KEY: "Private key file (PEM) for the certificate",
  BLETHER_RELAY_STATS_INTERVAL_MS:
    "How often to print message statistics when there are new messages (default 300000; 0 for only on shutdown)",
  BLETHER_RELAY_DEBUG_AUDIENCE:
    "1 to ask bridges whether each message went to one agent, a role, or everyone, and count role messages and broadcasts",
  BLETHER_RELAY_HEARTBEAT_MS:
    "How often to check connections are alive (default 15000)",
  BLETHER_RELAY_ACCESS:
    "Who may connect: open (anyone, the default), token (a token listed in BLETHER_RELAY_TOKENS_FILE), oidc (an OpenID Connect access token) or entra (Microsoft Entra ID)",
  BLETHER_RELAY_TOKENS_FILE:
    "For BLETHER_RELAY_ACCESS=token: a JSON list of the entries `blether-relay token` prints; read at start-up",
  BLETHER_RELAY_OIDC_ISSUER:
    "For oidc: the issuer, exactly as access tokens' iss claim gives it",
  BLETHER_RELAY_OIDC_AUDIENCE:
    "For oidc: the audience (aud) access tokens must be for",
  BLETHER_RELAY_OIDC_CLIENT_ID:
    "For oidc: the public client id the CLI signs in as",
  BLETHER_RELAY_OIDC_SCOPES:
    "For oidc: the scopes the CLI asks for, space-separated (default openid offline_access)",
  BLETHER_RELAY_OIDC_SUBJECT_CLAIM:
    "For oidc: the claim naming who signed in (default sub)",
  BLETHER_RELAY_OIDC_CLAIMS:
    "For oidc: comma-separated claims the ALLOW rules can check (default roles)",
  BLETHER_RELAY_ENTRA_TENANT: "For entra: the directory (tenant) id",
  BLETHER_RELAY_ENTRA_API_CLIENT_ID:
    "For entra: the relay API app registration's application (client) id",
  BLETHER_RELAY_ENTRA_CLI_CLIENT_ID:
    "For entra: the CLI app registration's application (client) id",
  BLETHER_RELAY_ENTRA_SCOPE:
    "For entra: the scope the CLI asks for (default api://<API client id>/Relay.Access)",
  BLETHER_RELAY_ALLOW_CONNECT:
    "Who may connect once signed in: signed-in (the default), or comma-separated claim=value pairs, any of which allows it",
  BLETHER_RELAY_ALLOW_TEAM_CREATE:
    "Who may create teams once signed in: signed-in (the default), or comma-separated claim=value pairs",
} as const;

/** The relay's settings from its environment. */
export function relayConfig(
  env: NodeJS.ProcessEnv,
): RelayOptions & { databasePath: string } {
  const port = whole(env, "BLETHER_RELAY_PORT", 7357);
  const heartbeatMs = whole(env, "BLETHER_RELAY_HEARTBEAT_MS", 15_000);
  const statsIntervalMs = whole(
    env,
    "BLETHER_RELAY_STATS_INTERVAL_MS",
    300_000,
  );
  const debugAudience = flag(env, "BLETHER_RELAY_DEBUG_AUDIENCE");
  const certFile = env.BLETHER_RELAY_TLS_CERT;
  const keyFile = env.BLETHER_RELAY_TLS_KEY;
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new RelayConfigError(
      "Set both BLETHER_RELAY_TLS_CERT and BLETHER_RELAY_TLS_KEY to serve wss://, or neither.",
    );
  }
  return {
    port,
    host: env.BLETHER_RELAY_HOST ?? "127.0.0.1",
    databasePath: env.BLETHER_RELAY_DB ?? "blether-relay.db",
    heartbeatMs,
    statsIntervalMs,
    debugAudience,
    access: { provider: accessProvider(env), rules: accessRules(env) },
    ...(certFile && keyFile
      ? { tls: { cert: read(certFile), key: read(keyFile) } }
      : {}),
  };
}

function accessProvider(env: NodeJS.ProcessEnv): AccessProvider {
  const kind = env.BLETHER_RELAY_ACCESS || "open";
  switch (kind) {
    case "open":
      return openAccess();
    case "token":
      return tokens(env);
    case "oidc":
      return oidcAccess({
        issuer: url(env, "BLETHER_RELAY_OIDC_ISSUER"),
        audience: required(env, "BLETHER_RELAY_OIDC_AUDIENCE", kind),
        clientId: required(env, "BLETHER_RELAY_OIDC_CLIENT_ID", kind),
        scopes: (env.BLETHER_RELAY_OIDC_SCOPES || "openid offline_access")
          .split(/\s+/)
          .filter(Boolean),
        ...(env.BLETHER_RELAY_OIDC_SUBJECT_CLAIM
          ? { subjectClaim: env.BLETHER_RELAY_OIDC_SUBJECT_CLAIM }
          : {}),
        ...(env.BLETHER_RELAY_OIDC_CLAIMS
          ? { claims: list(env.BLETHER_RELAY_OIDC_CLAIMS) }
          : {}),
      });
    case "entra":
      return oidcAccess(
        entraSettings({
          tenant: required(env, "BLETHER_RELAY_ENTRA_TENANT", kind),
          apiClientId: required(env, "BLETHER_RELAY_ENTRA_API_CLIENT_ID", kind),
          cliClientId: required(env, "BLETHER_RELAY_ENTRA_CLI_CLIENT_ID", kind),
          ...(env.BLETHER_RELAY_ENTRA_SCOPE
            ? { scope: env.BLETHER_RELAY_ENTRA_SCOPE }
            : {}),
        }),
      );
    default:
      throw new RelayConfigError(
        `BLETHER_RELAY_ACCESS must be open, token, oidc or entra, not "${kind}".`,
      );
  }
}

function required(env: NodeJS.ProcessEnv, name: string, kind: string) {
  const value = env[name];
  if (!value) {
    throw new RelayConfigError(`BLETHER_RELAY_ACCESS=${kind} needs ${name}.`);
  }
  return value;
}

function url(env: NodeJS.ProcessEnv, name: string) {
  const value = required(env, name, "oidc");
  if (!URL.canParse(value)) {
    throw new RelayConfigError(`${name} must be a URL, not "${value}".`);
  }
  return value;
}

const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function tokens(env: NodeJS.ProcessEnv): AccessProvider {
  const file = env.BLETHER_RELAY_TOKENS_FILE;
  if (!file) {
    throw new RelayConfigError(
      "BLETHER_RELAY_ACCESS=token needs BLETHER_RELAY_TOKENS_FILE, a list of the entries `blether-relay token` prints.",
    );
  }
  const text = read(file);
  try {
    return tokenAccess(z.array(TokenEntry).parse(JSON.parse(text)));
  } catch (error) {
    throw new RelayConfigError(
      `${file} isn't a JSON list of the entries \`blether-relay token\` prints: ${(error as Error).message}`,
    );
  }
}

function accessRules(env: NodeJS.ProcessEnv): Rules {
  return {
    connect: rule(env, "BLETHER_RELAY_ALLOW_CONNECT"),
    "team.create": rule(env, "BLETHER_RELAY_ALLOW_TEAM_CREATE"),
  };
}

function rule(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name];
  if (raw === undefined || raw === "") return "signed-in";
  const parsed = parseRule(raw);
  if (!parsed) {
    throw new RelayConfigError(
      `${name} must be signed-in, or comma-separated claim=value pairs, not "${raw}".`,
    );
  }
  return parsed;
}

function whole(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new RelayConfigError(`${name} must be a whole number, not "${raw}".`);
  }
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new RelayConfigError(`${name} must be 1 or 0, not "${raw}".`);
}

function read(file: string) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new RelayConfigError(
      `Couldn't read ${file}: ${(error as Error).message}`,
    );
  }
}
