#!/usr/bin/env node
import { AgentName } from "@blether/protocol";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileKeyStore } from "./keystore.js";
import { RelayConnection, RelayError } from "./relay-connection.js";
import { createBridgeServer } from "./server.js";

// stdout carries MCP, so all diagnostics go to stderr.
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const relayUrl = process.env.BLETHER_RELAY_URL ?? "ws://127.0.0.1:7357";
const agent = AgentName.safeParse(process.env.BLETHER_AGENT);
if (!agent.success) {
  fail(
    "Set BLETHER_AGENT to this session's agent name (lowercase letters, digits and hyphens).",
  );
}
const store = new FileKeyStore();
const credentials =
  store.load() ??
  fail(
    `No Blether identity in ${store.home}. Run \`blether init --name "<your name>"\` first.`,
  );

console.error(
  `blether bridge acting as ${agent.data} via ${relayUrl}\n` +
    "WARNING: no teams or encryption yet. Any developer known to the relay can message this agent.",
);

const relay = await RelayConnection.connect(
  relayUrl,
  agent.data!,
  credentials,
).catch((error: unknown) =>
  fail(
    error instanceof RelayError
      ? `The relay refused this session (${error.code}): ${error.message}`
      : `Couldn't connect to the relay at ${relayUrl}: ${(error as Error).message}`,
  ),
);
const server = createBridgeServer(relay);
await server.connect(new StdioServerTransport());
