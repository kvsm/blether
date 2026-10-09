import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RelayFrame,
  acceptInvite,
  addDevice,
  createAgent,
  createIdentity,
  createInvite,
  createTeam,
  generateDeviceKey,
  parseFrame,
  signChallenge,
  verifyIdentityLog,
  verifyTeamLog,
  type Identity,
  type IdentityLog,
  type DeviceKey,
  type SignedTeamEntry,
  type Signer,
  type Team,
  type TeamLog,
} from "@blether/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startRelay, type Relay, type RelayOptions } from "./relay.js";

type FrameOf<T extends RelayFrame["type"]> = Extract<RelayFrame, { type: T }>;

/**
 * The relay can't read envelopes, so these tests use stand-ins: a single
 * "copy" holding the test's text in the clear, under a made-up device key.
 */
const STAND_IN_DEVICE = "d".repeat(43);
const opaque = (text: string) => ({
  v: 1,
  copies: { [STAND_IN_DEVICE]: text },
});
const textOf = (message: { envelope: { copies: Record<string, string> } }) =>
  message.envelope.copies[STAND_IN_DEVICE];

interface Developer {
  device: DeviceKey;
  identity: IdentityLog;
  signer: Signer;
}

function newDeveloper(name: string): Developer {
  const device = generateDeviceKey();
  const identity = createIdentity(device, name);
  return {
    device,
    identity,
    signer: { device, identity: verifyIdentityLog(identity) },
  };
}

const alice = newDeveloper("Alice");
const bob = newDeveloper("Bob");
const carol = newDeveloper("Carol");
const identities = new Map<string, Identity>(
  [alice, bob, carol].map((d) => [d.signer.identity.id, d.signer.identity]),
);
const verify = (log: TeamLog) => verifyTeamLog(log, identities);

interface Scope {
  team?: string;
  agent?: string;
}

