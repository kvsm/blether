#!/usr/bin/env node
import { AgentName } from "@blether/protocol";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileKeyStore, TeamDirectory } from "./keystore.js";
import { RelayConnection, RelayError } from "./relay-connection.js";
import { createBridgeServer } from "./server.js";

// stdout carries MCP, so all diagnostics go to stderr.
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const agent = AgentName.safeParse(process.env.BLETHER_AGENT);
if (!agent.success) {
  fail(
    "Set BLETHER_AGENT to this session's agent name (lowercase letters, digits and hyphens).",
  );
}
const store = new FileKeyStore();
const loaded = (() => {
  try {
    return store.load();
  } catch (error) {
    return fail((error as Error).message);
  }
})();
const credentials =
  loaded ??
  fail(
    `No Blether identity in ${store.home}. Run \`blether init --name "<your name>"\` first.`,
  );
const teamName = process.env.BLETHER_TEAM;
if (!teamName) {
  fail(
    "Set BLETHER_TEAM to the team this agent belongs to. Run `blether team list` to see your teams.",
  );
}
const team =
  new TeamDirectory(store.home).get(teamName!) ??
  fail(
    `You aren't in a team called ${teamName}. Run \`blether team list\` to see your teams.`,
  );

console.error(
  `blether bridge acting as ${agent.data} in team ${team.name} via ${team.relayUrl}\n` +
    "WARNING: messages aren't end-to-end encrypted yet; the relay can read them.",
);

const relay = await RelayConnection.connect(team.relayUrl, credentials, {
  team: team.id,
  agent: agent.data!,
}).catch((error: unknown) =>
  fail(
    error instanceof RelayError
      ? `The relay refused this session (${error.code}): ${error.message}`
      : `Couldn't connect to the relay at ${team.relayUrl}: ${(error as Error).message}`,
  ),
);
const server = createBridgeServer(relay);
await server.connect(new StdioServerTransport());
