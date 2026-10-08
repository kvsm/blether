#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startBridge } from "./startup.js";

// stdout carries MCP, so all diagnostics go to stderr. If the bridge can't
// start, it still serves MCP so the agent can explain the problem.
const { server } = await startBridge();
await server.connect(new StdioServerTransport());
