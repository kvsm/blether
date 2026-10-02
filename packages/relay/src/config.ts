import { readFileSync } from "node:fs";
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
  BLETHER_RELAY_HEARTBEAT_MS:
    "How often to check connections are alive (default 15000)",
} as const;

/** The relay's settings from its environment. */
export function relayConfig(
  env: NodeJS.ProcessEnv,
): RelayOptions & { databasePath: string } {
  const port = whole(env, "BLETHER_RELAY_PORT", 7357);
  const heartbeatMs = whole(env, "BLETHER_RELAY_HEARTBEAT_MS", 15_000);
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
    ...(certFile && keyFile
      ? { tls: { cert: read(certFile), key: read(keyFile) } }
      : {}),
  };
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

function read(file: string) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new RelayConfigError(
      `Couldn't read ${file}: ${(error as Error).message}`,
    );
  }
}
