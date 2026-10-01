import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type Relay } from "@blether/relay";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("messages to a role or the whole team", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-broadcast-"));
    kev = device(root, "kev");
    carol = device(root, "carol");
    await kev.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await kev.run("team", "create", "product", "--relay", relay.url);
    await carol.run("join", await kev.invite("product"));
    await kev.run("role", "add", "product", "frontend");
    await kev.run("role", "add", "product", "backend");
    await kev.run("role", "add", "product", "design");
    await kev.run("agent", "create", "product", "web", "--role", "frontend");
    await kev.run("agent", "create", "product", "docs");
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

  const mailboxOf = async (who: Device, agent: string) => {
    const s = await who.session("product", agent);
    const mailbox = await s.call("read_mailbox");
    await s.close();
    return mailbox;
  };

  it("sends a copy to every agent holding a role, and to no one else", async () => {
    const web = await session(kev, "web");

    const result = await web.call("send_message", {
      role: "backend",
      body: "The /users response is changing on Friday.",
    });

    expect(result).toMatch(/^Sent to every agent with the backend role:/);
    expect(result).toMatch(/- api: queued/);
    expect(result).toMatch(/- ops: queued/);
    for (const agent of ["api", "ops"]) {
      const mailbox = await mailboxOf(carol, agent);
      expect(mailbox).toContain('to_role="backend"');
      expect(mailbox).toContain("The /users response is changing on Friday.");
    }
    expect(await mailboxOf(kev, "docs")).toBe("No unread messages.");
  });

  it("sends a broadcast to every other agent in the team", async () => {
    const web = await session(kev, "web");

    const result = await web.call("send_message", {
      everyone: true,
      body: "Deploy freeze starts at 5pm.",
    });

    expect(result).toMatch(/^Sent to everyone in the team:/);
    for (const [who, agent] of [
      [kev, "docs"],
      [carol, "api"],
      [carol, "ops"],
    ] as const) {
      expect(await mailboxOf(who, agent)).toContain('to="everyone"');
    }
    expect(await web.call("read_mailbox")).toBe("No unread messages.");
  });

  it("gives each copy its own delivery status", async () => {
    const web = await session(kev, "web");
    await web.call("send_message", { role: "backend", body: "status?" });
    await mailboxOf(carol, "api");

    const sent = await web.call("sent_messages");

    expect(sent).toMatch(/to api .*: read/);
    expect(sent).toMatch(/to ops .*: queued/);
  });

  it("never sends a role message back to the sender, even if it holds the role", async () => {
    await kev.run("agent", "roles", "product", "web", "--role", "backend");
    const web = await session(kev, "web");

    const result = await web.call("send_message", {
      role: "backend",
      body: "hello backend",
    });

    expect(result).not.toContain("- web:");
    expect(await web.call("read_mailbox")).toBe("No unread messages.");
  });

  it("refuses a role nobody else holds, or one the team doesn't have", async () => {
    const web = await session(kev, "web");

    expect(
      await web.call("send_message", { role: "design", body: "anyone?" }),
    ).toBe("Not sent: No other agent holds the design role.");
    expect(
      await web.call("send_message", { role: "qa", body: "anyone?" }),
    ).toBe(
      "Not sent: This team has no qa role. Its roles are: frontend, backend, design.",
    );
  });

  it("needs exactly one of to, role or everyone", async () => {
    const web = await session(kev, "web");

    const exactlyOne =
      "Not sent: give exactly one of to, role or everyone (or reply_to, to reply).";
    expect(
      await web.call("send_message", { to: "api", role: "backend", body: "x" }),
    ).toBe(exactlyOne);
    expect(await web.call("send_message", { body: "x" })).toBe(exactlyOne);
  });

  it("asks once for the whole fan-out under ask-others when any recipient is someone else's", async () => {
    const web = await session(kev, "web", {
      policy: { outgoing: "ask-others", incoming: "ask" },
      client: { capabilities: { elicitation: {} } },
    });
    const prompts: string[] = [];
    web.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message);
      return { action: "accept", content: { send: true } };
    });

    await web.call("send_message", { everyone: true, body: "heads up" });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      "wants to send this to everyone in the team (docs, api, ops)",
    );
  });

  it("counts every copy towards the sending limits", async () => {
    const web = await session(kev, "web", {
      policy: {
        outgoing: "free",
        incoming: "free",
        limits: {
          perAgent: 5,
          perRecipient: 10,
          perThread: 10,
          windowMinutes: 10,
        },
      },
    });

    await web.call("send_message", { everyone: true, body: "one" });

    expect(
      await web.call("send_message", { everyone: true, body: "two" }),
    ).toContain("this would send 3 more");
  });
});
