import { AgentName } from "@blether/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  FileKeyStore,
  ReadMessages,
  SeenLogs,
  TeamDirectory,
  defaultBletherHome,
  type Credentials,
  type TeamRecord,
} from "./keystore.js";
import { EscalationStore } from "./escalations.js";
import { PolicyStore } from "./policy.js";
import { SentLog } from "./sent-log.js";
import { InboxFile, inboxPath } from "./inbox-file.js";
import { SessionFileError, findSessionFile } from "./session-file.js";
import { RelayConnection, RelayError } from "./relay-connection.js";
import { createBridgeServer, createSetupProblemServer } from "./server.js";

/** Something that stops the bridge working, explained for the developer. */
class SetupProblem extends Error {
  constructor(
    message: string,
    /** Set when another session holds the agent: takes it over, installing the bridge on `server`. */
    readonly takeOver?: (server: McpServer) => Promise<RelayConnection>,
  ) {
    super(message);
  }
}

/** What to do about each way the relay can refuse a session. */
const REFUSAL_FIXES: Partial<
  Record<string, (agent: string, team: string) => string>
> = {
  "agent-in-use": (agent) =>
    `Only one session can act as ${agent} at a time. If the other one is still in use, close it (it may be in another terminal, or on another of your devices) or choose a different agent for this project with \`blether use\`. If this session should be ${agent} instead, use take_over_agent.`,
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
 * Starts the bridge for the session described by `env`: BLETHER_TEAM and
 * BLETHER_AGENT, or else the project's `.blether/session.json` (looked for
 * from BLETHER_PROJECT_DIR, or the working directory), and BLETHER_HOME.
 * If anything stops it working (no
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
    const { takeOver } = error;
    let tookOver: RelayConnection | undefined;
    const server = createSetupProblemServer(error.message, {
      ...(takeOver
        ? {
            takeOver: async (problemServer: McpServer) => {
              tookOver = await takeOver(problemServer);
              log(`blether bridge took over ${tookOver.agent}`);
              return (
                `This session is now ${tookOver.agent}; the other session was disconnected. ` +
                "Blether's tools are available now: start by reading your mailbox."
              );
            },
          }
        : {}),
    });
    return {
      server,
      problem: error.message,
      close: async () => {
        await server.close();
        await tookOver?.close();
      },
    };
  }
}

export interface StartedBridge {
  server: McpServer;
  /** Why the bridge couldn't start, if it couldn't. */
  problem?: string;
  close(): Promise<void>;
}

async function connect(env: NodeJS.ProcessEnv, log: (line: string) => void) {
  const home = env.BLETHER_HOME ?? defaultBletherHome();
  let session;
  try {
    session = findSessionFile(env.BLETHER_PROJECT_DIR ?? process.cwd(), home);
  } catch (error) {
    if (!(error instanceof SessionFileError)) throw error;
    throw new SetupProblem(error.message);
  }
  const agentName = env.BLETHER_AGENT ?? session?.contents.agent;
  if (agentName === undefined) {
    throw new SetupProblem(
      "No agent is chosen for this project. Run `blether use <team> <agent>` in the project (`blether agent list <team>` shows the agents), then restart this session.",
    );
  }
  const agent = AgentName.safeParse(agentName);
  if (!agent.success) {
    throw new SetupProblem(
      `BLETHER_AGENT is set to "${agentName}", which isn't an agent name (lowercase letters, digits and hyphens). Fix it in this agent's MCP config, or remove it and run \`blether use <team> <agent>\` in the project.`,
    );
  }
  if (session) log(`blether bridge using ${session.path}`);
  const store = new FileKeyStore(home);
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
  const teamName = env.BLETHER_TEAM ?? session?.contents.team;
  if (!teamName) {
    throw new SetupProblem(
      "No team is chosen for this project. Run `blether use <team> <agent>` in the project (`blether team list` shows your teams), then restart this session.",
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

  const found = { store, credentials, team, agent: agent.data, log };
  try {
    return await open(found, false);
  } catch (error) {
    if (!(error instanceof RelayError)) {
      throw new SetupProblem(
        `Couldn't connect to the relay at ${team.relayUrl}: ${(error as Error).message}. Is it running? Start it, then restart this session.`,
      );
    }
    const fix = REFUSAL_FIXES[error.code]?.(agent.data, team.name);
    throw new SetupProblem(
      `The relay refused this session (${error.code}): ${error.message}${fix ? ` ${fix}` : ""}`,
      error.code === "agent-in-use"
        ? async (server) => (await open(found, true, server)).connection
        : undefined,
    );
  }
}

/**
 * Connects to the relay as the agent and creates the bridge server, or
 * installs its tools on `server`. With `takeover`, any other session acting
 * as the agent is disconnected.
 */
async function open(
  {
    store,
    credentials,
    team,
    agent,
    log,
  }: {
    store: FileKeyStore;
    credentials: Credentials;
    team: TeamRecord;
    agent: string;
    log: (line: string) => void;
  },
  takeover: boolean,
  server?: McpServer,
) {
  const relay = await RelayConnection.connect(team.relayUrl, credentials, {
    scope: { team: team.id, agent },
    witness: new SeenLogs(store.home),
    readMessages: new ReadMessages(store.home, team.id, agent),
    takeover,
    log,
  });
  // Another of the developer's devices may have added a device since.
  if (relay.identity && relay.identity.length > credentials.identity.length) {
    store.saveIdentity(relay.identity);
  }
  keepInboxFile(relay, new InboxFile(inboxPath(store.home, team.id, agent)));
  const bridge = createBridgeServer(relay, {
    policy: new PolicyStore(store.home).load(),
    escalations: new EscalationStore(store.home, team.id, agent),
    sentLog: new SentLog(store.home, team.id, agent),
    ...(server ? { server } : {}),
  });
  return { server: bridge, connection: relay };
}

/**
 * Keeps the agent's inbox state file up to date, for hosts without channels
 * (`blether watch` and the Claude Code plugin's hooks read it). It's a
 * convenience: a failure to write it never affects messaging.
 */
function keepInboxFile(relay: RelayConnection, inbox: InboxFile) {
  const attempt = (write: () => void) => {
    try {
      write();
    } catch {
      // The next change tries again.
    }
  };
  relay.onArrival((item) =>
    attempt(() =>
      inbox.arrived(
        item.kind === "lost" ? undefined : item.from,
        relay.unreadCount,
        relay.unreadFrom(),
      ),
    ),
  );
  relay.onRead(() =>
    attempt(() => inbox.write(relay.unreadCount, relay.unreadFrom())),
  );
  void relay
    .settled()
    .then(() =>
      attempt(() => inbox.write(relay.unreadCount, relay.unreadFrom())),
    );
}
