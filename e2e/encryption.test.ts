import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("end-to-end encryption", () => {
  let relay: Relay;
  let root: string;
  let databasePath: string;
  let kev: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "blether-e2ee-"));
    databasePath = join(root, "relay.db");
    relay = await startRelay({ databasePath });
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

  /** Everything the relay has written to disk, as text. */
  const relayStorage = () =>
    readdirSync(root)
      .filter((file) => file.startsWith("relay.db"))
      .map((file) => readFileSync(join(root, file)).toString("latin1"))
      .join("");

  it("never gives the relay a message's content", async () => {
    const secret = "the staging password rotates on Friday";
    const web = await kev.session("backend", "web");
    cleanups.push(web.close);

    expect(await web.call("send_message", { to: "api", body: secret })).toMatch(
      /^Queued/,
    );

    expect(relayStorage()).not.toContain("staging password");
    const api = await carol.session("backend", "api");
    cleanups.push(api.close);
    expect(await api.call("read_mailbox")).toContain(secret);
  });

  it("lets the recipient read a message on any of their devices", async () => {
    const laptop = device(root, "carol-laptop");
    await laptop.run(
      "device",
      "accept",
      await carol.add(await laptop.request()),
    );
    // The relay learns about the laptop when it first connects.
    await laptop.run("team", "members", "backend");

    const web = await kev.session("backend", "web");
    cleanups.push(web.close);
    await web.call("send_message", { to: "api", body: "for either device" });

    const api = await laptop.session("backend", "api");
    cleanups.push(api.close);
    expect(await api.call("read_mailbox")).toContain("for either device");
  });

  it("tells a device added after a message was sent to read it on another device", async () => {
    const web = await kev.session("backend", "web");
    cleanups.push(web.close);
    await web.call("send_message", {
      to: "api",
      body: "sent before the laptop",
    });

    const laptop = device(root, "carol-laptop");
    await laptop.run(
      "device",
      "accept",
      await carol.add(await laptop.request()),
    );
    const onLaptop = await laptop.session("backend", "api");
    const mailbox = await onLaptop.call("read_mailbox");
    await onLaptop.close();

    expect(mailbox).toContain("encrypted for another of your devices");
    expect(mailbox).not.toContain("sent before the laptop");

    // It's still unread, so Carol's first device can read it.
    const onDesktop = await carol.session("backend", "api");
    cleanups.push(onDesktop.close);
    expect(await onDesktop.call("read_mailbox")).toContain(
      "sent before the laptop",
    );
  });
});
