import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RelayFrame,
  createIdentity,
  generateMachineKey,
  parseFrame,
  signChallenge,
  verifyIdentityLog,
  type IdentityLog,
  type MachineKey,
} from "@blether/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startRelay, type Relay } from "./relay.js";

type FrameOf<T extends RelayFrame["type"]> = Extract<RelayFrame, { type: T }>;

interface Developer {
  machine: MachineKey;
  identity: IdentityLog;
}

function newDeveloper(name: string): Developer {
  const machine = generateMachineKey();
  return { machine, identity: createIdentity(machine, name) };
}

/** The developer every test client acts for unless told otherwise. */
const alice = newDeveloper("Alice");
const bob = newDeveloper("Bob");

function helloFrame(agent: string, challenge: string, as: Developer) {
  return {
    type: "hello",
    agent,
    identity: as.identity,
    machine: as.machine.publicKey,
    signature: signChallenge(as.machine, challenge, agent),
  };
}

/** A raw WebSocket client that queues every frame the relay sends it. */
class TestClient {
  private readonly frames: RelayFrame[] = [];
  private waiters: (() => void)[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const frame = parseFrame(RelayFrame, data.toString());
      if (!frame) throw new Error(`relay sent an invalid frame: ${data}`);
      this.frames.push(frame);
      this.waiters.splice(0).forEach((wake) => wake());
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    // Listen before the socket opens: the relay sends its challenge at once.
    const client = new TestClient(socket);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return client;
  }

  send(frame: Record<string, unknown>) {
    this.socket.send(JSON.stringify(frame));
  }

