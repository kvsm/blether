#!/usr/bin/env node
import { AgentName } from "@blether/protocol";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RelayConnection } from "./relay-connection.js";
import { createBridgeServer } from "./server.js";

const relayUrl = process.env.BLETHER_RELAY_URL ?? "ws://127.0.0.1:7357";
const agent = AgentName.safeParse(process.env.BLETHER_AGENT);
if (!agent.success) {
  console.error(
    "Set BLETHER_AGENT to this session's agent name (lowercase letters, digits and hyphens).",
  );
  process.exit(1);
}

// stdout carries MCP, so all diagnostics go to stderr.
console.error(
  `blether bridge acting as ${agent.data} via ${relayUrl}\n` +
    "WARNING: insecure dev mode, with no authentication or encryption.",
);

const relay = await RelayConnection.connect(relayUrl, agent.data);
const server = createBridgeServer(relay);
await server.connect(new StdioServerTransport());
