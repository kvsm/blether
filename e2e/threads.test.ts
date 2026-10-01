import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("threads", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-threads-"));
    kev = device(root, "kev");
    carol = device(root, "carol");
    await kev.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await kev.run("team", "create", "product", "--relay", relay.url);
    await carol.run("join", await kev.invite("product"));
    await kev.run("role", "add", "product", "backend");
    await kev.run("agent", "create", "product", "web");
    await carol.run("agent", "create", "product", "api", "--role", "backend");
    await carol.run("agent", "create", "product", "ops", "--role", "backend");
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = async (
    who: Device,
    agent: string,
    options: Parameters<Device["session"]>[2] = {},
  ) => {
    const s = await who.session("product", agent, options);
    cleanups.push(s.close);
    return s;
  };

  const idOf = (sent: string) => /(?:message|reply) (\S+) /.exec(sent)![1]!;
  const firstMessage = (mailbox: string) =>
    /<message id="([^"]+)"/.exec(mailbox)![1]!;

  it("sends a reply to the sender, in the same thread, and shows what it answers", async () => {
    const web = await session(kev, "web");
    const api = await session(carol, "api");
    const question = idOf(
      await web.call("send_message", {
        to: "api",
        body: "Is the /users response changing?",
      }),
    );
    const received = firstMessage(await api.call("read_mailbox"));
    expect(received).toBe(question);

    const replied = await api.call("send_message", {
      reply_to: question,
      body: "Yes, on Friday.",
    });
    expect(replied).toMatch(/^Sent reply \S+ to web\./);

    const mailbox = await web.call("read_mailbox");
    expect(mailbox).toContain(`thread="${question}" in_reply_to="${question}"`);
    expect(mailbox).toContain(
      '(In reply to your message to api: "Is the /users response changing?")',
    );
    expect(mailbox).toContain("Yes, on Friday.");
  });

  it("keeps every reply in a chain in the thread of the first message", async () => {
    const web = await session(kev, "web");
    const api = await session(carol, "api");
    const first = idOf(
      await web.call("send_message", { to: "api", body: "one" }),
    );
    await api.call("read_mailbox");
    const second = idOf(
      await api.call("send_message", { reply_to: first, body: "two" }),
    );
    await web.call("read_mailbox");

    await web.call("send_message", { reply_to: second, body: "three" });

    const mailbox = await api.call("read_mailbox");
    expect(mailbox).toContain(`thread="${first}" in_reply_to="${second}"`);
  });

  it("replies to a role message or broadcast go to the sender only, by default", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", { role: "backend", body: "Who owns auth?" });
    const api = await session(carol, "api");
    const id = firstMessage(await api.call("read_mailbox"));

    expect(
      await api.call("send_message", { reply_to: id, body: "I do." }),
    ).toMatch(/to web\./);

    const ops = await session(carol, "ops");
    const opsMailbox = await ops.call("read_mailbox");
    expect(opsMailbox).not.toContain("I do.");
    expect(await web.call("read_mailbox")).toContain("I do.");
  });

  it("lets a reply go to everyone when that's what the agent means", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", { role: "backend", body: "Freeze at 5?" });
    const api = await session(carol, "api");
    const id = firstMessage(await api.call("read_mailbox"));

    expect(
      await api.call("send_message", {
        reply_to: id,
        everyone: true,
        body: "Freeze confirmed for everyone.",
      }),
    ).toMatch(/^Sent to everyone in the team:/);
  });

  it("follows up on the agent's own message to the same recipient", async () => {
    const web = await session(kev, "web");
    const first = idOf(
      await web.call("send_message", { to: "api", body: "Deploying soon." }),
    );

    expect(
      await web.call("send_message", { reply_to: first, body: "Done now." }),
    ).toMatch(/^Queued reply \S+ for api,/);
  });

  it("refuses to reply to a message it doesn't know", async () => {
    const web = await session(kev, "web");

    expect(
      await web.call("send_message", {
        reply_to: "22222222-2222-4222-8222-222222222222",
        body: "?",
      }),
    ).toContain("reply_to must be the id of a message you've read");
  });

  it("remembers sent messages across sessions, so later replies still show what they answer", async () => {
    const firstSession = await session(kev, "web");
    const question = idOf(
      await firstSession.call("send_message", {
        to: "api",
        body: "Remember me?",
      }),
    );
    await firstSession.close();

    const api = await session(carol, "api");
    await api.call("read_mailbox");
    await api.call("send_message", { reply_to: question, body: "Yes." });

    const web = await session(kev, "web");
    expect(await web.call("read_mailbox")).toContain(
      '(In reply to your message to api: "Remember me?")',
    );
  });

  it("limits how many messages an agent sends in one thread", async () => {
    const tight = {
      outgoing: "free",
      incoming: "free",
      limits: {
        perAgent: 30,
        perRecipient: 30,
        perThread: 2,
        windowMinutes: 10,
      },
    } as const;
    const web = await session(kev, "web", { policy: tight });
    const first = idOf(
      await web.call("send_message", { to: "api", body: "start" }),
    );
    await web.call("send_message", { reply_to: first, body: "follow-up 1" });
    await web.call("send_message", { reply_to: first, body: "follow-up 2" });

    expect(
      await web.call("send_message", { reply_to: first, body: "follow-up 3" }),
    ).toContain("messages in this thread");
  });
});
