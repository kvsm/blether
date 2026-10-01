import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayConnection } from "@blether/bridge";
import { deviceFingerprint } from "@blether/protocol";
import { startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("revoking a device", () => {
  let relay: Relay;
  let root: string;
  let databasePath: string;
  let desktop: Device;
  let laptop: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "blether-revoke-"));
    databasePath = join(root, "relay.db");
    relay = await startRelay({ databasePath });
    desktop = device(root, "kev-desktop");
    laptop = device(root, "kev-laptop");
    carol = device(root, "carol");
    await desktop.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await desktop.run("team", "create", "product", "--relay", relay.url);
    await carol.run("join", await desktop.invite("product"));
    await laptop.run(
      "device",
      "accept",
      await desktop.add(await laptop.request(), "--label", "laptop"),
    );
    // The relay learns about the laptop when it first connects.
    await laptop.run("team", "members", "product");
    await desktop.run("agent", "create", "product", "web");
    await carol.run("agent", "create", "product", "api");
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  const laptopKey = () => laptop.store.load()!.device.publicKey;
  const revokeLaptop = () =>
    desktop.run(
      "device",
      "revoke",
      deviceFingerprint(laptopKey()).replaceAll(" ", "").slice(0, 8),
    );

  it("closes the revoked device's session and refuses it from then on", async () => {
    const onLaptop = await laptop.session("product", "web");
    cleanups.push(onLaptop.close);

    expect(await revokeLaptop()).toMatchObject({ code: 0 });

    await expect
      .poll(() => onLaptop.call("list_agents"))
      .toContain("Couldn't list agents");
    await expect(laptop.session("product", "web")).rejects.toMatchObject({
      code: "authentication-failed",
    });
  });

  it("refuses the revoked device even if it presents its old identity log", async () => {
    const stale = laptop.store.load()!;
    await revokeLaptop();

    await expect(
      RelayConnection.connect(relay.url, stale),
    ).rejects.toMatchObject({ code: "authentication-failed" });
  });

  it("stops teammates encrypting new messages for the revoked device", async () => {
    await revokeLaptop();
    const api = await carol.session("product", "api");
    cleanups.push(api.close);

    await api.call("send_message", { to: "web", body: "after revocation" });

    const db = new DatabaseSync(databasePath, { readOnly: true });
    const rows = db
      .prepare("SELECT envelope FROM messages WHERE recipient = 'web'")
      .all() as { envelope: string }[];
    db.close();
    expect(rows).toHaveLength(1);
    const copies = Object.keys(JSON.parse(rows[0]!.envelope).copies);
    expect(copies).toEqual([desktop.store.load()!.device.publicKey]);
    expect(copies).not.toContain(laptopKey());
  });

  it("lists revoked devices separately", async () => {
    await revokeLaptop();

    const listed = (await desktop.run("device", "list")).out;
    expect(listed).toContain("Revoked:");
    expect(listed.split("Revoked:")[1]).toContain(
      deviceFingerprint(laptopKey()),
    );
  });

  it("won't revoke the device it's run on, or an unknown fingerprint", async () => {
    const own = deviceFingerprint(desktop.store.load()!.device.publicKey)
      .replaceAll(" ", "")
      .slice(0, 8);

    expect((await desktop.run("device", "revoke", own)).err).toContain(
      "That's this device",
    );
    expect((await desktop.run("device", "revoke", "zzzzzzzz")).err).toContain(
      "None of your devices",
    );
  });

  it("does nothing if the developer doesn't confirm", async () => {
    desktop.answer(false);

    expect((await revokeLaptop()).code).toBe(1);
    const onLaptop = await laptop.session("product", "web");
    cleanups.push(onLaptop.close);
    expect(await onLaptop.call("list_agents")).toContain("web (you)");
  });
});
