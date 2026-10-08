import { AgentName } from "@blether/protocol";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  FileKeyStore,
  ReadMessages,
  SeenLogs,
  SignIns,
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
import {
  INSTRUCTIONS,
  createBridgeServer,
  createDormantServer,
  createSetupProblemServer,
  removableTools,
} from "./server.js";

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
    `${agent} is another developer's agent. Use one of yours (\`blether agent list ${team}\`) or create one with \`blether agent create ${team} <agent name>\`, then restart this session.`,
  "not-a-member": () =>
    "Ask a teammate for an invite and run `blether join <invite>`, then restart this session.",
  "unknown-team": (_agent, team) =>
    `The relay doesn't know ${team}; it may have been reset. Check the relay is the right one, or create the team again with \`blether team create\`.`,
  "authentication-failed": () =>
    "This device's identity didn't verify. Check `blether whoami`; if it's damaged, set this device up again.",
  "sign-in-required": (_agent, team) =>
    `Ask the developer to run \`blether sign-in ${team}\` in their own terminal (it won't run in yours), then connect again.`,
  "sign-in-refused": (_agent, team) =>
    `Ask the developer to run \`blether sign-in ${team}\` in their own terminal (it won't run in yours), then connect again.`,
  "not-allowed": () =>
    "The relay's rules don't let the developer's sign-in do this. Ask them to check with whoever runs the relay.",
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
 *
 * With BLETHER_CONNECT=manual (the Claude Code plugin sets it), the bridge
 * doesn't connect until the agent calls its connect tool: see startDormant.
 *
 * A session that loses the relay reconnects by itself (see `timings`). One
 * that can't stops its watch and, when connected manually, offers connect
 * again.
 */
