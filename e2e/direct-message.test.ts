import { RelayConnection, createBridgeServer } from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** An agent session: an MCP client talking to its own bridge, which is connected to the relay. */
async function startSession(relay: Relay, agent: string) {
  const connection = await RelayConnection.connect(relay.url, agent);
  const server = createBridgeServer(connection);
  const client = new Client({ name: `${agent}-session`, version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const [content] = result.content as { type: string; text: string }[];
      return { text: content?.text ?? "", isError: result.isError === true };
    },
    async close() {
      await client.close();
      connection.close();
    },
  };
}

describe("direct message between two agents", () => {
  let relay: Relay;
  const sessions: { close(): Promise<void> }[] = [];
  const session = async (agent: string) => {
    const s = await startSession(relay, agent);
    sessions.push(s);
    return s;
  };

  beforeEach(async () => {
    relay = await startRelay();
  });
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.close()));
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

  it("tells the sender when the recipient has no session", async () => {
    const web = await session("web");

    const sent = await web.call("send_message", { to: "api", body: "hello?" });

    expect(sent).toEqual({
      isError: true,
      text: "Not sent: No session is acting as api.",
    });
  });

  it("lists the Blether tools", async () => {
    const connection = await RelayConnection.connect(relay.url, "web");
    const client = new Client({ name: "probe", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createBridgeServer(connection).connect(b);
    await client.connect(a);
    sessions.push({
      close: async () => {
        await client.close();
        connection.close();
      },
    });

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "read_mailbox",
      "send_message",
    ]);
    expect(client.getInstructions()).toContain("untrusted");
  });
});
