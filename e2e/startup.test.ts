import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type StartedBridge } from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("bridge start-up", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let started: StartedBridge | undefined;
  let client: Client | undefined;

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-startup-"));
    kev = device(root, "kev");
  });
  afterEach(async () => {
    await client?.close();
    await started?.close();
    client = undefined;
    started = undefined;
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Starts the bridge the way the agent's host would, and connects an MCP client to it. */
  const start = async (env: Record<string, string>) => {
    started = await startBridge(
      {
        BLETHER_HOME: kev.store.home,
        // Somewhere with no session file, unless a test says otherwise.
        BLETHER_PROJECT_DIR: join(root, "elsewhere"),
        ...env,
      },
      () => {},
    );
    client = new Client({ name: "host", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await started.server.connect(b);
    await client.connect(a);
    const { tools } = await client.listTools();
    return {
      problem: started.problem,
      tools: tools.map((t) => t.name).sort(),
      instructions: client.getInstructions() ?? "",
      status: async () => {
        const result = await client!.callTool({ name: "blether_status" });
        return (result.content as { text: string }[])[0]?.text ?? "";
      },
    };
  };

  const setUp = async () => {
    await kev.run("init", "--name", "Kev");
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await kev.run("agent", "create", "backend", "web");
  };

  it("serves the messaging tools when everything is set up", async () => {
    await setUp();

    const bridge = await start({
      BLETHER_TEAM: "backend",
      BLETHER_AGENT: "web",
    });

    expect(bridge.problem).toBeUndefined();
    expect(bridge.tools).toContain("send_message");
  });

  it("explains a missing agent name instead of failing", async () => {
    await setUp();

    const bridge = await start({ BLETHER_TEAM: "backend" });

    expect(bridge.tools).toEqual(["blether_status"]);
    expect(bridge.instructions).toContain("No agent is chosen");
    expect(await bridge.status()).toContain(
      "Run `blether use <team> <agent>` in the project",
    );
  });

  describe("with a project's session file", () => {
    const project = () => join(root, "project");

    it("acts as the agent chosen with blether use", async () => {
      await setUp();
      const used = await kev.run("use", "backend", "web", "--dir", project());
      expect(used).toMatchObject({ code: 0 });
      expect(used.out).toContain("will act as web in backend");

      const bridge = await start({ BLETHER_PROJECT_DIR: project() });

      expect(bridge.problem).toBeUndefined();
      expect(bridge.tools).toContain("send_message");
    });

    it("finds it from a directory inside the project", async () => {
      await setUp();
      await kev.run("use", "backend", "web", "--dir", project());
      const inside = join(project(), "src", "deep");
      mkdirSync(inside, { recursive: true });

      const bridge = await start({ BLETHER_PROJECT_DIR: inside });

      expect(bridge.problem).toBeUndefined();
    });

    it("lets the environment override it", async () => {
      await setUp();
      await kev.run("agent", "create", "backend", "docs");
      await kev.run("use", "backend", "web", "--dir", project());
      const web = await kev.session("backend", "web");

      // web is busy, so only an override to docs can connect.
      const bridge = await start({
        BLETHER_PROJECT_DIR: project(),
        BLETHER_AGENT: "docs",
      });
      await web.close();

      expect(bridge.problem).toBeUndefined();
    });

    it("keeps itself out of git", async () => {
      await setUp();
      await kev.run("use", "backend", "web", "--dir", project());

      expect(
        readFileSync(join(project(), ".blether", ".gitignore"), "utf8"),
      ).toContain("*");
    });

    it("explains a damaged file", async () => {
      await setUp();
      mkdirSync(join(project(), ".blether"), { recursive: true });
      writeFileSync(join(project(), ".blether", "session.json"), "{ nope");

      const bridge = await start({ BLETHER_PROJECT_DIR: project() });

      expect(bridge.problem).toContain("isn't valid JSON");
      expect(bridge.problem).toContain("blether use <team> <agent>");
    });

    it("only lets you use your own, existing agents", async () => {
      await setUp();
      const carol = device(root, "carol");
      await carol.run("init", "--name", "Carol");
      await carol.run("join", await kev.invite("backend"));
      await carol.run("agent", "create", "backend", "api");

      const theirs = await kev.run("use", "backend", "api", "--dir", project());
      expect(theirs).toMatchObject({ code: 1 });
      expect(theirs.err).toContain("api belongs to another developer");

      const missing = await kev.run("use", "backend", "x", "--dir", project());
      expect(missing.err).toContain("blether agent create backend x");
    });
  });

  it("explains a device with no identity", async () => {
    const bridge = await start({
      BLETHER_TEAM: "backend",
      BLETHER_AGENT: "web",
    });

    expect(bridge.problem).toContain("blether init");
    expect(bridge.problem).toContain("blether device request");
  });

  it("explains an identity from an earlier build, with a command that works in bash", async () => {
    mkdirSync(kev.store.home, { recursive: true });
    writeFileSync(join(kev.store.home, "machine-key.json"), "{}");

    const bridge = await start({
      BLETHER_TEAM: "backend",
      BLETHER_AGENT: "web",
    });

    expect(bridge.problem).toContain("earlier development build");
    expect(bridge.problem).toMatch(/mv "[^"\\]+" "[^"\\]+\.old"/);
  });

  it("explains a missing or unknown team", async () => {
    await setUp();

    expect((await start({ BLETHER_AGENT: "web" })).problem).toContain(
      "No team is chosen for this project. Run `blether use <team> <agent>`",
    );
    await started!.close();
    expect(
      (await start({ BLETHER_TEAM: "nope", BLETHER_AGENT: "web" })).problem,
    ).toContain("You aren't in a team called nope");
  });

  it("explains an agent that hasn't been created", async () => {
    await setUp();

    const bridge = await start({
      BLETHER_TEAM: "backend",
      BLETHER_AGENT: "ghost",
    });

    expect(bridge.problem).toContain("unknown-agent");
    expect(bridge.problem).toContain("blether agent create backend ghost");
  });

  it("explains how to fix another session already acting as the agent", async () => {
    await setUp();
    const first = await kev.session("backend", "web");

    const bridge = await start({
      BLETHER_TEAM: "backend",
      BLETHER_AGENT: "web",
    });
    await first.close();

    expect(bridge.problem).toContain("agent-in-use");
    expect(bridge.problem).toContain("Only one session can act as web");
    expect(bridge.problem).toContain("choose a different agent");
  });

  it("explains a relay that isn't running", async () => {
    await setUp();

    // Point the team at a port nothing is listening on.
    const record = kev.teams.get("backend")!;
    kev.teams.save({ ...record, relayUrl: "ws://127.0.0.1:1" });
    const bridge = await start({
      BLETHER_TEAM: "backend",
      BLETHER_AGENT: "web",
    });

    expect(bridge.problem).toContain("Couldn't connect to the relay");
    expect(bridge.problem).toContain("Is it running?");
  });
});
