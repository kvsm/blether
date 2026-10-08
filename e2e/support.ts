import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import {
  EscalationStore,
  FileKeyStore,
  RelayConnection,
  SentLog,
  SignIns,
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
  let secret: string | undefined;
  let browser: ((url: string) => Promise<void>) | undefined;
  const asked: string[] = [];
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
        confirm: async (question) => {
          asked.push(question);
          return answer;
        },
        secret: async (question) => {
          asked.push(question);
          return secret;
        },
        ...(browser ? { browser } : {}),
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
    /** The questions the developer has been asked to confirm, oldest first. */
    asked,
    /** What the developer answers when asked to confirm something. */
    answer(value: boolean) {
      answer = value;
    },
    /** What the developer types when asked for a secret, such as a sign-in token. */
    typeSecret(value: string | undefined) {
      secret = value;
    },
    /** What happens when the CLI opens the developer's browser to sign in. */
    useBrowser(open: (url: string) => Promise<void>) {
      browser = open;
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
        log,
      }: {
        policy?: ApprovalPolicy;
        client?: ClientOptions;
        /** The bridge's clock, for escalation reminders. */
        now?: () => Date;
        /** Replaces the bridge's secret scanner. */
        scanSecrets?: SecretScanner;
        /** Where the bridge tells its developer things about the connection. */
        log?: (line: string) => void;
      } = {},
    ) {
      const record = teams.get(team)!;
      const connection = await RelayConnection.connect(
        record.relayUrl,
        store.load()!,
        {
          scope: { team: record.id, agent },
          credential: new SignIns(store.home).credential(record.relayUrl),
          ...(log ? { log } : {}),
        },
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

/**
 * A TCP proxy in front of a relay, so a test can break the connection the
 * way a network does: drop every connection, refuse new ones, or go silent
 * without closing anything.
 */
export async function relayProxy(relayUrl: string) {
  const target = new URL(relayUrl);
  const open = new Set<Socket>();
  let refusing = false;
  let silent = false;
  let dropAfter: string | undefined;
  const server = createServer((client) => {
    if (refusing) {
      client.destroy();
      return;
    }
    const upstream = connect(Number(target.port), target.hostname);
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
      socket.on("error", () => {});
    }
    // While silent, data is swallowed rather than passed on.
    client.on("data", (data) => {
      if (!silent) upstream.write(data);
    });
    upstream.on("data", (data) => {
      if (silent) return;
      client.write(data);
      if (dropAfter !== undefined && data.includes(dropAfter)) {
        dropAfter = undefined;
        client.end(() => client.destroy());
        upstream.destroy();
      }
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    /** Breaks every connection through the proxy. */
    drop() {
      for (const socket of open) socket.destroy();
    },
    /** Whether new connections are refused. */
    refuse(on = true) {
      refusing = on;
    },
    /**
     * Once the relay next sends something containing `text`, passes it on
     * and then breaks that connection, before anything else gets through.
     */
    dropAfter(text: string) {
      dropAfter = text;
    },
    /** Whether connections stay open but nothing gets through (a sleeping laptop). */
    silence(on = true) {
      silent = on;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
export type RelayProxy = Awaited<ReturnType<typeof relayProxy>>;
