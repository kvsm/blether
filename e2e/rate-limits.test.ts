import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyStore, type ApprovalPolicy } from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

/** Free policy with small limits, so tests reach them quickly. */
const TIGHT: ApprovalPolicy = {
  outgoing: "free",
  incoming: "free",
  limits: { perAgent: 5, perRecipient: 3, windowMinutes: 10 },
};

describe("sending limits", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-limits-"));
    kev = device(root, "kev");
    carol = device(root, "carol");
    await kev.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await carol.run("join", await kev.invite("backend"));
    for (const agent of ["web", "docs", "infra"]) {
      await kev.run("agent", "create", "backend", agent);
    }
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

  it("stops two agents trading replies, and both developers hear about it", async () => {
    const web = await session(kev, "web", { policy: TIGHT });
    const api = await session(carol, "api", { policy: TIGHT });

    const results: string[] = [];
    for (let round = 0; round < 4; round++) {
      results.push(
        await web.call("send_message", { to: "api", body: `ping ${round}` }),
        await api.call("send_message", { to: "web", body: `pong ${round}` }),
      );
    }

    const refused = results.filter((r) => r.startsWith("Not sent"));
    expect(refused).toHaveLength(2);
    expect(refused[0]).toContain("web has sent 3 messages to api");
    expect(refused[1]).toContain("api has sent 3 messages to web");
    for (const r of refused) {
      expect(r).toContain(
        "tell your developer; only they can let more through",
      );
    }
  });

  it("limits an agent's total sends across recipients", async () => {
    const web = await session(kev, "web", { policy: TIGHT });

    const recipients = ["api", "docs", "infra", "api", "docs", "infra"];
    const results: string[] = [];
    for (const to of recipients) {
      results.push(await web.call("send_message", { to, body: "hello" }));
    }

    expect(results.slice(0, 5).every((r) => !r.startsWith("Not sent"))).toBe(
      true,
    );
    expect(results[5]).toContain(
      "web has sent 5 messages in the last 10 minutes",
    );
  });

  it("lets the developer let more through when the host can ask", async () => {
    const web = await session(kev, "web", {
      policy: TIGHT,
      client: { capabilities: { elicitation: {} } },
    });
    const prompts: string[] = [];
    web.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message);
      return { action: "accept", content: { send: true } };
    });

    for (let i = 0; i < 4; i++) {
      await web.call("send_message", { to: "api", body: `update ${i}` });
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      "⚠ web has sent 3 messages to api in the last 10 minutes. This may be a loop between agents.",
    );
  });

  it("counts again once the window has passed", async () => {
    let clock = new Date("2026-10-01T12:00:00Z");
    const web = await session(kev, "web", { policy: TIGHT, now: () => clock });
    for (let i = 0; i < 3; i++) {
      await web.call("send_message", { to: "api", body: `burst ${i}` });
    }
    expect(
      await web.call("send_message", { to: "api", body: "one more" }),
    ).toMatch(/^Not sent/);

    clock = new Date(clock.getTime() + 11 * 60_000);

    expect(
      await web.call("send_message", { to: "api", body: "later" }),
    ).not.toMatch(/^Not sent/);
  });

  it("skips hold notices once the sender has had too many", async () => {
    // Only Carol's api has tight limits; Kev's web can keep sending.
    const web = await session(kev, "web");
    for (let i = 0; i < 3; i++) {
      await web.call("send_message", { to: "api", body: `request ${i}` });
    }
    const api = await session(carol, "api", { policy: TIGHT });
    const ids = [
      ...(await api.call("read_mailbox")).matchAll(/<message id="([^"]+)"/g),
    ].map((m) => m[1]!);

    const results: string[] = [];
    for (const id of ids) {
      results.push(
        await api.call("escalate", { message_id: id, question: "Do it?" }),
      );
    }

    expect(results.slice(0, 3).every((r) => r.includes("has been told"))).toBe(
      true,
    );
    // A fourth escalation would be over the per-recipient limit of 3.
    await web.call("send_message", { to: "api", body: "request 3" });
    const fourth = /<message id="([^"]+)"/.exec(
      await api.call("read_mailbox"),
    )![1]!;
    expect(
      await api.call("escalate", { message_id: fourth, question: "Do it?" }),
    ).toContain("Didn't tell web: api has sent 3 messages to web");
  });

  it("can be configured with blether policy set", async () => {
    expect(
      await kev.run(
        "policy",
        "set",
        "--limit-per-recipient",
        "20",
        "--limit-window",
        "5",
      ),
    ).toMatchObject({ code: 0 });

    expect(new PolicyStore(kev.store.home).load().limits).toEqual({
      perAgent: 30,
      perRecipient: 20,
      windowMinutes: 5,
    });
    expect((await kev.run("policy")).out).toContain(
      "Limits:   30 messages per agent and 20 to any one agent, per 5 minutes",
    );
    expect(
      (await kev.run("policy", "set", "--limit-per-agent", "0")).err,
    ).toContain("--limit-per-agent must be a whole number, 1 or more.");
  });
});
