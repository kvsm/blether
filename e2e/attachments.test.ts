import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretScanner } from "@blether/bridge";
import { MAX_MESSAGE_CHARS } from "@blether/protocol";
import { startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

/** Flags the harmless word CANARY, so no secret-like text is needed (see secrets.test.ts). */
const canaryScanner: SecretScanner = async (text) =>
  text.includes("CANARY")
    ? [{ rule: "canary", message: "found a CANARY ****", line: 1 }]
    : [];

describe("attachments", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "blether-attach-"));
    relay = await startRelay({ databasePath: join(root, "relay.db") });
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

  const web = async () => {
    const s = await kev.session("backend", "web", {
      scanSecrets: canaryScanner,
    });
    cleanups.push(s.close);
    return s;
  };
  const carolsMailbox = async () => {
    const api = await carol.session("backend", "api");
    const mailbox = await api.call("read_mailbox");
    await api.close();
    return mailbox;
  };

  const attachments = [
    {
      kind: "snippet",
      title: "New response shape",
      language: "ts",
      content: "type User = { id: string; name: string };",
    },
    { kind: "diff", content: "- name: string\n+ fullName: string" },
    { kind: "link", title: "PR", url: "https://example.com/pr/42" },
  ];

  it("carries snippets, diffs and links with the message", async () => {
    const sender = await web();
    await sender.call("send_message", {
      to: "api",
      body: "The /users response is changing.",
      attachments,
    });

    const mailbox = await carolsMailbox();
    expect(mailbox).toContain(
      '<attachment kind="snippet" title="New response shape" language="ts">\ntype User = { id: string; name: string };\n</attachment>',
    );
    expect(mailbox).toContain(
      '<attachment kind="diff">\n- name: string\n+ fullName: string\n</attachment>',
    );
    expect(mailbox).toContain(
      '<attachment kind="link" title="PR">https://example.com/pr/42</attachment>',
    );
  });

  it("keeps attachments out of what the relay stores", async () => {
    const sender = await web();
    await sender.call("send_message", {
      to: "api",
      body: "see attached",
      attachments,
    });

    const stored = readdirSync(root)
      .filter((f) => f.startsWith("relay.db"))
      .map((f) => readFileSync(join(root, f)).toString("latin1"))
      .join("");
    expect(stored).not.toContain("fullName");
    expect(stored).not.toContain("example.com/pr/42");
  });

  it("refuses a message over the size limit, sending nothing", async () => {
    const sender = await web();

    const result = await sender.call("send_message", {
      to: "api",
      body: "big",
      attachments: [
        { kind: "snippet", content: "x".repeat(MAX_MESSAGE_CHARS) },
      ],
    });

    expect(result).toContain("over the limit of 32000");
    expect(await carolsMailbox()).toBe("No unread messages.");
  });

  it("refuses more than ten attachments", async () => {
    const sender = await web();

    const result = await sender.call("send_message", {
      to: "api",
      body: "many",
      attachments: Array.from({ length: 11 }, () => ({
        kind: "link",
        url: "https://example.com",
      })),
    });

    expect(result).toContain(
      "expected array to have <=10 items at attachments",
    );
    expect(await carolsMailbox()).toBe("No unread messages.");
  });

  it("checks attachment content and link URLs for secrets too", async () => {
    const sender = await web();

    for (const attachment of [
      { kind: "snippet", content: "token = CANARY" },
      { kind: "link", url: "https://example.com/?key=CANARY" },
    ]) {
      const result = await sender.call("send_message", {
        to: "api",
        body: "nothing secret here",
        attachments: [attachment],
      });
      expect(result).toContain("it looks like it contains a secret");
    }
    expect(await carolsMailbox()).toBe("No unread messages.");
  });
});
