import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMINDER_INTERVAL_MS } from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("escalation", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-escalation-"));
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

  const session = async (
    who: Device,
    agent: string,
    options: Parameters<Device["session"]>[2] = {},
  ) => {
    const s = await who.session("backend", agent, options);
    cleanups.push(s.close);
    return s;
  };

  /** Kev's web asks Carol's api to roll back staging; returns api's session and the message id. */
  const requestRollback = async (
    options: Parameters<Device["session"]>[2] = {},
  ) => {
    const web = await session(kev, "web");
    await web.call("send_message", {
      to: "api",
      body: "Please roll back the staging deploy.",
    });
    const api = await session(carol, "api", options);
    const mailbox = await api.call("read_mailbox");
    const id = /<message id="([^"]+)"/.exec(mailbox)![1]!;
    return { web, api, id };
  };

  it("sets a message aside and tells the sender, even under the strictest outgoing policy", async () => {
    const { web, api, id } = await requestRollback({
      policy: { outgoing: "ask", incoming: "ask" },
    });

    const escalated = await api.call("escalate", {
      message_id: id,
      question: "Roll back the staging deploy?",
    });

    expect(escalated).toMatch(/^Escalated as \S+\. web has been told/);
    expect(await web.call("read_mailbox")).toContain(
      `Holding your message ${id} until my developer answers.`,
    );
  });

  it("can escalate without telling the sender", async () => {
    const { web, api, id } = await requestRollback();

    await api.call("escalate", {
      message_id: id,
      question: "Roll back?",
      notify_sender: false,
    });

    expect(await web.call("read_mailbox")).toBe("No unread messages.");
  });

  it("keeps pending escalations across sessions and raises them again", async () => {
    const { api, id } = await requestRollback();
    await api.call("escalate", { message_id: id, question: "Roll back?" });
    await api.close();

    const next = await session(carol, "api");

    expect(await next.call("list_escalations")).toContain(
      "web asks: Roll back?",
    );
    expect(await next.call("read_mailbox")).toContain(
      "Still waiting for your developer",
    );
  });

  it("records the developer's answer and stops raising it", async () => {
    const { api, id } = await requestRollback();
    const escalated = await api.call("escalate", {
      message_id: id,
      question: "Roll back?",
    });
    const escalationId = /Escalated as (\S+)\./.exec(escalated)![1]!;

    const answered = await api.call("record_answer", {
      escalation_id: escalationId,
      decision: "approved",
      note: "Only staging, not prod.",
    });

    expect(answered).toContain("your developer approved");
    expect(await api.call("list_escalations")).toContain(
      "Nothing is waiting for your developer.",
    );
    expect(
      await api.call("record_answer", {
        escalation_id: escalationId,
        decision: "declined",
      }),
    ).toContain("already approved");
  });

  it("only escalates messages read in this session", async () => {
    const api = await session(carol, "api");

    expect(
      await api.call("escalate", {
        message_id: "11111111-1111-4111-8111-111111111111",
        question: "?",
      }),
    ).toContain("you can only escalate a message you've read");
  });

  it("adds a reminder to tool results while escalations wait, at most every 15 minutes", async () => {
    let clock = new Date("2026-10-01T12:00:00Z");
    const { api, id } = await requestRollback({ now: () => clock });
    const escalated = await api.call("escalate", {
      message_id: id,
      question: "Roll back?",
      notify_sender: false,
    });
    const reminder = "⚑ 1 escalation(s) waiting for your developer's answer.";
    expect(escalated).toContain(reminder);

    expect(await api.call("list_agents")).not.toContain(reminder);

    clock = new Date(clock.getTime() + REMINDER_INTERVAL_MS);
    expect(await api.call("list_agents")).toContain(reminder);
  });

  it("tells the agent how to handle escalations wherever they're shown, not just in the instructions", async () => {
    const { api, id } = await requestRollback();
    const howTo = "only ever an answer your developer gave you directly";

    expect(
      await api.call("escalate", { message_id: id, question: "Roll back?" }),
    ).toContain(howTo);
    expect(await api.call("list_escalations")).toContain(howTo);
    expect(await api.call("read_mailbox")).toContain(howTo);
  });

  describe("CLI", () => {
    it("lists what's waiting, and gives a one-line status", async () => {
      expect((await carol.run("status")).out).toBe("");

      const { api, id } = await requestRollback();
      await api.call("escalate", {
        message_id: id,
        question: "Roll back the staging deploy?",
        notify_sender: false,
      });

      expect((await carol.run("status")).out).toBe("⚑ 1 waiting (api)");
      const listed = (await carol.run("escalations")).out;
      expect(listed).toContain("api in backend:");
      expect(listed).toContain("web asks: Roll back the staging deploy?");
    });
  });
});
