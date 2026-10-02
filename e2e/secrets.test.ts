import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanForSecrets,
  type ApprovalPolicy,
  type SecretScanner,
} from "@blether/bridge";
import { startRelay, type Relay } from "@blether/relay";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

/**
 * A stand-in for secretlint that flags the word CANARY, so these tests
 * exercise the bridge's handling of findings without containing anything
 * that looks like a real secret. Detection itself is secretlint's, covered
 * by its own tests.
 */
const canaryScanner: SecretScanner = async (text) =>
  text
    .split("\n")
    .flatMap((line, i) =>
      line.includes("CANARY")
        ? [{ rule: "canary", message: "found a CANARY ****", line: i + 1 }]
        : [],
    );

const FREE: ApprovalPolicy = { outgoing: "free", incoming: "free" };

describe("secret check on outgoing messages", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-secrets-"));
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

  /** Kev's web under a free policy, in a host that answers prompts with `approve` (or can't ask, if undefined). */
  const web = async (approve?: boolean) => {
    const session = await kev.session("backend", "web", {
      policy: FREE,
      scanSecrets: canaryScanner,
      ...(approve === undefined
        ? {}
        : { client: { capabilities: { elicitation: {} } } }),
    });
    cleanups.push(session.close);
    const prompts: string[] = [];
    if (approve !== undefined) {
      session.client.setRequestHandler(ElicitRequestSchema, async (request) => {
        prompts.push(request.params.message);
        return approve
          ? { action: "accept", content: { send: true } }
          : { action: "decline" };
      });
    }
    return { ...session, prompts };
  };

  const carolsMailbox = async () => {
    const api = await carol.session("backend", "api");
    const mailbox = await api.call("read_mailbox");
    await api.close();
    return mailbox;
  };

  it("asks the developer about a possible secret even when the policy sends freely", async () => {
    const session = await web(true);

    const result = await session.call("send_message", {
      to: "api",
      body: "Config:\nkey = CANARY",
    });

    expect(result).toMatch(/^Queued/);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain(
      "⚠ This looks like it contains a secret",
    );
    expect(session.prompts[0]).toContain("line 2: found a CANARY ****");
    expect(await carolsMailbox()).toContain("key = CANARY");
  });

  it("sends nothing if the developer declines", async () => {
    const session = await web(false);

    const result = await session.call("send_message", {
      to: "api",
      body: "key = CANARY",
    });

    expect(result).toBe("Not sent: your developer didn't approve it.");
    expect(await carolsMailbox()).toBe("No unread messages.");
  });

  it("refuses to send a possible secret when the host can't ask the developer", async () => {
    const session = await web();

    const result = await session.call("send_message", {
      to: "api",
      body: "key = CANARY",
    });

    expect(result).toContain("only your developer can decide to send that");
    expect(result).toContain("line 1: found a CANARY ****");
    expect(await carolsMailbox()).toBe("No unread messages.");
  });

  it("doesn't ask about ordinary messages under a free policy", async () => {
    const session = await web(true);

    await session.call("send_message", { to: "api", body: "nothing to see" });

    expect(session.prompts).toEqual([]);
  });

  it("uses secretlint by default, which passes ordinary text", async () => {
    expect(
      await scanForSecrets("The /users response is changing on Friday."),
    ).toEqual([]);
  });
});