export async function startBridge(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.error(line),
  timings: BridgeTimings = {},
): Promise<StartedBridge> {
  if (env.BLETHER_CONNECT === "manual") return startDormant(env, log, timings);
  try {
    const { server, connection } = await connect(env, log, timings);
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

/**
 * A bridge that stays out of the session until the developer connects it
 * (`/blether:connect`, ADR 0008): its only tool is connect. Connecting takes
 * the agent over from any other session (the developer asked for this one),
 * and gives the agent the command for a watch tied to this connection, so
 * only connected sessions hear about mail.
 */
function startDormant(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  timings: BridgeTimings,
): StartedBridge {
  let connected: Opened | undefined;
  const disconnect = async () => {
    const opened = connected;
    connected = undefined;
    if (!opened) return;
    opened.removeTools();
    try {
      opened.inbox.close();
    } catch {
      // The watch then stops when the session ends.
    }
    await opened.connection.close();
  };
  const server = createDormantServer(async (server, ended) => {
    let opened: Opened;
    try {
      opened = await connect(env, log, timings, server);
    } catch (error) {
      if (error instanceof SetupProblem) {
        throw new Error(error.message, { cause: error });
      }
      throw error;
    }
    connected = opened;
    log(`blether bridge connected as ${opened.agent}`);
    // Lost for good, taken over or refused: back to waiting for connect.
    // (The inbox file has already been dealt with: see keepInboxFile.)
    opened.connection.onEnd(() => {
      if (connected !== opened) return;
      connected = undefined;
      opened.removeTools();
      log("blether bridge disconnected");
      ended();
    });
    return {
      result: connectedGuidance(opened),
      disconnect: async () => {
        await disconnect();
        log("blether bridge disconnected");
        return "Disconnected from Blether. Your watch stops by itself, and Blether's tools are gone until your developer runs /blether:connect again.";
      },
    };
  });
  return {
    server,
    close: async () => {
      await server.close();
      await disconnect();
    },
  };
}

/** What the agent is told when it connects: how to use Blether, and what to do now. */
function connectedGuidance({
  agent,
  team,
  inbox,
  pendingEscalations,
}: Opened): string {
  const path = inbox.path.split("\\").join("/");
  const watch = `blether watch --inbox "${path}" --session ${inbox.session}`;
  return [
    `Connected to Blether: you are ${agent} in team ${team.name}.`,
    INSTRUCTIONS,
    ...(pendingEscalations > 0
      ? [
          `${pendingEscalations} escalation(s) from earlier sessions are waiting for your developer: call list_escalations and raise them with your developer.`,
        ]
      : []),
    "",
    "Now:",
    "1. Call read_mailbox.",
    `2. Start a watch, so you hear about new mail between prompts: use the Monitor tool (load it with ToolSearch first if it's deferred) with the command: ${watch} — the description "Blether mail for ${agent}", and timeout_ms 1800000. Each line it prints means new mail: call read_mailbox. When the watch expires, start it again with --quiet-start added to the command. Restarting it is routine, so there's no need to mention it. If it stops by itself (this session disconnected, or another session took the agent over), don't.`,
  ].join("\n");
}

/** How a bridge paces its connection to the relay: see ConnectOptions. */
export interface BridgeTimings {
  reconnectDelaysMs?: readonly number[];
  heartbeatMs?: number;
}

export interface StartedBridge {
  server: McpServer;
  /** Why the bridge couldn't start, if it couldn't. */
  problem?: string;
  close(): Promise<void>;
}

/**
 * Finds the session's agent and connects it to the relay. With `into`, the
 * bridge's tools are installed on that server and any other session acting
 * as the agent is taken over; otherwise a new bridge server is created.
 */
async function connect(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  timings: BridgeTimings,
  into?: McpServer,
): Promise<Opened> {
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
      "No agent is chosen for this project. Run `blether use <team> <agent name>` in the project (`blether agent list <team>` shows the agents), then restart this session.",
    );
  }
  const agent = AgentName.safeParse(agentName);
  if (!agent.success) {
    throw new SetupProblem(
      `BLETHER_AGENT is set to "${agentName}", which isn't an agent name (lowercase letters, digits and hyphens). Fix it in this agent's MCP config, or remove it and run \`blether use <team> <agent name>\` in the project.`,
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
      "No team is chosen for this project. Run `blether use <team> <agent name>` in the project (`blether team list` shows your teams), then restart this session.",
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

  const found = { store, credentials, team, agent: agent.data, log, timings };
  try {
    return await open(found, into !== undefined, into);
  } catch (error) {
    if (!(error instanceof RelayError)) {
      throw new SetupProblem(
        `Couldn't connect to the relay at ${team.relayUrl}: ${(error as Error).message}. Is it running? Start it, then restart this session.`,
      );
    }
    if (error.code === "insecure-transport") {
      // Nothing was sent: the bridge stopped itself, not the relay.
      throw new SetupProblem(
        `${error.message} Tell the developer; this session can't connect until then.`,
      );
    }
    const fix = REFUSAL_FIXES[error.code]?.(agent.data, team.name);
    throw new SetupProblem(
      `The relay refused this session (${error.code}): ${error.message}${fix ? ` ${fix}` : ""}`,
      error.code === "agent-in-use" && !into
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
    timings,
  }: {
    store: FileKeyStore;
    credentials: Credentials;
    team: TeamRecord;
    agent: string;
    log: (line: string) => void;
    timings: BridgeTimings;
  },
  takeover: boolean,
  server?: McpServer,
): Promise<Opened> {
  const relay = await RelayConnection.connect(team.relayUrl, credentials, {
    scope: { team: team.id, agent },
    witness: new SeenLogs(store.home),
    readMessages: new ReadMessages(store.home, team.id, agent),
    takeover,
    log,
    ...timings,
    credential: new SignIns(store.home).credential(team.relayUrl),
  });
  // Another of the developer's devices may have added a device since.
  if (relay.identity && relay.identity.length > credentials.identity.length) {
    store.saveIdentity(relay.identity);
  }
  const inbox = new InboxFile(inboxPath(store.home, team.id, agent));
  keepInboxFile(relay, inbox);
  const escalations = new EscalationStore(store.home, team.id, agent);
  const options = {
    policy: new PolicyStore(store.home).load(),
    escalations,
    sentLog: new SentLog(store.home, team.id, agent),
  };
  let bridge: McpServer;
  let removeTools = () => {};
  if (server) {
    bridge = server;
    removeTools = removableTools(server, () =>
      createBridgeServer(relay, { ...options, server }),
    );
  } else {
    bridge = createBridgeServer(relay, options);
  }
  return {
    server: bridge,
    connection: relay,
    agent,
    team,
    inbox,
    removeTools,
    pendingEscalations: escalations.pending().length,
  };
}

/** A session connected to the relay as its agent. */
interface Opened {
  server: McpServer;
  connection: RelayConnection;
  agent: string;
  team: TeamRecord;
  /** The agent's inbox state file, which this connection keeps up to date. */
  inbox: InboxFile;
  /** Removes the bridge's tools, when they were installed on an existing server. */
  removeTools: () => void;
  /** Escalations from earlier sessions still waiting for the developer. */
  pendingEscalations: number;
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
  // Stops the watch. When taken over, the file is the new session's now.
  relay.onEnd((end) => {
    if (end !== "taken-over") {
      attempt(() => inbox.close({ lost: end === "lost" }));
    }
  });
  void relay
    .settled()
    .then(() =>
      attempt(() => inbox.write(relay.unreadCount, relay.unreadFrom())),
    );
}
