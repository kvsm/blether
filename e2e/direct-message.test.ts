import {
  CLAUDE_CHANNEL,
  CLAUDE_CHANNEL_NOTIFICATION,
  RelayConnection,
  RelayError,
  createBridgeServer,
} from "@blether/bridge";
import {
  createIdentity,
  createAgent,
  createTeam,
  generateDeviceKey,
  verifyIdentityLog,
} from "@blether/protocol";
import { startRelay, type Relay } from "@blether/relay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const ChannelNotice = z.object({
  method: z.literal(CLAUDE_CHANNEL_NOTIFICATION),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()).optional(),
  }),
});
type ChannelNotice = z.infer<typeof ChannelNotice>["params"];

/** One developer, in one team, owns every agent in these tests. */
const device = generateDeviceKey();
const credentials = { device, identity: createIdentity(device, "Kev") };
let team: string;

async function createTestTeam(relay: Relay) {
  const cli = await RelayConnection.connect(relay.url, credentials);
  const signer = { device, identity: verifyIdentityLog(credentials.identity) };
  let { team } = await cli.createTeam(createTeam("backend", signer));
  for (const agent of ["web", "api", "ops"]) {
    ({ team } = await cli.appendTeam(
      team.id,
      createAgent(team, agent, [], signer),
    ));
  }
  await cli.close();
  return team.id;
}

/**
 * Connects to the relay as `agent`, retrying while the relay still holds the
 * agent for a session that has only just disconnected.
 */
async function connectAs(relay: Relay, agent: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await RelayConnection.connect(relay.url, credentials, {
        scope: { team, agent },
      });
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
  // Record channel notices the way Claude Code would receive them.
  const notices: ChannelNotice[] = [];
  client.setNotificationHandler(ChannelNotice, ({ params }) => {
    notices.push(params);
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    notices,
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
    team = await createTestTeam(relay);
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
      text: "Not sent: There is no agent called apii in this team.",
    });
  });

  it("lists the Blether tools and tells the agent to treat messages as untrusted", async () => {
    const web = await session("web");

    const { tools } = await web.client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_agents",
      "read_mailbox",
      "send_message",
      "sent_messages",
    ]);
    expect(web.client.getInstructions()).toContain("untrusted");
  });

  describe("Claude Code channel", () => {
    it("declares the channel capability", async () => {
      const web = await session("web");

      expect(web.client.getServerCapabilities()?.experimental).toHaveProperty(
        CLAUDE_CHANNEL,
      );
    });

    it("notifies the session when a message arrives, without including the message", async () => {
      const web = await session("web");
      const api = await session("api");

      await web.call("send_message", { to: "api", body: "secret plans" });

      await expect.poll(() => api.notices.length).toBe(1);
      const [notice] = api.notices;
      expect(notice).toEqual({
        content:
          "New Blether message from web. You have 1 unread; call read_mailbox to read them.",
        meta: { from: "web", unread: "1" },
      });
      expect(JSON.stringify(notice)).not.toContain("secret plans");
    });

    it("tells a new session about its backlog once it has connected", async () => {
      await (await session("api")).close();
      const web = await session("web");
      await web.call("send_message", { to: "api", body: "one" });
      await web.call("send_message", { to: "api", body: "two" });

      const api = await session("api");

      await expect.poll(() => api.notices.length).toBe(1);
      expect(api.notices[0]).toEqual({
        content:
          "You have 2 unread Blether message(s) waiting; call read_mailbox to read them.",
        meta: { unread: "2" },
      });
    });

    it("leaves notified messages unread until the agent reads its mailbox", async () => {
      const web = await session("web");
      const api = await session("api");
      await web.call("send_message", { to: "api", body: "still here?" });
      await expect.poll(() => api.notices.length).toBe(1);

      expect((await web.call("sent_messages")).text).toMatch(/: delivered$/);
      expect((await api.call("read_mailbox")).text).toContain("still here?");
    });
  });
});
