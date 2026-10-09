import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayConnection, RelayError } from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("teams through the blether CLI", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  let mallory: Device;
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
    expect(joined.out).toContain("blether use backend <agent name>");

    const members = await carol.run("team", "members", "backend");
    expect(members.out).toBe("Team backend:\n  Kev (Team Admin)\n  Carol");

    await kev.run("agent", "create", "backend", "web");
    await carol.run("agent", "create", "backend", "api");
    const web = await kev.session("backend", "web");
    const api = await carol.session("backend", "api");
    cleanups.push(web.close, api.close);
    await web.call("send_message", { to: "api", body: "Welcome aboard" });
    await expect
      .poll(() => api.call("read_mailbox"))
      .toContain("Welcome aboard");
  });

  it("asks before creating an invite, and creates none if the developer says no", async () => {
    await kev.run("team", "create", "backend", "--relay", relay.url);
    kev.answer(false);

    const result = await kev.run("invite", "backend");

    expect(result.code).toBe(1);
    expect(result.out).not.toContain("blether+ws://");
    expect(result.err).toContain("No invite created.");
    expect(kev.asked).toEqual([
      expect.stringContaining("Anyone with it can join backend"),
    ]);
  });

  it("shows the team and relay before joining, and joins nothing if the developer says no", async () => {
    await kev.run("team", "create", "backend", "--relay", relay.url);
    const invite = await kev.invite("backend");
    carol.answer(false);

    const declined = await carol.run("join", invite);

    expect(declined.code).toBe(1);
    expect(declined.err).toContain("Not joined.");
    expect(carol.asked).toEqual([
      expect.stringMatching(
        new RegExp(`Join backend.*${relay.url.replace(/^ws:\/\//, "")}`),
      ),
    ]);
    expect((await carol.run("team", "list")).out).not.toContain("backend");

    carol.answer(true);
    expect(await carol.run("join", invite)).toMatchObject({ code: 0 });
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
      scope: { team: record.id, agent: "api" },
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

  it("creates a team under another local name when the team's name is taken", async () => {
    await kev.run("team", "create", "backend", "--relay", relay.url);
    const other = await startRelay();
    cleanups.push(other.close);

    const clash = await kev.run(
      "team",
      "create",
      "backend",
      "--relay",
      other.url,
    );
    expect(clash.code).toBe(1);
    expect(clash.err).toContain("--as");

    const taken = await kev.run(
      "team",
      "create",
      "backend",
      "--relay",
      other.url,
      "--as",
      "backend",
    );
    expect(taken.code).toBe(1);

    const created = await kev.run(
      "team",
      "create",
      "backend",
      "--relay",
      other.url,
      "--as",
      "home-backend",
    );
    expect(created).toMatchObject({ code: 0 });
    expect(created.out).toContain(
      "Created team backend (yours as home-backend)",
    );
    const record = kev.teams.get("home-backend")!;
    expect(record.relayUrl).toBe(other.url);
    expect(record.id).not.toBe(kev.teams.get("backend")!.id);

    expect((await kev.run("team", "members", "home-backend")).out).toBe(
      "Team backend:\n  Kev (Team Admin)",
    );
    expect(
      await kev.run("agent", "create", "home-backend", "web"),
    ).toMatchObject({ code: 0 });
    const invite = await kev.invite("home-backend");
    expect(await carol.run("join", invite)).toMatchObject({ code: 0 });
    expect(carol.teams.get("backend")?.id).toBe(record.id);
  });

  it("refuses to join a team that has a member with the same name, ignoring case", async () => {
    const otherKev = device(root, "other-kev");
    await otherKev.run("init", "--name", "KEV");
    await kev.run("team", "create", "backend", "--relay", relay.url);
    const invite = await kev.invite("backend");

    const result = await otherKev.run("join", invite);

    expect(result.code).toBe(1);
    expect(result.err).toContain("backend already has a member called Kev");
    expect(otherKev.asked).toEqual([]);
    expect(otherKev.teams.get("backend")).toBeUndefined();
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
