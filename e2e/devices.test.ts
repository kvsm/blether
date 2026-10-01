import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileKeyStore,
  RelayConnection,
  TeamDirectory,
  createBridgeServer,
  runCli,
} from "@blether/bridge";
import { verifyIdentityLog } from "@blether/protocol";
import { startRelay, type Relay } from "@blether/relay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** One device: its own BLETHER_HOME, driven through the CLI. */
function device(root: string, name: string) {
  const store = new FileKeyStore(join(root, name));
  const teams = new TeamDirectory(store.home);
  let answer = true;
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      store,
      teams,
      io: {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        confirm: async () => answer,
      },
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const printed = async (pattern: RegExp, ...argv: string[]) => {
    const result = await run(...argv);
    const match = pattern.exec(result.out)?.[0];
    if (result.code !== 0 || !match) {
      throw new Error(`${argv.join(" ")} failed: ${result.err || result.out}`);
    }
    return match;
  };
  return {
    store,
    teams,
    run,
    /** What the developer answers when asked to confirm a fingerprint. */
    answer(value: boolean) {
      answer = value;
    },
    request: () => printed(/blether-device:\S+/, "device", "request"),
    add: (request: string, ...flags: string[]) =>
      printed(/blether-grant:\S+/, "device", "add", request, ...flags),
    invite: (team: string) => printed(/blether(\+ws)?:\/\/\S+/, "invite", team),
    devices: () => verifyIdentityLog(store.load()!.identity).devices.length,
    /** An MCP session for one of this developer's agents in `team`. */
    async session(team: string, agent: string) {
      const record = teams.get(team)!;
      const connection = await RelayConnection.connect(
        record.relayUrl,
        store.load()!,
        { scope: { team: record.id, agent } },
      );
      const client = new Client({ name: agent, version: "0.0.0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await createBridgeServer(connection).connect(b);
      await client.connect(a);
      const call = async (tool: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name: tool, arguments: args });
        return (result.content as { text: string }[])[0]?.text ?? "";
      };
      return {
        call,
        close: async () => {
          await client.close();
          await connection.close();
        },
      };
    },
  };
}

describe("adding a device through the blether CLI", () => {
  let relay: Relay;
  let root: string;
  let desktop: ReturnType<typeof device>;
  let laptop: ReturnType<typeof device>;
  let carol: ReturnType<typeof device>;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-devices-"));
    desktop = device(root, "kev-desktop");
    laptop = device(root, "kev-laptop");
    carol = device(root, "carol");
    await desktop.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await desktop.run("team", "create", "backend", "--relay", relay.url);
    await carol.run("join", await desktop.invite("backend"));
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("pairs a new device, which can then act as the developer's agents", async () => {
    const request = await laptop.request();
    const grant = await desktop.add(request, "--label", "laptop");
    const accepted = await laptop.run("device", "accept", grant);

    expect(accepted).toMatchObject({ code: 0 });
    expect(accepted.out).toContain("Teams: backend");
    expect(laptop.devices()).toBe(2);

    const web = await laptop.session("backend", "web");
    const api = await carol.session("backend", "api");
    cleanups.push(web.close, api.close);
    await web.call("send_message", { to: "api", body: "from Kev's laptop" });
    await expect
      .poll(() => api.call("read_mailbox"))
      .toContain("from Kev's laptop");

    const members = await carol.run("team", "members", "backend");
    expect(members.out).toBe("Team backend:\n  Kev (Team Admin)\n  Carol");
  });

  it("lists the identity's devices", async () => {
    await laptop.run(
      "device",
      "accept",
      await desktop.add(await laptop.request(), "--label", "laptop"),
    );

    const listed = (await laptop.run("device", "list")).out.split("\n");

    expect(listed[0]).toBe("Devices for Kev:");
    expect(listed[1]).toContain("first device");
    expect(listed[2]).toContain("laptop");
    expect(listed[2]).toContain("(this device)");
  });

  it("adds nothing if the developer doesn't confirm the fingerprint", async () => {
    const request = await laptop.request();
    desktop.answer(false);

    const result = await desktop.run("device", "add", request);

    expect(result.code).toBe(1);
    expect(desktop.devices()).toBe(1);
  });

  it("refuses a grant made for a different device", async () => {
    const elsewhere = device(root, "kev-tablet");
    const grant = await desktop.add(await elsewhere.request());
    await laptop.request();

    const result = await laptop.run("device", "accept", grant);

    expect(result.code).toBe(1);
    expect(result.err).toContain("doesn't include this device");
  });

  it("brings an older device up to date with devices added elsewhere", async () => {
    await laptop.run(
      "device",
      "accept",
      await desktop.add(await laptop.request()),
    );
    // The laptop connects once, so the relay learns about it.
    await laptop.run("team", "members", "backend");
    const phone = device(root, "kev-phone");
    await phone.run(
      "device",
      "accept",
      await laptop.add(await phone.request()),
    );
    await phone.run("team", "members", "backend");
    expect(desktop.devices()).toBe(2);

    await desktop.run("team", "members", "backend");

    expect(desktop.devices()).toBe(3);
  });

  it("explains when a device can't request to be added", async () => {
    const result = await desktop.run("device", "request");

    expect(result.code).toBe(1);
    expect(result.err).toContain("already has a Blether identity");
  });
});
