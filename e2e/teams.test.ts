import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileKeyStore,
  RelayConnection,
  RelayError,
  TeamDirectory,
  createBridgeServer,
  runCli,
} from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** One developer's device: their own BLETHER_HOME, driven through the CLI. */
function device(root: string, name: string) {
  const store = new FileKeyStore(join(root, name));
  const teams = new TeamDirectory(store.home);
  let clock: Date | undefined;
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      store,
      teams,
      io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      ...(clock ? { now: () => clock! } : {}),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return {
    store,
    teams,
    run,
    setClock(date: Date) {
      clock = date;
    },
    /** Runs `blether invite` and returns the invite string it printed. */
    async invite(team: string, ...flags: string[]) {
      const result = await run("invite", team, ...flags);
      if (result.code !== 0) throw new Error(result.err);
      const link = /blether(\+ws)?:\/\/\S+/.exec(result.out)?.[0];
      if (!link) throw new Error(`no invite in: ${result.out}`);
      return link;
    },
    /** An MCP session for one of this developer's agents in `team`. */
    async session(team: string, agent: string) {
      const record = teams.get(team)!;
      const connection = await RelayConnection.connect(
        record.relayUrl,
        store.load()!,
        { team: record.id, agent },
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

describe("teams through the blether CLI", () => {
  let relay: Relay;
  let root: string;
  let kev: ReturnType<typeof device>;
  let carol: ReturnType<typeof device>;
  let mallory: ReturnType<typeof device>;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-teams-"));
    kev = device(root, "kev");
    carol = device(root, "carol");
    mallory = device(root, "mallory");
    await kev.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await mallory.run("init", "--name", "Mallory");
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a team, invites a teammate, and lets their agents message each other", async () => {
    const created = await kev.run(
      "team",
      "create",
      "backend",
      "--relay",
      relay.url,
    );
    expect(created).toMatchObject({ code: 0 });
    expect(created.out).toContain("You are its Team Admin");

    const invite = await kev.invite("backend");
    expect(invite.startsWith("blether+ws://")).toBe(true);

    const joined = await carol.run("join", invite);
    expect(joined).toMatchObject({ code: 0 });
    expect(joined.out).toContain("BLETHER_TEAM=backend");

    const members = await carol.run("team", "members", "backend");
    expect(members.out).toBe("Team backend:\n  Kev (Team Admin)\n  Carol");

    const web = await kev.session("backend", "web");
    const api = await carol.session("backend", "api");
    cleanups.push(web.close, api.close);
    await web.call("send_message", { to: "api", body: "Welcome aboard" });
    await expect
      .poll(() => api.call("read_mailbox"))
      .toContain("Welcome aboard");
  });

  it("lists the teams a developer belongs to", async () => {
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await kev.run("team", "create", "frontend", "--relay", relay.url);

    expect((await kev.run("team", "list")).out).toBe(
      `backend  ${relay.url}\nfrontend  ${relay.url}`,
    );
    expect((await carol.run("team", "list")).out).toBe(
      "You aren't in any teams yet.",
    );
  });

  it("lets an invite be used only once", async () => {
    await kev.run("team", "create", "backend", "--relay", relay.url);
    const invite = await kev.invite("backend");
    await carol.run("join", invite);

    const second = await mallory.run("join", invite);

    expect(second.code).toBe(1);
    expect(second.err).toContain("has been used");
  });

  it("refuses an invite after it has expired", async () => {
    await kev.run("team", "create", "backend", "--relay", relay.url);
    const invite = await kev.invite("backend", "--hours", "1");
    carol.setClock(new Date(Date.now() + 2 * 3_600_000));

    const result = await carol.run("join", invite);

    expect(result.code).toBe(1);
    expect(result.err).toContain("expired");
  });

  it("refuses a revoked invite", async () => {
    await kev.run("team", "create", "backend", "--relay", relay.url);
    const invite = await kev.invite("backend");
    const inviteId = invite.split("/")[4]!.split("#")[0]!;
    expect(await kev.run("revoke-invite", "backend", inviteId)).toMatchObject({
      code: 0,
    });

    const result = await carol.run("join", invite);

    expect(result.code).toBe(1);
    expect(result.err).toContain("revoked");
  });

  it("refuses an invite whose secret has been tampered with", async () => {
    await kev.run("team", "create", "backend", "--relay", relay.url);
    const invite = await kev.invite("backend");
    const forged = invite.replace(/#.*/, `#${"A".repeat(43)}`);

    const result = await mallory.run("join", forged);

    expect(result.code).toBe(1);
    expect(result.err).toContain("isn't signed by the invite key");
  });

  it("keeps non-members' agents off the team", async () => {
    await kev.run("team", "create", "backend", "--relay", relay.url);
    const record = kev.teams.get("backend")!;

    const attempt = RelayConnection.connect(relay.url, mallory.store.load()!, {
      team: record.id,
      agent: "api",
    });

    await expect(attempt).rejects.toMatchObject({ code: "not-a-member" });
    await expect(attempt).rejects.toBeInstanceOf(RelayError);
  });

  it("asks for another local name when the team's name is taken", async () => {
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await carol.run("team", "create", "backend", "--relay", relay.url);
    const invite = await kev.invite("backend");

    const clash = await carol.run("join", invite);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain("--as");

    expect(
      await carol.run("join", invite, "--as", "kevs-backend"),
    ).toMatchObject({ code: 0 });
    expect(carol.teams.get("kevs-backend")?.id).toBe(
      kev.teams.get("backend")?.id,
    );
  });

  it("explains what to do when a command is missing something", async () => {
    expect((await kev.run("team", "create", "backend")).err).toContain(
      "--relay",
    );
    expect((await kev.run("invite", "nope")).err).toContain(
      "blether team list",
    );
    expect((await carol.run("join", "not-an-invite")).err).toContain(
      "isn't a Blether invite",
    );
  });
});