function helloFrame(scope: Scope, challenge: string, as: Developer) {
  return {
    type: "hello",
    ...scope,
    identity: as.identity,
    device: as.device.publicKey,
    signature: signChallenge(as.device, challenge, scope),
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

  static async connect(
    url: string,
    { answerPings = true }: { answerPings?: boolean } = {},
  ): Promise<TestClient> {
    // answerPings: false stands in for a session that has silently died.
    const socket = new WebSocket(url, { autoPong: answerPings });
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

  /** Answers the relay's challenge and returns its reply: welcome or error. */
  async sayHello(
    scope: Scope,
    as: Developer = alice,
    extra: Record<string, unknown> = {},
  ) {
    const { challenge } = await this.next("challenge");
    this.send({ ...helloFrame(scope, challenge, as), ...extra });
    return this.next();
  }

  async hello(scope: Scope, as: Developer = alice) {
    const reply = await this.sayHello(scope, as);
    if (reply.type !== "welcome") {
      throw new Error(`expected welcome, got ${JSON.stringify(reply)}`);
    }
    return reply;
  }

  /** Sends a team request and returns the reply: team or error. */
  async teamRequest(frame: Record<string, unknown>) {
    const requestId = randomUUID();
    this.send({ ...frame, requestId });
    return this.next();
  }

  /** Sends a message and waits for the relay to accept it. */
  async message(to: string, text: string) {
    const id = randomUUID();
    this.send({ type: "send", id, to, envelope: opaque(text) });
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

/** A relay hosting Alice's team, which Bob has joined and Carol hasn't, plus helpers. */
function useRelay(options: RelayOptions = {}) {
  const ctx = {} as { relay: Relay; team: Team; log: TeamLog };
  let clients: TestClient[] = [];

  const connect = async () => {
    const client = await TestClient.connect(ctx.relay.url);
    clients.push(client);
    return client;
  };

  /** A CLI session (no team or agent) for `as`. */
  const cli = async (as: Developer = alice) => {
    const client = await connect();
    await client.hello({}, as);
    return client;
  };

  const append = async (entry: SignedTeamEntry, as: Developer) => {
    const client = await cli(as);
    const reply = await client.teamRequest({
      type: "append-team",
      team: ctx.team.id,
      entry,
    });
    await client.close();
    if (reply.type !== "team") throw new Error(JSON.stringify(reply));
    ctx.log = reply.log;
    ctx.team = verify(ctx.log);
  };

  /** Alice invites `as`, who accepts. */
  const join = async (as: Developer) => {
    const { entry, invite, secret } = createInvite(ctx.team, alice.signer);
    await append(entry, alice);
    await append(acceptInvite(ctx.team, invite, secret, as.signer), as);
  };

  /** Creates `agent`, owned by `as`, unless the team already has it. */
  const ensureAgent = async (agent: string, as: Developer) => {
    if (ctx.team.agents.some((a) => a.name === agent)) return;
    await append(createAgent(ctx.team, agent, [], as.signer), as);
  };

  /**
   * Connects a session as `agent` in the team, creating the agent for `as` if
   * the team doesn't have it yet, and retrying while a just-closed session
   * still holds it.
   */
  const connectAs = async (agent: string, as: Developer = alice) => {
    await ensureAgent(agent, as);
    for (let attempt = 0; ; attempt++) {
      const client = await connect();
      const reply = await client.sayHello({ team: ctx.team.id, agent }, as);
      if (reply.type === "welcome") return client;
      await client.close();
      if (attempt === 50) throw new Error(`could not connect as ${agent}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** Connects a session as `agent` and disconnects it, so the relay knows the agent. */
  const introduce = async (agent: string, as: Developer = alice) => {
    await (await connectAs(agent, as)).close();
  };

  beforeEach(async () => {
    ctx.relay = await startRelay(options);
    ctx.log = createTeam("backend", alice.signer);
    const admin = await cli(alice);
    const reply = await admin.teamRequest({
      type: "create-team",
      log: ctx.log,
    });
    if (reply.type !== "team") throw new Error(JSON.stringify(reply));
    await admin.close();
    ctx.team = verify(ctx.log);
    await join(bob);
  });
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients = [];
    await ctx.relay.close();
  });

  return { ctx, connect, cli, append, ensureAgent, connectAs, introduce };
}

describe("relay", () => {
  const { ctx, connect, cli, append, ensureAgent, connectAs, introduce } =
    useRelay();
  const inTeam = (agent: string) => ({ team: ctx.team.id, agent });

  describe("authentication", () => {
    it("welcomes an agent session that signs the challenge with its developer's device", async () => {
      await ensureAgent("web", alice);
      const web = await connect();

      expect(await web.hello(inTeam("web"))).toEqual({
        type: "welcome",
        team: ctx.team.id,
        agent: "web",
        developer: alice.signer.identity.id,
        identity: alice.identity,
      });
    });

    it("welcomes a CLI session that names no team or agent", async () => {
      const session = await connect();

      expect(await session.hello({})).toEqual({
        type: "welcome",
        developer: alice.signer.identity.id,
        identity: alice.identity,
      });
    });

    it("refuses a signature of a different challenge", async () => {
      const web = await connect();
      await web.next("challenge");
      web.send(helloFrame(inTeam("web"), "x".repeat(43), alice));

      expect(await web.next("error")).toMatchObject({
        code: "authentication-failed",
      });
    });

    it("refuses a signature made for a different agent", async () => {
      const web = await connect();
      const { challenge } = await web.next("challenge");
      web.send({
        ...helloFrame(inTeam("web"), challenge, alice),
        agent: "api",
      });

      expect(await web.next("error")).toMatchObject({
        code: "authentication-failed",
      });
    });

    it("refuses a CLI session's signature reused to act as an agent", async () => {
      const session = await connect();
      const { challenge } = await session.next("challenge");
      session.send({ ...helloFrame({}, challenge, alice), ...inTeam("web") });

      expect(await session.next("error")).toMatchObject({
        code: "authentication-failed",
      });
    });

    it("refuses a device that isn't in the identity it presents", async () => {
      const intruder = generateDeviceKey();
      const web = await connect();

      expect(
        await web.sayHello(inTeam("web"), { ...alice, device: intruder }),
      ).toMatchObject({ code: "authentication-failed" });
    });

    it("refuses a tampered identity log", async () => {
      const forged = structuredClone(alice.identity);
      (forged[0]!.entry as { name: string }).name = "Mallory";
      const web = await connect();

      expect(
        await web.sayHello(inTeam("web"), { ...alice, identity: forged }),
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

    it("refuses a hello that names a team but no agent", async () => {
      const web = await connect();

      expect(await web.sayHello({ team: ctx.team.id })).toMatchObject({
        code: "malformed-frame",
      });
    });
  });

  describe("sessions", () => {
    it("refuses to send before hello", async () => {
      const web = await connect();
      const id = randomUUID();
      web.send({ type: "send", id, to: "api", envelope: opaque("hi") });

      expect(await web.next("error")).toMatchObject({
        id,
        code: "not-introduced",
      });
    });

    it("refuses a second hello on the same connection", async () => {
      const web = await connectAs("web");
      web.send(helloFrame(inTeam("api"), "stale-challenge", alice));

      expect(await web.next("error")).toMatchObject({
        code: "already-introduced",
      });
    });

    it("refuses a second session for the same agent", async () => {
      await connectAs("api");
      const second = await connect();

      expect(await second.sayHello(inTeam("api"))).toMatchObject({
        code: "agent-in-use",
      });
    });

    it("lets the owner take over an agent another session is acting as", async () => {
      const first = await connectAs("api");
      const closed = new Promise<number>((resolve) =>
        first.socket.once("close", (code) => resolve(code)),
      );
      const second = await connect();

      expect(
        await second.sayHello(inTeam("api"), alice, { takeover: true }),
      ).toMatchObject({ type: "welcome", agent: "api" });
      expect(await closed).toBe(4002);

      const web = await connectAs("web");
      await web.message("api", "for the new session");
      expect(textOf((await second.next("deliver")).message)).toBe(
        "for the new session",
      );
    });

    it("never lets another developer take over an agent", async () => {
      await connectAs("api");
      const impostor = await connect();

      expect(
        await impostor.sayHello(inTeam("api"), bob, { takeover: true }),
      ).toMatchObject({ code: "agent-owned-by-another" });
    });

    it("frees the agent name when its session disconnects", async () => {
      const first = await connectAs("api");
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

  describe("team membership", () => {
    it("refuses an agent session from someone who isn't a member", async () => {
      const outsider = await connect();

      expect(await outsider.sayHello(inTeam("web"), carol)).toMatchObject({
        code: "not-a-member",
      });
    });

    it("refuses an agent session for a team it doesn't host", async () => {
      const web = await connect();

      expect(
        await web.sayHello({ team: "n".repeat(43), agent: "web" }),
      ).toMatchObject({ code: "unknown-team" });
    });

    it("lets a member who joined by invite act as an agent", async () => {
      await expect(connectAs("ops", bob)).resolves.toBeInstanceOf(TestClient);
    });

    it("refuses to let another developer act as an agent someone already owns", async () => {
      await introduce("api", alice);
      const impostor = await connect();

      expect(await impostor.sayHello(inTeam("api"), bob)).toMatchObject({
        code: "agent-owned-by-another",
      });
    });

    it("lets the owner act as their agent again", async () => {
      await introduce("api");

      await expect(connectAs("api")).resolves.toBeInstanceOf(TestClient);
    });
  });

  describe("team logs", () => {
    it("returns a team's log with the identities needed to verify it", async () => {
      const session = await cli(carol);
      const reply = await session.teamRequest({
        type: "get-team",
        team: ctx.team.id,
      });
      if (reply.type !== "team") throw new Error(JSON.stringify(reply));

      const known = new Map(
        reply.identities.map((log) => {
          const identity = verifyIdentityLog(log);
          return [identity.id, identity] as const;
        }),
      );
      expect(verifyTeamLog(reply.log, known).members).toEqual([
        alice.signer.identity.id,
        bob.signer.identity.id,
      ]);
    });

    it("refuses a new team whose log isn't a single entry by the session's developer", async () => {
      const session = await cli(bob);

      expect(
        await session.teamRequest({
          type: "create-team",
          log: createTeam("frontend", alice.signer),
        }),
      ).toMatchObject({ type: "error", code: "team-rejected" });
    });

    it("refuses an entry that doesn't extend the current log", async () => {
      const stale = createInvite(verify(ctx.log.slice(0, 1)), alice.signer);
      const session = await cli(alice);

      expect(
        await session.teamRequest({
          type: "append-team",
          team: ctx.team.id,
          entry: stale.entry,
        }),
      ).toMatchObject({ type: "error", code: "team-conflict" });
    });

    it("refuses an entry authored by someone other than the session's developer", async () => {
      const { entry } = createInvite(ctx.team, alice.signer);
      const session = await cli(bob);

      expect(
        await session.teamRequest({
          type: "append-team",
          team: ctx.team.id,
          entry,
        }),
      ).toMatchObject({ type: "error", code: "team-rejected" });
    });

    it("refuses a join that doesn't prove it holds the invite secret", async () => {
      const { entry, invite } = createInvite(ctx.team, alice.signer);
      await append(entry, alice);
      const guess = acceptInvite(
        ctx.team,
        invite,
        "s".repeat(43),
        carol.signer,
      );
      const session = await cli(carol);

      expect(
        await session.teamRequest({
          type: "append-team",
          team: ctx.team.id,
          entry: guess,
        }),
      ).toMatchObject({ type: "error", code: "team-rejected" });
    });
  });

  describe("messaging", () => {
    it("delivers straight away to an agent with a session", async () => {
      const web = await connectAs("web");
      const api = await connectAs("api", bob);

      const sent = await web.message("api", "is /users changing?");

      expect(sent.status).toBe("delivered");
      const { message } = await api.next("deliver");
      expect(message).toMatchObject({
        id: sent.id,
        from: "web",
        to: "api",
      });
      expect(textOf(message)).toBe("is /users changing?");
      expect(Date.parse(message.receivedAt)).not.toBeNaN();
    });

    it("stamps the sender from the connection, not the frame", async () => {
      const web = await connectAs("web");
      const api = await connectAs("api", bob);

      web.send({
        type: "send",
        id: randomUUID(),
        to: "api",
        envelope: opaque("hi"),
        from: "admin",
      });

      expect((await api.next("deliver")).message.from).toBe("web");
    });

    it("refuses a message to an agent the team doesn't have", async () => {
      const web = await connectAs("web");
      const id = randomUUID();
      web.send({ type: "send", id, to: "apii", envelope: opaque("typo?") });

      expect(await web.next("error")).toMatchObject({
        id,
        code: "unknown-agent",
      });
    });

    it("refuses a reused message id", async () => {
      await introduce("api");
      const web = await connectAs("web");
      const { id } = await web.message("api", "first");

      web.send({ type: "send", id, to: "api", envelope: opaque("second") });

      expect(await web.next("error")).toMatchObject({
        id,
        code: "duplicate-id",
      });
    });

    it("refuses messages from a CLI session", async () => {
      const session = await cli();
      const id = randomUUID();
      session.send({ type: "send", id, to: "api", envelope: opaque("hi") });

      expect(await session.next("error")).toMatchObject({
        id,
        code: "no-agent",
      });
    });

    it("never delivers across teams, even to an agent with the same name", async () => {
      const otherLog = createTeam("frontend", alice.signer);
      otherLog.push(createAgent(verify(otherLog), "api", [], alice.signer));
      const admin = await cli(alice);
      await admin.teamRequest({
        type: "create-team",
        log: otherLog.slice(0, 1),
      });
      await admin.teamRequest({
        type: "append-team",
        team: verify(otherLog).id,
        entry: otherLog[1],
      });
      const apiElsewhere = await connect();
      await apiElsewhere.hello({ team: verify(otherLog).id, agent: "api" });
      const web = await connectAs("web");

      const id = randomUUID();
      web.send({
        type: "send",
        id,
        to: "api",
        envelope: opaque("wrong team?"),
      });
      expect(await web.next("error")).toMatchObject({
        id,
        code: "unknown-agent",
      });

      const api = await connectAs("api");
      await web.message("api", "right team");
      expect(textOf((await api.next("deliver")).message)).toBe("right team");
      const stray = await Promise.race([
        apiElsewhere.next("deliver"),
        new Promise((resolve) => setTimeout(() => resolve("nothing"), 100)),
      ]);
      expect(stray).toBe("nothing");
    });
  });

  describe("mailboxes", () => {
    it("queues messages for an offline agent and delivers them, in order, when it next connects", async () => {
      await introduce("api");
      const web = await connectAs("web");

      const first = await web.message("api", "first");
      const second = await web.message("api", "second");
      expect([first.status, second.status]).toEqual(["queued", "queued"]);

      const api = await connectAs("api");
      expect(textOf((await api.next("deliver")).message)).toBe("first");
      expect(textOf((await api.next("deliver")).message)).toBe("second");
    });

    it("delivers unread messages again to the agent's next session", async () => {
      await introduce("api");
      const web = await connectAs("web");
      const { id } = await web.message("api", "did you see this?");

      const firstSession = await connectAs("api");
      await firstSession.next("deliver");
      await firstSession.close();

      const secondSession = await connectAs("api");
      expect((await secondSession.next("deliver")).message.id).toBe(id);
    });

    it("doesn't deliver messages again once they've been read", async () => {
      await introduce("api");
      const web = await connectAs("web");
      const read = await web.message("api", "read me");

      const firstSession = await connectAs("api");
      await firstSession.next("deliver");
      firstSession.send({ type: "read", ids: [read.id] });
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
      const web = await connectAs("web");
      const { id } = await web.message("api", "for api only");

      const intruder = await connectAs("ops", bob);
      intruder.send({ type: "read", ids: [id] });

      await expect
        .poll(async () => (await web.listSent())[0]?.status)
        .toBe("queued");
    });

    it("reports delivery status to the sender as queued, then delivered, then read", async () => {
      await introduce("api");
      const web = await connectAs("web");
      const { id } = await web.message("api", "status please");

      expect(await web.listSent()).toEqual([
        { id, to: "api", sentAt: expect.any(String), status: "queued" },
      ]);

      const api = await connectAs("api");
      await api.next("deliver");
      expect((await web.listSent())[0]?.status).toBe("delivered");

      api.send({ type: "read", ids: [id] });
      await expect
        .poll(async () => (await web.listSent())[0]?.status)
        .toBe("read");
    });

    it("lists the most recently sent messages first, up to the limit", async () => {
      await introduce("api");
      const web = await connectAs("web");
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

describe("relay agents and presence", () => {
  const { ctx, connect, cli, ensureAgent, connectAs } = useRelay();

  it("refuses a session for an agent nobody has created", async () => {
    const session = await connect();

    expect(
      await session.sayHello({ team: ctx.team.id, agent: "ghost" }),
    ).toMatchObject({ code: "unknown-agent" });
  });

  it("reports which agents have a session connected", async () => {
    await ensureAgent("web", alice);
    await ensureAgent("api", bob);
    const web = await connectAs("web");
    const member = await cli(bob);

    const ask = async () => {
      member.send({
        type: "get-presence",
        requestId: randomUUID(),
        team: ctx.team.id,
      });
      return (await member.next("presence")).online;
    };
    expect(await ask()).toEqual(["web"]);

    const api = await connectAs("api", bob);
    expect(await ask()).toEqual(["api", "web"]);

    await web.close();
    await api.close();
    await expect.poll(ask).toEqual([]);
  });

  it("only tells members about presence", async () => {
    const outsider = await cli(carol);
    const requestId = randomUUID();
    outsider.send({ type: "get-presence", requestId, team: ctx.team.id });

    expect(await outsider.next("error")).toMatchObject({
      id: requestId,
      code: "not-a-member",
    });
  });
});

describe("relay heartbeat", () => {
  const { ctx, connect, ensureAgent, connectAs } = useRelay({
    heartbeatMs: 50,
  });

  it("drops a session that has silently died, freeing its agent", async () => {
    await ensureAgent("api", alice);
    const dead = await TestClient.connect(ctx.relay.url, {
      answerPings: false,
    });
    await dead.hello({ team: ctx.team.id, agent: "api" });
    const dropped = new Promise((resolve) =>
      dead.socket.once("close", resolve),
    );

    await dropped;

    await expect(connectAs("api")).resolves.toBeInstanceOf(TestClient);
  });

  it("keeps a session that answers", async () => {
    const live = await connectAs("api");
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(live.socket.readyState).toBe(1);
    const second = await connect();
    expect(
      await second.sayHello({ team: ctx.team.id, agent: "api" }),
    ).toMatchObject({ code: "agent-in-use" });
  });
});

describe("relay identity updates", () => {
  const { ctx, connect, ensureAgent } = useRelay();
  const inTeam = (agent: string) => ({ team: ctx.team.id, agent });

  /** Alice's identity with one more device, as that device's credentials. */
  function withNewDevice(log: IdentityLog = alice.identity): Developer {
    const device = generateDeviceKey();
    const identity = addDevice(log, alice.device, device.publicKey);
    return {
      device,
      identity,
      signer: { device, identity: verifyIdentityLog(identity) },
    };
  }

  it("lets a newly added device act as its developer's agents", async () => {
    await ensureAgent("web", alice);
    const laptop = withNewDevice();
    const session = await connect();

    expect(await session.sayHello(inTeam("web"), laptop)).toMatchObject({
      type: "welcome",
      developer: alice.signer.identity.id,
      identity: laptop.identity,
    });
  });

  it("gives a device that presents an older identity log the newest one", async () => {
    const laptop = withNewDevice();
    await (await connect()).hello({}, laptop);

    const desktop = await connect();
    const welcome = await desktop.hello({}, alice);

    expect(welcome.identity).toEqual(laptop.identity);
  });

  it("refuses an identity log that diverges from the one it holds", async () => {
    const laptop = withNewDevice();
    const phone = withNewDevice();
    await (await connect()).hello({}, laptop);

    const session = await connect();

    expect(await session.sayHello({}, phone)).toMatchObject({
      type: "error",
      code: "identity-conflict",
    });
  });
});

describe("relay invite expiry", () => {
  let clock = new Date();
  const { ctx, cli, append } = useRelay({ now: () => clock });

  it("refuses a join after the invite has expired by the relay's clock", async () => {
    clock = new Date();
    const { entry, invite, secret } = createInvite(ctx.team, alice.signer, {
      ttlHours: 1,
    });
    await append(entry, alice);
    // Carol's entry claims to be on time, but the relay goes by its own clock.
    const join = acceptInvite(ctx.team, invite, secret, carol.signer);
    clock = new Date(Date.now() + 2 * 3_600_000);
    const session = await cli(carol);

    expect(
      await session.teamRequest({
        type: "append-team",
        team: ctx.team.id,
        entry: join,
      }),
    ).toMatchObject({ type: "error", code: "team-rejected" });
  });
});

// A database on disk is slow on Windows CI runners, so allow more time.
describe("relay persistence", { timeout: 20_000 }, () => {
  let dir: string;
  const open = new Set<Relay>();

  /** Starts a relay that afterEach closes if the test doesn't. */
  const startRelayOn = async (databasePath: string): Promise<Relay> => {
    const relay = await startRelay({ databasePath });
    open.add(relay);
    return {
      ...relay,
      close: () => {
        open.delete(relay);
        return relay.close();
      },
    };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blether-relay-"));
  });
  afterEach(async () => {
    // Close the database first: Windows can't remove a file that's open.
    await Promise.all([...open].map((relay) => relay.close()));
    open.clear();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("keeps teams and mailboxes across a restart", async () => {
    const databasePath = join(dir, "relay.db");
    const log = createTeam("backend", alice.signer);
    const team = verify(log).id;
    log.push(createAgent(verify(log), "api", [], alice.signer));
    log.push(createAgent(verify(log), "web", [], alice.signer));

    const before = await startRelayOn(databasePath);
    const admin = await TestClient.connect(before.url);
    await admin.hello({});
    await admin.teamRequest({ type: "create-team", log: log.slice(0, 1) });
    for (const entry of log.slice(1)) {
      await admin.teamRequest({ type: "append-team", team, entry });
    }
    await admin.close();
    const api = await TestClient.connect(before.url);
    await api.hello({ team, agent: "api" });
    await api.close();
    const web = await TestClient.connect(before.url);
    await web.hello({ team, agent: "web" });
    const { id } = await web.message("api", "survive the restart");
    await web.close();
    await before.close();

    const after = await startRelayOn(databasePath);
    const apiAgain = await TestClient.connect(after.url);
    await apiAgain.hello({ team, agent: "api" });
    const { message } = await apiAgain.next("deliver");
    expect(message.id).toBe(id);
    expect(textOf(message)).toBe("survive the restart");
    await apiAgain.close();
  });
});
