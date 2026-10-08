import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLETHER_VERSION, verifyIdentityLog } from "@blether/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { FileKeyStore } from "./keystore.js";

describe("blether CLI", () => {
  let home: string;
  let store: FileKeyStore;
  let out: string[];
  let err: string[];
  const run = (...argv: string[]) =>
    runCli(argv, {
      store,
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "blether-home-"));
    store = new FileKeyStore(join(home, ".blether"));
    out = [];
    err = [];
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.each(["--version", "-v", "version"])(
    "%s prints the release version",
    async (flag) => {
      expect(await run(flag)).toBe(0);
      expect(out).toEqual([BLETHER_VERSION]);
    },
  );

  // Tests run without an interactive terminal, as an agent's shell does.
  it("won't loosen the Approval Policy without an interactive terminal", async () => {
    expect(await run("policy", "set", "--outgoing", "free")).toBe(1);

    expect(err.join("\n")).toContain(
      "Run this in an interactive terminal to confirm.",
    );
    expect(out.join("\n")).not.toContain("Outgoing: free");
    out = [];
    await run("policy");
    expect(out.join("\n")).toContain("Outgoing: ask");
  });

  it("won't raise a sending limit without an interactive terminal", async () => {
    expect(await run("policy", "set", "--limit-per-recipient", "1000")).toBe(1);
    expect(await run("policy", "set", "--limit-window", "1")).toBe(1);
  });

  it("tightens the Approval Policy without asking", async () => {
    expect(await run("policy", "set", "--limit-per-recipient", "1")).toBe(0);
    expect(await run("policy", "set", "--outgoing", "ask")).toBe(0);
    expect(err).toEqual([]);
  });

  it("init creates a device key and an identity that verifies", async () => {
    expect(await run("init", "--name", "Kev")).toBe(0);

    const credentials = store.load()!;
    const identity = verifyIdentityLog(credentials.identity);
    expect(identity.name).toBe("Kev");
    expect(identity.devices).toEqual([credentials.device.publicKey]);
    expect(out.join("\n")).toContain(`Identity: ${identity.id}`);
  });

  it.skipIf(process.platform === "win32")(
    "keeps key files private to the user",
    async () => {
      await run("init", "--name", "Kev");

      expect(statSync(join(store.home, "device-key.json")).mode & 0o777).toBe(
        0o600,
      );
      expect(statSync(store.home).mode & 0o777).toBe(0o700);
    },
  );

  it("init refuses to overwrite an existing identity", async () => {
    await run("init", "--name", "Kev");
    const before = store.load();

    expect(await run("init", "--name", "Someone else")).toBe(1);
    expect(store.load()).toEqual(before);
    expect(err.join("\n")).toContain("already a Blether identity");
  });

  it("init requires a name", async () => {
    expect(await run("init")).toBe(1);
    expect(store.exists()).toBe(false);
  });

  it("whoami shows the identity", async () => {
    await run("init", "--name", "Kev");
    out = [];

    expect(await run("whoami")).toBe(0);
    expect(out[0]).toBe("Name:     Kev");
  });

  it("whoami explains when there is no identity yet", async () => {
    expect(await run("whoami")).toBe(1);
    expect(err.join("\n")).toContain("blether init");
  });

  it("reports unknown options instead of crashing", async () => {
    expect(await run("init", "--nmae", "Kev")).toBe(1);
    expect(err.join("\n")).toContain("--nmae");
  });

  it("explains how to recover from a ~/.blether written by an older build", async () => {
    mkdirSync(store.home, { recursive: true });
    writeFileSync(join(store.home, "machine-key.json"), "{}");

    expect(await run("whoami")).toBe(1);
    expect(err.join("\n")).toContain("earlier development build");
    expect(await run("init", "--name", "Kev")).toBe(1);
  });

  it("rejects stored credentials whose key isn't in the identity", async () => {
    await run("init", "--name", "Kev");
    const other = new FileKeyStore(join(home, "other"));
    expect(
      await runCli(["init", "--name", "Other"], {
        store: other,
        io: { out() {}, err() {} },
      }),
    ).toBe(0);
    store.save({
      device: other.load()!.device,
      identity: store.load()!.identity,
    });

    expect(() => store.load()).toThrow(/doesn't include this device's key/);
  });
});
