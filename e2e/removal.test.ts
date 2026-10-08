import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("removing developers and agents", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  let dan: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-removal-"));
    kev = device(root, "kev");
    carol = device(root, "carol");
    dan = device(root, "dan");
    await kev.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await dan.run("init", "--name", "Dan");
    await kev.run("team", "create", "product", "--relay", relay.url);
    await carol.run("join", await kev.invite("product"));
    await dan.run("join", await kev.invite("product"));
    await kev.run("agent", "create", "product", "web");
    await carol.run("agent", "create", "product", "api");
    await dan.run("agent", "create", "product", "ops");
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = async (who: Device, agent: string) => {
    const s = await who.session("product", agent);
    cleanups.push(s.close);
    return s;
  };

  it("tells the sender their unread message was lost, with its text, when the recipient is deleted", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", {
      to: "api",
      body: "Can you review PR 42?",
    });
    await web.close();

    expect(await carol.run("agent", "delete", "product", "api")).toMatchObject({
      code: 0,
    });

    const again = await session(kev, "web");
    const mailbox = await again.call("read_mailbox");
    expect(mailbox).toContain('<lost id="');
    expect(mailbox).toContain('to="api"');
    expect(mailbox).toContain('Your message was: "Can you review PR 42?"');
    expect(await again.call("sent_messages")).toMatch(/to api .*: lost/);
    expect(await again.call("read_mailbox")).toBe("No unread messages.");
  });

  it("tells a sender who's online straight away", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", { to: "api", body: "ping" });

    await carol.run("agent", "delete", "product", "api");

    await expect.poll(() => web.call("read_mailbox")).toContain('<lost id="');
  });

  it("closes a deleted agent's session, and the agent can't connect again", async () => {
    const api = await session(carol, "api");
    await carol.run("agent", "delete", "product", "api");

    await expect.poll(() => api.call("list_agents")).toContain("Couldn't");
    await expect(carol.session("product", "api")).rejects.toMatchObject({
      code: "unknown-agent",
    });
  });

  it("shows an agent created with a deleted agent's name as a replacement", async () => {
    await carol.run("agent", "delete", "product", "api");
    await dan.run("agent", "create", "product", "api");
    const web = await session(kev, "web");

    expect(await web.call("list_agents")).toContain(
      "api (a new agent: an earlier one with this name was deleted): Dan's agent",
    );
  });

  it("doesn't give a replacement agent the deleted agent's messages", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", { to: "api", body: "for the old api" });
    await carol.run("agent", "delete", "product", "api");
    await dan.run("agent", "create", "product", "api");

    const api = await session(dan, "api");

    expect(await api.call("read_mailbox")).toBe("No unread messages.");
  });

  it("lets the Team Admin remove a developer, deleting their agents and keeping them out", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", {
      to: "api",
      body: "unread when Carol goes",
    });

    const removed = await kev.run("team", "remove", "product", "Carol");

    expect(removed).toMatchObject({ code: 0 });
    expect(removed.out).toContain("Deleted their agents: api");
    expect((await kev.run("team", "members", "product")).out).not.toContain(
      "Carol",
    );
    await expect(carol.session("product", "api")).rejects.toMatchObject({
      code: "not-a-member",
    });
    await expect
      .poll(() => web.call("read_mailbox"))
      .toContain("unread when Carol goes");
  });

  it("leaves messages a removed developer sent that were already read", async () => {
    const api = await session(carol, "api");
    await api.call("send_message", { to: "ops", body: "from Carol" });
    const ops = await session(dan, "ops");
    expect(await ops.call("read_mailbox")).toContain("from Carol");
    await api.close();

    await kev.run("team", "remove", "product", "Carol");

    expect(await ops.call("sent_messages")).not.toContain("lost");
  });

  it("asks before removing a developer, and removes no one if the Team Admin says no", async () => {
    kev.answer(false);

    const result = await kev.run("team", "remove", "product", "Carol");

    expect(result.code).toBe(1);
    expect(result.err).toContain("Not removed.");
    expect(kev.asked.at(-1)).toContain("Remove Carol from product?");
    expect((await kev.run("team", "members", "product")).out).toContain(
      "Carol",
    );
  });

  it("only lets the Team Admin remove developers, and not themselves", async () => {
    expect((await carol.run("team", "remove", "product", "Dan")).err).toContain(
      "Only the Team Admin",
    );
    expect((await kev.run("team", "remove", "product", "Kev")).err).toContain(
      "can't remove themselves",
    );
  });

  it("only lets an agent's owner or the Team Admin delete it", async () => {
    expect((await dan.run("agent", "delete", "product", "api")).err).toContain(
      "belongs to another developer",
    );
    expect(await kev.run("agent", "delete", "product", "api")).toMatchObject({
      code: 0,
    });
  });
});
