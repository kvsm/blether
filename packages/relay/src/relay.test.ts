import { randomUUID } from "node:crypto";
import { RelayFrame, parseFrame } from "@blether/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startRelay, type Relay } from "./relay.js";

type FrameOf<T extends RelayFrame["type"]> = Extract<RelayFrame, { type: T }>;

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
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new TestClient(socket);
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

  async hello(agent: string) {
    this.send({ type: "hello", agent });
    return this.next("welcome");
  }

  close() {
    this.socket.close();
  }
}

describe("relay", () => {
  let relay: Relay;
  const clients: TestClient[] = [];
  const connect = async () => {
    const client = await TestClient.connect(relay.url);
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    relay = await startRelay();
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await relay.close();
  });

  it("delivers a message to the recipient's session", async () => {
    const web = await connect();
    const api = await connect();
    await web.hello("web");
    await api.hello("api");

    const id = randomUUID();
    web.send({ type: "send", id, to: "api", body: "is /users changing?" });

    expect(await web.next("sent")).toEqual({ type: "sent", id });
    const { message } = await api.next("deliver");
    expect(message).toMatchObject({
      id,
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

  it("refuses a message to an agent with no session", async () => {
    const web = await connect();
    await web.hello("web");

    const id = randomUUID();
    web.send({ type: "send", id, to: "api", body: "hello?" });

    expect(await web.next("error")).toMatchObject({
      id,
      code: "recipient-offline",
    });
  });

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
    web.send({ type: "hello", agent: "api" });

    expect(await web.next("error")).toMatchObject({
      code: "already-introduced",
    });
  });

  it("refuses a second session for the same agent", async () => {
    const first = await connect();
    const second = await connect();
    await first.hello("api");

    second.send({ type: "hello", agent: "api" });

    expect(await second.next("error")).toMatchObject({ code: "agent-in-use" });
  });

  it("frees the agent name when its session disconnects", async () => {
    const first = await connect();
    await first.hello("api");
    first.close();

    // The relay may notice the disconnect slightly after the client does.
    await expect
      .poll(async () => {
        const next = await connect();
        next.send({ type: "hello", agent: "api" });
        return (await next.next()).type;
      })
      .toBe("welcome");
  });

  it("reports malformed frames", async () => {
    const web = await connect();
    web.socket.send("{not json");

    expect(await web.next("error")).toMatchObject({ code: "malformed-frame" });
  });
});
