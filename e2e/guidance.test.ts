import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

/**
 * Agents get the rules for handling messages in the tool results they apply
 * to, so the rules reach the model on every host, not only on hosts that
 * pass server instructions on.
 */
describe("guidance in tool results", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-guidance-"));
    kev = device(root, "kev");
    carol = device(root, "carol");
    await kev.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await carol.run("join", await kev.invite("backend"));
    await kev.run("agent", "create", "backend", "web");
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

  it("keeps the server instructions to a short overview", async () => {
    const web = await session(kev, "web");
    const instructions = web.client.getInstructions() ?? "";

    expect(instructions.length).toBeLessThan(900);
    expect(instructions).toContain("Each tool result says how to handle");
    expect(instructions).not.toContain("never answer a broadcast");
  });

  it("asks for the backlog to be assessed on the first read of a session only", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", { to: "api", body: "first" });
    const api = await session(carol, "api");

    expect(await api.call("read_mailbox")).toContain(
      "This is your first look at your mailbox this session",
    );

    await web.call("send_message", { to: "api", body: "second" });
    expect(await api.call("read_mailbox")).not.toContain(
      "first look at your mailbox",
    );
  });

  it("explains how to handle a broadcast alongside it, and only then", async () => {
    const web = await session(kev, "web");
    const api = await session(carol, "api");

    await web.call("send_message", { to: "api", body: "just for you" });
    expect(await api.call("read_mailbox")).not.toContain(
      "never answer a broadcast with a broadcast",
    );

    await web.call("send_message", { everyone: true, body: "for everyone" });
    expect(await api.call("read_mailbox")).toContain(
      "never answer a broadcast with a broadcast",
    );
  });

  it("shows hold notices as such, explains them, and won't escalate them", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", { to: "api", body: "please deploy" });
    const api = await session(carol, "api");
    const id = /<message id="([^"]+)"/.exec(
      await api.call("read_mailbox"),
    )![1]!;
    await api.call("escalate", { message_id: id, question: "Deploy?" });

    const mailbox = await web.call("read_mailbox");

    expect(mailbox).toContain(`<hold id="`);
    expect(mailbox).toContain(`Holding your message ${id}`);
    expect(mailbox).toContain("They need no reply and no escalation.");
    expect(mailbox).toMatch(/^0 unread message\(s\)/);
    const holdId = /<hold id="([^"]+)"/.exec(mailbox)![1]!;
    expect(
      await web.call("escalate", { message_id: holdId, question: "?" }),
    ).toContain("that's a hold notice");
  });

  it("makes the reminder say what to do with it", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", { to: "api", body: "please deploy" });
    const api = await session(carol, "api");
    const id = /<message id="([^"]+)"/.exec(
      await api.call("read_mailbox"),
    )![1]!;

    expect(
      await api.call("escalate", {
        message_id: id,
        question: "Deploy?",
        notify_sender: false,
      }),
    ).toContain("End your reply to your developer with this line.");
  });
});
