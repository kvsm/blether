import { join } from "node:path";
import {
  EscalationStore,
  FileKeyStore,
  RelayConnection,
  SentLog,
  TeamDirectory,
  createBridgeServer,
  runCli,
  type ApprovalPolicy,
  type SecretScanner,
} from "@blether/bridge";
import { verifyIdentityLog } from "@blether/protocol";
import {
  Client,
  type ClientOptions,
} from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * One developer's device for end-to-end tests: its own BLETHER_HOME under
 * `root`, driven through the real `blether` CLI.
 */
export function device(root: string, name: string) {
  const store = new FileKeyStore(join(root, name));
  const teams = new TeamDirectory(store.home);
  let answer = true;
  let clock: Date | undefined;

  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      store,
      teams,
      io: {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        confirm: async () => answer,
      },
      ...(clock ? { now: () => clock! } : {}),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  /** Runs a command that must succeed and returns the part of its output matching `pattern`. */
  const printed = async (pattern: RegExp, ...argv: string[]) => {
    const result = await run(...argv);
    const match = pattern.exec(result.out)?.[0];
    if (result.code !== 0 || !match) {
      throw new Error(`${argv.join(" ")} failed: ${result.err || result.out}`);
    }
    return match;
  };

  return {
    store,
    teams,
    run,
    /** What the developer answers when asked to confirm something. */
    answer(value: boolean) {
      answer = value;
    },
    /** Pretends it's `date` for the CLI's sense of time. */
    setClock(date: Date) {
      clock = date;
    },
    /** Runs `blether invite` and returns the invite it printed. */
    invite: (team: string, ...flags: string[]) =>
      printed(/blether(\+ws)?:\/\/\S+/, "invite", team, ...flags),
    request: () => printed(/blether-device:\S+/, "device", "request"),
    add: (request: string, ...flags: string[]) =>
      printed(/blether-grant:\S+/, "device", "add", request, ...flags),
    devices: () => verifyIdentityLog(store.load()!.identity).devices.length,

    /** An MCP session, through a bridge, acting as one of this developer's agents in `team`. */
    async session(
      team: string,
      agent: string,
      {
        policy = { outgoing: "free", incoming: "free" },
        client: clientOptions,
        now,
        scanSecrets,
      }: {
        policy?: ApprovalPolicy;
        client?: ClientOptions;
        /** The bridge's clock, for escalation reminders. */
        now?: () => Date;
        /** Replaces the bridge's secret scanner. */
        scanSecrets?: SecretScanner;
      } = {},
    ) {
      const record = teams.get(team)!;
      const connection = await RelayConnection.connect(
        record.relayUrl,
        store.load()!,
        { scope: { team: record.id, agent } },
      );
      const client = new Client(
        { name: agent, version: "0.0.0" },
        clientOptions,
      );
      const [a, b] = InMemoryTransport.createLinkedPair();
      await createBridgeServer(connection, {
        policy,
        escalations: new EscalationStore(store.home, record.id, agent),
        sentLog: new SentLog(store.home, record.id, agent),
        ...(now ? { now } : {}),
        ...(scanSecrets ? { scanSecrets } : {}),
      }).connect(b);
      await client.connect(a);
      const call = async (tool: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name: tool, arguments: args });
        return (result.content as { text: string }[])[0]?.text ?? "";
      };
      return {
        client,
        call,
        close: async () => {
          await client.close();
          await connection.close();
        },
      };
    },
  };
}

export type Device = ReturnType<typeof device>;
