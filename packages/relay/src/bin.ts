#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  parseRule,
  tokenHash,
  type Claims,
  type TokenEntry,
} from "./access.js";
import { RELAY_ENV, RelayConfigError, relayConfig } from "./config.js";
import { IncompatibleDatabaseError, backUpDatabase } from "./mailbox-store.js";
import { BLETHER_VERSION } from "@blether/protocol";
import { startRelay } from "./relay.js";

const USAGE = `Usage: blether-relay [command]

Commands:
  serve [--debug-audience]
                   Run the relay (the default). --debug-audience asks bridges whether each
                   message went to one agent, a role, or everyone, to count role messages
                   and broadcasts (the same as BLETHER_RELAY_DEBUG_AUDIENCE=1)
  backup <file>    Write a consistent copy of the database to <file>; safe while the relay runs
  token <subject> [claim=value ...]
                   Issue a sign-in token for a relay with BLETHER_RELAY_ACCESS=token: prints
                   the token, for the developer, and the entry to add to BLETHER_RELAY_TOKENS_FILE

Environment:
${Object.entries(RELAY_ENV)
  .map(([name, about]) => `  ${name.padEnd(28)}${about}`)
  .join("\n")}`;

const argv = process.argv.slice(2);
const debugAudience = argv.includes("--debug-audience");
const [command = "serve", ...args] = argv.filter(
  (a) => a !== "--debug-audience",
);

try {
  switch (command) {
    case "serve":
      await serve();
      break;
    case "backup": {
      const target = args[0];
      if (!target) throw new RelayConfigError(USAGE);
      const { databasePath } = relayConfig(process.env);
      backUpDatabase(databasePath, target);
      console.error(`Backed up ${databasePath} to ${target}.`);
      break;
    }
    case "token":
      issueToken(args);
      break;
    case "help":
    case "--help":
    case "-h":
      console.error(USAGE);
      break;
    default:
      throw new RelayConfigError(`Unknown command: ${command}\n\n${USAGE}`);
  }
} catch (error) {
  if (
    error instanceof RelayConfigError ||
    error instanceof IncompatibleDatabaseError
  ) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

/** Prints a new token and the tokens-file entry that admits it. */
function issueToken(args: string[]) {
  const [subject, ...pairs] = args;
  if (!subject) throw new RelayConfigError(USAGE);
  const claims: Claims = {};
  for (const pair of pairs) {
    const rule = parseRule(pair);
    if (!Array.isArray(rule) || rule.length !== 1) {
      throw new RelayConfigError(`Claims are claim=value, not "${pair}".`);
    }
    const [{ claim, value }] = rule as [{ claim: string; value: string }];
    const held = claims[claim];
    claims[claim] =
      held === undefined
        ? value
        : [...(Array.isArray(held) ? held : [held]), value];
  }
  const token = randomBytes(32).toString("base64url");
  const entry: TokenEntry = {
    subject,
    sha256: tokenHash(token),
    ...(pairs.length > 0 ? { claims } : {}),
  };
  console.log(
    `Token for ${subject}. Give it to them privately: the relay keeps only its hash.\n\n` +
      `  ${token}\n\n` +
      "Add this entry to the list in BLETHER_RELAY_TOKENS_FILE, then restart the relay:\n\n" +
      `  ${JSON.stringify(entry)}`,
  );
}

async function serve() {
  const config = relayConfig(process.env);
  if (debugAudience) config.debugAudience = true;
  const relay = await startRelay({
    ...config,
    log: (line) => console.error(line),
  });
  console.error(
    `blether relay ${BLETHER_VERSION} listening on ${relay.url}, mailboxes in ${config.databasePath}\n` +
      "Messages are end-to-end encrypted: this relay sees who messaged whom, and when, never what they said." +
      (config.tls
        ? ""
        : "\nServing plain ws://: put a TLS proxy in front, or set BLETHER_RELAY_TLS_CERT and BLETHER_RELAY_TLS_KEY, before exposing it.") +
      (config.debugAudience
        ? "\nDebug mode: asking bridges whether each message went to one agent, a role, or everyone, for the statistics."
        : ""),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void relay.close().then(() => process.exit(0)));
  }
}
