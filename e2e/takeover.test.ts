import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type StartedBridge } from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("taking over an agent", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-takeover-"));
    kev = device(root, "kev");
    await kev.run("init", "--name", "Kev");
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await kev.run("agent", "create", "backend", "web");
    await kev.run("agent", "create", "backend", "api");
    // These sessions use the device's real policy; let them send freely.
    await kev.run("policy", "set", "--outgoing", "free");
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A session as the host would start it: the bridge from startBridge, behind an MCP client. */
  const startSession = async (agent: string) => {
    const started: StartedBridge = await startBridge(
      {
        BLETHER_HOME: kev.store.home,
        BLETHER_TEAM: "backend",
        BLETHER_AGENT: agent,
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
    return { started, client, call, tools };
  };

  it("offers a takeover when another session holds the agent, and becomes the agent in place", async () => {
    const first = await startSession("web");
    const second = await startSession("web");
    expect(second.started.problem).toContain("agent-in-use");
    expect(await second.tools()).toEqual(["blether_status", "take_over_agent"]);

    const result = await second.call("take_over_agent");

    expect(result).toContain("This session is now web");
    expect(await second.tools()).toContain("send_message");
    expect(await second.tools()).not.toContain("take_over_agent");
    expect(
      await second.call("send_message", {
        to: "api",
        body: "from the new web",
      }),
    ).toMatch(/^Queued/);
    await expect
      .poll(() => first.call("list_agents"))
      .toContain("Another session took over this agent");
  });

  it("tells the agent it was taken over when it next tries to send", async () => {
    const first = await startSession("web");
    const second = await startSession("web");
    await second.call("take_over_agent");

    await expect
      .poll(() =>
        first.call("send_message", { to: "api", body: "from the old web" }),
      )
      .toContain("Another session took over this agent");
  });

  it("doesn't offer a takeover for other problems", async () => {
    const session = await startSession("ghost");

    expect(session.started.problem).toContain("unknown-agent");
    expect(await session.tools()).toEqual(["blether_status"]);
  });
});
