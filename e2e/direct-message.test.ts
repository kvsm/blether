import {
  RelayConnection,
  RelayError,
  createBridgeServer,
} from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Connects to the relay as `agent`, retrying while the relay still holds the
 * agent for a session that has only just disconnected.
 */
async function connectAs(relay: Relay, agent: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await RelayConnection.connect(relay.url, agent);
    } catch (error) {
      const inUse =
        error instanceof RelayError && error.code === "agent-in-use";
      if (!inUse || attempt === 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** An agent session: an MCP client talking to its own bridge, which is connected to the relay. */
async function startSession(relay: Relay, agent: string) {
  const connection = await connectAs(relay, agent);
  const server = createBridgeServer(connection);
  const client = new Client({ name: `${agent}-session`, version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const [content] = result.content as { type: string; text: string }[];
      return { text: content?.text ?? "", isError: result.isError === true };
    },
    async close() {
      await client.close();
      await connection.close();
    },
  };
}

type Session = Awaited<ReturnType<typeof startSession>>;

describe("messaging between agents through bridges and a relay", () => {
  let relay: Relay;
  let sessions: Session[] = [];
  const session = async (agent: string) => {
    const s = await startSession(relay, agent);
    sessions.push(s);
    return s;
  };

  beforeEach(async () => {
    relay = await startRelay();
  });
  afterEach(async () => {
    await Promise.all(sessions.map((s) => s.close()));
    sessions = [];
    await relay.close();
  });

  it("delivers a message from one agent's session to another's mailbox", async () => {
    const web = await session("web");
    const api = await session("api");

    const sent = await web.call("send_message", {
      to: "api",
      body: "Is the /users response shape changing?",
    });
    expect(sent).toMatchObject({ isError: false });
    expect(sent.text).toMatch(/^Sent message .+ to api\.$/);

    await expect
      .poll(async () => (await api.call("read_mailbox")).text)
      .toContain("Is the /users response shape changing?");
  });

  it("marks messages read once returned", async () => {
    const web = await session("web");
    const api = await session("api");
    await web.call("send_message", { to: "api", body: "ping" });
    await expect
      .poll(async () => (await api.call("read_mailbox")).text)
      .toContain('from="web"');

    expect((await api.call("read_mailbox")).text).toBe("No unread messages.");
  });

  it("queues a message for an offline agent until its next session", async () => {
    await (await session("api")).close();
    const web = await session("web");

    const sent = await web.call("send_message", {
      to: "api",
      body: "Heads up: I'm changing the User schema.",
    });
    expect(sent.text).toMatch(/^Queued message .+ for api/);

    const api = await session("api");
    await expect
      .poll(async () => (await api.call("read_mailbox")).text)
      .toContain("Heads up: I'm changing the User schema.");
  });

  it("shows the sender each message's delivery status", async () => {
    await (await session("api")).close();
    const web = await session("web");
    await web.call("send_message", { to: "api", body: "status?" });

    expect((await web.call("sent_messages")).text).toMatch(
      /to api .*: queued$/,
    );

    const api = await session("api");
    await expect
      .poll(async () => (await web.call("sent_messages")).text)
      .toMatch(/: delivered$/);

    await api.call("read_mailbox");
    await expect
      .poll(async () => (await web.call("sent_messages")).text)
      .toMatch(/: read$/);
  });

  it("tells the sender when there is no such agent", async () => {
    const web = await session("web");

    const sent = await web.call("send_message", { to: "apii", body: "hello?" });

    expect(sent).toEqual({
      isError: true,
      text: "Not sent: There is no agent called apii.",
    });
  });

  it("lists the Blether tools and tells the agent to treat messages as untrusted", async () => {
    const web = await session("web");

    const { tools } = await web.client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "read_mailbox",
      "send_message",
      "sent_messages",
    ]);
    expect(web.client.getInstructions()).toContain("untrusted");
  });
});
