import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("adding a device through the blether CLI", () => {
  let relay: Relay;
  let root: string;
  let desktop: Device;
  let laptop: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-devices-"));
    desktop = device(root, "kev-desktop");
    laptop = device(root, "kev-laptop");
    carol = device(root, "carol");
    await desktop.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await desktop.run("team", "create", "backend", "--relay", relay.url);
    await carol.run("join", await desktop.invite("backend"));
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("pairs a new device, which can then act as the developer's agents", async () => {
    const request = await laptop.request();
    const grant = await desktop.add(request, "--label", "laptop");
    const accepted = await laptop.run("device", "accept", grant);

    expect(accepted).toMatchObject({ code: 0 });
    expect(accepted.out).toContain("Teams: backend");
    expect(laptop.devices()).toBe(2);

    await laptop.run("agent", "create", "backend", "web");
    await carol.run("agent", "create", "backend", "api");
    const web = await laptop.session("backend", "web");
    const api = await carol.session("backend", "api");
    cleanups.push(web.close, api.close);
    await web.call("send_message", { to: "api", body: "from Kev's laptop" });
    await expect
      .poll(() => api.call("read_mailbox"))
      .toContain("from Kev's laptop");

    const members = await carol.run("team", "members", "backend");
    expect(members.out).toBe("Team backend:\n  Kev (Team Admin)\n  Carol");
  });

  it("lists the identity's devices", async () => {
    await laptop.run(
      "device",
      "accept",
      await desktop.add(await laptop.request(), "--label", "laptop"),
    );

    const listed = (await laptop.run("device", "list")).out.split("\n");

    expect(listed[0]).toBe("Devices for Kev:");
    expect(listed[1]).toContain("first device");
    expect(listed[2]).toContain("laptop");
    expect(listed[2]).toContain("(this device)");
  });

  it("adds nothing if the developer doesn't confirm the fingerprint", async () => {
    const request = await laptop.request();
    desktop.answer(false);

    const result = await desktop.run("device", "add", request);

    expect(result.code).toBe(1);
    expect(desktop.devices()).toBe(1);
  });

  it("refuses a grant made for a different device", async () => {
    const elsewhere = device(root, "kev-tablet");
    const grant = await desktop.add(await elsewhere.request());
    await laptop.request();

    const result = await laptop.run("device", "accept", grant);

    expect(result.code).toBe(1);
    expect(result.err).toContain("doesn't include this device");
  });

  it("brings an older device up to date with devices added elsewhere", async () => {
    await laptop.run(
      "device",
      "accept",
      await desktop.add(await laptop.request()),
    );
    // The laptop connects once, so the relay learns about it.
    await laptop.run("team", "members", "backend");
    const phone = device(root, "kev-phone");
    await phone.run(
      "device",
      "accept",
      await laptop.add(await phone.request()),
    );
    await phone.run("team", "members", "backend");
    expect(desktop.devices()).toBe(2);

    await desktop.run("team", "members", "backend");

    expect(desktop.devices()).toBe(3);
  });

  it("explains when a device can't request to be added", async () => {
    const result = await desktop.run("device", "request");

    expect(result.code).toBe(1);
    expect(result.err).toContain("already has a Blether identity");
  });
});
