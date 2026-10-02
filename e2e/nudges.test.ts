import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAILBOX_URI } from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

/** For agents without push delivery: every way Blether tells them mail is waiting. */
describe("unread reminders", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-nudges-"));
    kev = device(root, "kev");
    carol = device(root, "carol");
    await kev.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await carol.run("join", await kev.invite("backend"));
    await kev.run("agent", "create", "backend", "web");
    await kev.run("agent", "create", "backend", "docs");
    await carol.run("agent", "create", "backend", "api");
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = async (who: Device, agent: string) => {
    const s = await who.session("backend", agent);
    cleanups.push(s.close);
    return s;
  };

  it("adds an unread summary to every other tool result until the mail is read", async () => {
    const api = await session(carol, "api");
    const web = await session(kev, "web");
    const docs = await session(kev, "docs");
    await web.call("send_message", { to: "api", body: "one" });
    await docs.call("send_message", { to: "api", body: "two" });

    await expect
      .poll(() => api.call("list_agents"))
      .toContain("📬 2 unread (web, docs). Call read_mailbox to read them.");

    const mailbox = await api.call("read_mailbox");
    expect(mailbox).not.toContain("📬");
    expect(await api.call("list_agents")).not.toContain("📬");
  });

  it("shows the mailbox as a resource, without marking anything read", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", { to: "api", body: "peek at me" });
    const api = await session(carol, "api");

    const read = async () => {
      const { contents } = await api.client.readResource({ uri: MAILBOX_URI });
      return (contents[0] as { text: string }).text;
    };
    await expect
      .poll(read)
      .toBe("1 unread from web. Call read_mailbox to read them.");

    expect(await api.call("read_mailbox")).toContain("peek at me");
    expect(await read()).toBe("No unread messages.");
  });

  it("tells a host that subscribes to the mailbox when mail arrives", async () => {
    const api = await session(carol, "api");
    const updates: string[] = [];
    api.client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      ({ params }) => {
        updates.push(params.uri);
      },
    );
    await api.client.subscribeResource({ uri: MAILBOX_URI });

    const web = await session(kev, "web");
    await web.call("send_message", { to: "api", body: "ding" });

    await expect.poll(() => updates).toEqual([MAILBOX_URI]);
  });

  it("only tells hosts that subscribed", async () => {
    const api = await session(carol, "api");
    const updates: string[] = [];
    api.client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      ({ params }) => {
        updates.push(params.uri);
      },
    );

    const web = await session(kev, "web");
    await web.call("send_message", { to: "api", body: "ding" });
    await expect.poll(() => api.call("list_agents")).toContain("📬 1 unread");

    expect(updates).toEqual([]);
  });

  it("tells agents when to check their mailbox", async () => {
    const api = await session(carol, "api");

    expect(api.client.getInstructions()).toContain(
      "before starting a task and before committing or pushing",
    );
  });
});
