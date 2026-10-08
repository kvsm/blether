import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type StartedBridge } from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("connecting a session explicitly (BLETHER_CONNECT=manual)", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-connect-"));
    kev = device(root, "kev");
    await kev.run("init", "--name", "Kev");
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await kev.run("agent", "create", "backend", "web");
    await kev.run("agent", "create", "backend", "api");
    await kev.run("policy", "set", "--outgoing", "free");
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A session as the Claude Code plugin starts it. */
  const startSession = async (agent: string, connect = "manual") => {
    const started: StartedBridge = await startBridge(
      {
        BLETHER_HOME: kev.store.home,
        BLETHER_TEAM: "backend",
        BLETHER_AGENT: agent,
        BLETHER_CONNECT: connect,
      },
      () => {},
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
    return { client, call, tools };
  };

  const online = async () => {
    const observer = await startSession("api", "auto");
    return () => observer.call("list_agents");
  };

  it("stays out of the session until it connects: no instructions, one tool, offline", async () => {
    const session = await startSession("web");
    const roster = await online();

    expect(session.client.getInstructions()).toBeUndefined();
    expect(await session.tools()).toEqual(["connect"]);
    expect(await roster()).toContain("web: Kev's agent, no roles, offline");
  });

  it("connects on request: the agent comes online, gets its tools and a watch for this connection", async () => {
    const session = await startSession("web");
    const roster = await online();

    const result = await session.call("connect");

    expect(result).toContain(
      "Connected to Blether: you are web in team backend.",
    );
    expect(result).toContain("Call read_mailbox.");
    expect(result).toMatch(
      /blether watch --inbox "[^"]+\/inbox\/[^"]+\.web\.json" --session [0-9a-f-]{36}/,
    );
    expect(await session.tools()).toEqual(
      expect.arrayContaining(["disconnect", "read_mailbox", "send_message"]),
    );
    expect(await session.tools()).not.toContain("connect");
    await expect.poll(roster).toContain("web: Kev's agent, no roles, online");
  });

  it("says to restart the watch when it expires, without asking the agent to keep anything from its developer", async () => {
    const session = await startSession("web");

    const result = await session.call("connect");

    expect(result).toContain(
      "When the watch expires, start it again with --quiet-start added to the command.",
    );
    expect(result).not.toMatch(/silently|don't (mention|tell)/i);
  });

  it("takes the agent over from another session when it connects, which goes back to offering connect", async () => {
    const first = await startSession("web");
    const second = await startSession("web");
    await first.call("connect");

    expect(await second.call("connect")).toContain("Connected to Blether");
    await expect.poll(() => first.tools()).toEqual(["connect"]);
    expect(await second.call("list_agents")).toContain(
      "web (you): Kev's agent, no roles, online",
    );
  });

  it("disconnects on request: the tools go and connect comes back", async () => {
    const session = await startSession("web");
    const roster = await online();
    await session.call("connect");

    expect(await session.call("disconnect")).toContain(
      "Disconnected from Blether",
    );
    expect(await session.tools()).toEqual(["connect"]);
    await expect.poll(roster).toContain("web: Kev's agent, no roles, offline");

    expect(await session.call("connect")).toContain("Connected to Blether");
  });

  it("explains a problem when it can't connect", async () => {
    const session = await startSession("ghost");

    const result = await session.client.callTool({ name: "connect" });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toContain(
      "Couldn't connect to Blether",
    );
    expect(await session.tools()).toEqual(["connect"]);
  });
});
