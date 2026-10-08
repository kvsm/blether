import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readInboxState,
  startBridge,
  type BridgeTimings,
  type StartedBridge,
} from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, relayProxy, type Device, type RelayProxy } from "./support.js";

describe("a connected session losing the relay", () => {
  let relay: Relay;
  let proxy: RelayProxy;
  let root: string;
  let kev: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    // A quick heartbeat, so the relay notices dead connections and frees their
    // agents; not so quick that a busy test run misses pings.
    relay = await startRelay({ heartbeatMs: 200 });
    proxy = await relayProxy(relay.url);
    root = mkdtempSync(join(tmpdir(), "blether-reconnect-"));
    kev = device(root, "kev");
    await kev.run("init", "--name", "Kev");
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await kev.run("agent", "create", "backend", "web");
    await kev.run("agent", "create", "backend", "api");
    await kev.run("policy", "set", "--outgoing", "free");
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await proxy.close();
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  const startSession = async (
    agent: string,
    connect: "manual" | "auto",
    timings: BridgeTimings = {},
  ) => {
    const started: StartedBridge = await startBridge(
      {
        BLETHER_HOME: kev.store.home,
        BLETHER_TEAM: "backend",
        BLETHER_AGENT: agent,
        BLETHER_CONNECT: connect,
      },
      () => {},
      timings,
    );
    const client = new Client({ name: "host", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await started.server.connect(b);
    await client.connect(a);
    cleanups.push(async () => {
      await client.close();
      await started.close();
    });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return (result.content as { text: string }[])[0]?.text ?? "";
    };
    const tools = async () =>
      (await client.listTools()).tools.map((t) => t.name).sort();
    return { call, tools };
  };

  /**
   * api, connected straight to the relay, then web, connected through the
   * proxy so the test can break its connection.
   */
  const sessions = async (timings: BridgeTimings) => {
    const api = await startSession("api", "auto", {
      reconnectDelaysMs: Array<number>(20).fill(50),
    });
    const record = kev.teams.get("backend")!;
    kev.teams.save({ ...record, relayUrl: proxy.url });
    const web = await startSession("web", "manual", timings);
    const connected = await web.call("connect");
    const inbox = /--inbox "([^"]+)"/.exec(connected)![1]!;
    const session = /--session (\S+)/.exec(connected)![1]!;
    return { api, web, inbox, session };
  };

  it("reconnects by itself, keeping its tools and its watch, and gets mail sent meanwhile", async () => {
    const { api, web, inbox, session } = await sessions({
      reconnectDelaysMs: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20],
    });

    proxy.refuse();
    proxy.drop();
    await expect
      .poll(() => api.call("list_agents"), { timeout: 5000 })
      .toContain("web: Kev's agent, no roles, offline");
    await api.call("send_message", { to: "web", body: "Schema's changed." });
    proxy.refuse(false);

    await expect
      .poll(() => api.call("list_agents"), { timeout: 5000 })
      .toContain("web: Kev's agent, no roles, online");
    expect(await web.tools()).toContain("read_mailbox");
    await expect
      .poll(() => web.call("read_mailbox"), { timeout: 5000 })
      .toContain("Schema's changed.");
    expect(readInboxState(inbox)).toMatchObject({ session });
    expect(readInboxState(inbox)?.closed).toBeUndefined();
  });

  it("keeps a message it couldn't check because the connection dropped, and shows it once it can", async () => {
    const { api, web } = await sessions({
      reconnectDelaysMs: Array<number>(10).fill(20),
    });

    // The connection breaks just after the delivery, before web can fetch
    // the team log to check who signed it.
    proxy.dropAfter('"type":"deliver"');
    await api.call("send_message", { to: "web", body: "Schema's changed." });

    await expect
      .poll(() => web.call("read_mailbox"), { timeout: 5000 })
      .toContain("Schema's changed.");
    expect(await web.call("read_mailbox")).toBe("No unread messages.");
  });

  it("says it's reconnecting, rather than that the mailbox is empty", async () => {
    const { web } = await sessions({ reconnectDelaysMs: [60_000] });

    proxy.refuse();
    proxy.drop();

    await expect
      .poll(() => web.call("read_mailbox"), { timeout: 5000 })
      .toContain("Not connected to the relay");
    expect(await web.call("list_agents")).toContain("reconnecting");
  });

  it("disconnects when it can't reconnect: the tools and the watch stop, and connect comes back", async () => {
    const { web, inbox, session } = await sessions({
      reconnectDelaysMs: [10, 10],
    });

    proxy.refuse();
    proxy.drop();

    await expect
      .poll(() => web.tools(), { timeout: 5000 })
      .toEqual(["connect"]);
    expect(readInboxState(inbox)).toMatchObject({
      session,
      closed: true,
      lost: true,
    });

    proxy.refuse(false);
    expect(await web.call("connect")).toContain("Connected to Blether");
  });

  it("notices a connection that has gone silent, and reconnects", async () => {
    const { api, web } = await sessions({
      heartbeatMs: 100,
      reconnectDelaysMs: Array<number>(20).fill(50),
    });

    proxy.silence();
    await expect
      .poll(() => api.call("list_agents"), { timeout: 5000 })
      .toContain("web: Kev's agent, no roles, offline");
    proxy.silence(false);

    await expect
      .poll(() => api.call("list_agents"), { timeout: 5000 })
      .toContain("web: Kev's agent, no roles, online");
    await api.call("send_message", { to: "web", body: "Still there?" });
    await expect
      .poll(() => web.call("read_mailbox"), { timeout: 5000 })
      .toContain("Still there?");
  });

  it("gives up on an attempt the relay never answers, and tries again", async () => {
    const { api } = await sessions({
      heartbeatMs: 100,
      reconnectDelaysMs: Array<number>(50).fill(20),
    });

    // Connections open, but nothing gets through: attempts hang mid-handshake.
    proxy.silence();
    proxy.drop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    proxy.silence(false);

    await expect
      .poll(() => api.call("list_agents"), { timeout: 5000 })
      .toContain("web: Kev's agent, no roles, online");
  });
});