  /** Takes the oldest frame, of the given type if one is named, waiting for it to arrive. */
  async next(): Promise<RelayFrame>;
  async next<T extends RelayFrame["type"]>(type: T): Promise<FrameOf<T>>;
  async next(type?: RelayFrame["type"]): Promise<RelayFrame> {
    for (;;) {
      const index = this.frames.findIndex((f) => !type || f.type === type);
      if (index >= 0) return this.frames.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** Answers the relay's challenge as `agent` and returns its reply: welcome or error. */
  async sayHello(agent: string, as: Developer = alice) {
    const { challenge } = await this.next("challenge");
    this.send(helloFrame(agent, challenge, as));
    return this.next();
  }

  async hello(agent: string, as: Developer = alice) {
    const reply = await this.sayHello(agent, as);
    if (reply.type !== "welcome") {
      throw new Error(`expected welcome, got ${JSON.stringify(reply)}`);
    }
    return reply;
  }

  /** Sends a message and waits for the relay to accept it. */
  async message(to: string, body: string) {
    const id = randomUUID();
    this.send({ type: "send", id, to, body });
    return this.next("sent");
  }

  async listSent(limit = 20) {
    const requestId = randomUUID();
    this.send({ type: "list-sent", requestId, limit });
    return (await this.next("sent-list")).messages;
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => this.socket.once("close", resolve));
    this.socket.close();
    await closed;
  }
}

describe("relay", () => {
  let relay: Relay;
  let clients: TestClient[] = [];
  const connect = async () => {
    const client = await TestClient.connect(relay.url);
    clients.push(client);
    return client;
  };
  /**
   * Connects a session as `agent`, retrying while the relay still holds the
   * agent for a session that has only just disconnected.
   */
  const connectAs = async (agent: string) => {
    for (let attempt = 0; ; attempt++) {
      const client = await connect();
      const reply = await client.sayHello(agent);
      if (reply.type === "welcome") return client;
      await client.close();
      if (attempt === 50) throw new Error(`could not connect as ${agent}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  /** Connects a session as `agent` and disconnects it, so the relay knows the agent. */
  const introduce = async (agent: string) => {
    const client = await connect();
    await client.hello(agent);
    await client.close();
  };

  beforeEach(async () => {
    relay = await startRelay();
  });
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients = [];
    await relay.close();
  });

  describe("authentication", () => {
    it("welcomes a session that signs the challenge with its developer's machine", async () => {
      const web = await connect();

      expect(await web.hello("web")).toEqual({
        type: "welcome",
        agent: "web",
        developer: verifyIdentityLog(alice.identity).id,
      });
    });

    it("refuses a signature of a different challenge", async () => {
      const web = await connect();
      await web.next("challenge");
      web.send(helloFrame("web", "x".repeat(43), alice));

      expect(await web.next("error")).toMatchObject({
        code: "authentication-failed",
      });
    });

    it("refuses a signature made for a different agent", async () => {
      const web = await connect();
      const { challenge } = await web.next("challenge");
      web.send({ ...helloFrame("web", challenge, alice), agent: "api" });

      expect(await web.next("error")).toMatchObject({
        code: "authentication-failed",
      });
    });

    it("refuses a machine that isn't in the identity it presents", async () => {
      const intruder = generateMachineKey();
      const web = await connect();

      expect(
        await web.sayHello("web", {
          machine: intruder,
          identity: alice.identity,
        }),
      ).toMatchObject({ code: "authentication-failed" });
    });

    it("refuses a tampered identity log", async () => {
      const forged = structuredClone(alice.identity);
      forged[0]!.entry.name = "Mallory";
      const web = await connect();

      expect(
        await web.sayHello("web", { machine: alice.machine, identity: forged }),
      ).toMatchObject({ code: "authentication-failed" });
    });

    it("refuses an unauthenticated hello", async () => {
      const web = await connect();
      await web.next("challenge");
      web.send({ type: "hello", agent: "web" });

      expect(await web.next("error")).toMatchObject({
        code: "malformed-frame",
      });
    });

    it("refuses to let another developer act as an agent someone already owns", async () => {
      await introduce("api");
      const impostor = await connect();

      expect(await impostor.sayHello("api", bob)).toMatchObject({
        code: "agent-owned-by-another",
      });
    });

    it("lets the owner act as their agent again", async () => {
      await introduce("api");

      await expect(connectAs("api")).resolves.toBeInstanceOf(TestClient);
    });
  });

  describe("sessions", () => {
    it("refuses to send before hello", async () => {
      const web = await connect();
      const id = randomUUID();
      web.send({ type: "send", id, to: "api", body: "hi" });

      expect(await web.next("error")).toMatchObject({
        id,
        code: "not-introduced",
      });
    });

    it("refuses a second hello on the same connection", async () => {
      const web = await connect();
      await web.hello("web");
      web.send(helloFrame("api", "stale-challenge", alice));

      expect(await web.next("error")).toMatchObject({
        code: "already-introduced",
      });
    });

    it("refuses a second session for the same agent", async () => {
      const first = await connect();
      const second = await connect();
      await first.hello("api");

      expect(await second.sayHello("api")).toMatchObject({
        code: "agent-in-use",
      });
    });

    it("frees the agent name when its session disconnects", async () => {
      const first = await connect();
      await first.hello("api");
      await first.close();

      // The relay may notice the disconnect slightly after the client does.
      await expect(connectAs("api")).resolves.toBeInstanceOf(TestClient);
    });

    it("reports malformed frames", async () => {
      const web = await connect();
      web.socket.send("{not json");

      expect(await web.next("error")).toMatchObject({
        code: "malformed-frame",
      });
    });
  });

  describe("sending", () => {
    it("delivers straight away to an agent with a session", async () => {
      const web = await connect();
      const api = await connect();
      await web.hello("web");
      await api.hello("api");

      const sent = await web.message("api", "is /users changing?");

      expect(sent.status).toBe("delivered");
      const { message } = await api.next("deliver");
      expect(message).toMatchObject({
        id: sent.id,
        from: "web",
        to: "api",
        body: "is /users changing?",
      });
      expect(Date.parse(message.sentAt)).not.toBeNaN();
    });

    it("stamps the sender from the connection, not the frame", async () => {
      const web = await connect();
      const api = await connect();
      await web.hello("web");
      await api.hello("api");

      web.send({
        type: "send",
        id: randomUUID(),
        to: "api",
        body: "hi",
        from: "admin",
      });

      expect((await api.next("deliver")).message.from).toBe("web");
    });

    it("refuses a message to an agent that has never had a session", async () => {
      const web = await connect();
      await web.hello("web");

      const id = randomUUID();
      web.send({ type: "send", id, to: "apii", body: "typo?" });

      expect(await web.next("error")).toMatchObject({
        id,
        code: "unknown-agent",
      });
    });

    it("refuses a reused message id", async () => {
      const web = await connect();
      await web.hello("web");
      await introduce("api");
      const { id } = await web.message("api", "first");

      web.send({ type: "send", id, to: "api", body: "second" });

      expect(await web.next("error")).toMatchObject({
        id,
        code: "duplicate-id",
      });
    });
  });

  describe("mailboxes", () => {
    it("queues messages for an offline agent and delivers them, in order, when it next connects", async () => {
      await introduce("api");
      const web = await connect();
      await web.hello("web");

      const first = await web.message("api", "first");
      const second = await web.message("api", "second");
      expect([first.status, second.status]).toEqual(["queued", "queued"]);

      const api = await connect();
      await api.hello("api");
      expect((await api.next("deliver")).message.body).toBe("first");
      expect((await api.next("deliver")).message.body).toBe("second");
    });

    it("delivers unread messages again to the agent's next session", async () => {
      await introduce("api");
      const web = await connect();
      await web.hello("web");
      const { id } = await web.message("api", "did you see this?");

      const firstSession = await connect();
      await firstSession.hello("api");
      await firstSession.next("deliver");
      await firstSession.close();

      const secondSession = await connectAs("api");
      expect((await secondSession.next("deliver")).message.id).toBe(id);
    });

    it("doesn't deliver messages again once they've been read", async () => {
      await introduce("api");
      const web = await connect();
      await web.hello("web");
      const read = await web.message("api", "read me");

      const firstSession = await connect();
      await firstSession.hello("api");
      await firstSession.next("deliver");
      firstSession.send({ type: "read", ids: [read.id] });
      // Wait until the relay has processed the read before disconnecting.
      await expect
        .poll(async () => (await web.listSent())[0]?.status)
        .toBe("read");
      await firstSession.close();

      const unread = await web.message("api", "still unread");
      const secondSession = await connectAs("api");
      expect((await secondSession.next("deliver")).message.id).toBe(unread.id);
    });

    it("only lets an agent mark its own messages read", async () => {
      await introduce("api");
      const web = await connect();
      await web.hello("web");
      const { id } = await web.message("api", "for api only");

      const intruder = await connect();
      await intruder.hello("ops", bob);
      intruder.send({ type: "read", ids: [id] });

      await expect
        .poll(async () => (await web.listSent())[0]?.status)
        .toBe("queued");
    });

    it("reports delivery status to the sender as queued, then delivered, then read", async () => {
      await introduce("api");
      const web = await connect();
      await web.hello("web");
      const { id } = await web.message("api", "status please");

      expect(await web.listSent()).toEqual([
        { id, to: "api", sentAt: expect.any(String), status: "queued" },
      ]);

      const api = await connect();
      await api.hello("api");
      await api.next("deliver");
      expect((await web.listSent())[0]?.status).toBe("delivered");

      api.send({ type: "read", ids: [id] });
      await expect
        .poll(async () => (await web.listSent())[0]?.status)
        .toBe("read");
    });

    it("lists the most recently sent messages first, up to the limit", async () => {
      await introduce("api");
      const web = await connect();
      await web.hello("web");
      await web.message("api", "one");
      const two = await web.message("api", "two");
      const three = await web.message("api", "three");

      expect((await web.listSent(2)).map((m) => m.id)).toEqual([
        three.id,
        two.id,
      ]);
    });
  });
});

describe("relay persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blether-relay-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps mailboxes across a restart", async () => {
    const databasePath = join(dir, "relay.db");

    const before = await startRelay({ databasePath });
    const api = await TestClient.connect(before.url);
    await api.hello("api");
    await api.close();
    const web = await TestClient.connect(before.url);
    await web.hello("web");
    const { id } = await web.message("api", "survive the restart");
    await web.close();
    await before.close();

    const after = await startRelay({ databasePath });
    try {
      const apiAgain = await TestClient.connect(after.url);
      await apiAgain.hello("api");
      expect((await apiAgain.next("deliver")).message).toMatchObject({
        id,
        body: "survive the restart",
      });
      await apiAgain.close();
    } finally {
      await after.close();
    }
  });
});
