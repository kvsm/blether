import { AgentName } from "@blether/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  FileKeyStore,
  ReadMessages,
  SeenLogs,
  TeamDirectory,
  defaultBletherHome,
} from "./keystore.js";
import { EscalationStore } from "./escalations.js";
import { PolicyStore } from "./policy.js";
import { SentLog } from "./sent-log.js";
import { RelayConnection, RelayError } from "./relay-connection.js";
import { createBridgeServer, createSetupProblemServer } from "./server.js";

/** Something that stops the bridge working, explained for the developer. */
class SetupProblem extends Error {}

/** What to do about each way the relay can refuse a session. */
const REFUSAL_FIXES: Partial<
  Record<string, (agent: string, team: string) => string>
> = {
  "agent-in-use": (agent) =>
    `Only one session can act as ${agent} at a time. Close the other one (it may be in another terminal, or on another of your devices), or set a different BLETHER_AGENT for this session, then restart it.`,
  "agent-owned-by-another": (agent, team) =>
    `${agent} is another developer's agent. Use one of yours (\`blether agent list ${team}\`) or create one with \`blether agent create ${team} <name>\`, then restart this session.`,
  "not-a-member": () =>
    "Ask a teammate for an invite and run `blether join <invite>`, then restart this session.",
  "unknown-team": (_agent, team) =>
    `The relay doesn't know ${team}; it may have been reset. Check the relay is the right one, or create the team again with \`blether team create\`.`,
  "authentication-failed": () =>
    "This device's identity didn't verify. Check `blether whoami`; if it's damaged, set this device up again.",
  "identity-conflict": () =>
    "The relay holds a different history for your identity than this device does. Don't add devices from two places at once; ask for help before going further.",
};

/**
 * Starts the bridge for the session described by `env` (BLETHER_TEAM,
 * BLETHER_AGENT and BLETHER_HOME). If anything stops it working (no
 * identity, an unknown team, a relay that refuses or can't be reached), it
 * still returns an MCP server: one whose only job is to explain the problem,
 * so the agent can tell the developer instead of the host just showing
 * "failed".
 */
export async function startBridge(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.error(line),
): Promise<StartedBridge> {
  try {
    const { server, connection } = await connect(env, log);
    return {
      server,
      close: async () => {
        await server.close();
        await connection.close();
      },
    };
  } catch (error) {
    if (!(error instanceof SetupProblem)) throw error;
    log(`blether bridge can't start: ${error.message}`);
    const server = createSetupProblemServer(error.message);
    return { server, problem: error.message, close: () => server.close() };
  }
}

export interface StartedBridge {
  server: McpServer;
  /** Why the bridge couldn't start, if it couldn't. */
  problem?: string;
  close(): Promise<void>;
}

async function connect(env: NodeJS.ProcessEnv, log: (line: string) => void) {
  const agent = AgentName.safeParse(env.BLETHER_AGENT);
  if (!agent.success) {
    throw new SetupProblem(
      "BLETHER_AGENT isn't set to an agent name (lowercase letters, digits and hyphens). Set it in this agent's MCP config.",
    );
  }
  const store = new FileKeyStore(env.BLETHER_HOME ?? defaultBletherHome());
  let credentials;
  try {
    credentials = store.load();
  } catch (error) {
    throw new SetupProblem((error as Error).message);
  }
  if (!credentials) {
    throw new SetupProblem(
      `There's no Blether identity in ${store.home}. Run \`blether init --name "<your name>"\`, or \`blether device request\` to add this device to an existing identity.`,
    );
  }
  const teamName = env.BLETHER_TEAM;
  if (!teamName) {
    throw new SetupProblem(
      "BLETHER_TEAM isn't set. Set it in this agent's MCP config to one of the teams `blether team list` shows.",
    );
  }
  let team;
  try {
    team = new TeamDirectory(store.home).get(teamName);
  } catch {
    team = undefined;
  }
  if (!team) {
    throw new SetupProblem(
      `You aren't in a team called ${teamName}. Run \`blether team list\` to see your teams.`,
    );
  }

  log(
    `blether bridge acting as ${agent.data} in team ${team.name} via ${team.relayUrl}\n` +
      "Messages are end-to-end encrypted; the relay sees only who messaged whom, and when.",
  );

  let relay: RelayConnection;
  try {
    relay = await RelayConnection.connect(team.relayUrl, credentials, {
      scope: { team: team.id, agent: agent.data },
      witness: new SeenLogs(store.home),
      readMessages: new ReadMessages(store.home, team.id, agent.data),
    });
  } catch (error) {
    if (!(error instanceof RelayError)) {
      throw new SetupProblem(
        `Couldn't connect to the relay at ${team.relayUrl}: ${(error as Error).message}. Is it running? Start it, then restart this session.`,
      );
    }
    const fix = REFUSAL_FIXES[error.code]?.(agent.data, team.name);
    throw new SetupProblem(
      `The relay refused this session (${error.code}): ${error.message}${fix ? ` ${fix}` : ""}`,
    );
  }
  // Another of the developer's devices may have added a device since.
  if (relay.identity && relay.identity.length > credentials.identity.length) {
    store.saveIdentity(relay.identity);
  }
  const server = createBridgeServer(relay, {
    policy: new PolicyStore(store.home).load(),
    escalations: new EscalationStore(store.home, team.id, agent.data),
    sentLog: new SentLog(store.home, team.id, agent.data),
  });
  return { server, connection: relay };
}
