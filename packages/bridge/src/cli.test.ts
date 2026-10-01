import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyIdentityLog } from "@blether/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { FileKeyStore } from "./keystore.js";

describe("blether CLI", () => {
  let home: string;
  let store: FileKeyStore;
  let out: string[];
  let err: string[];
  const run = (...argv: string[]) =>
    runCli(argv, store, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
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

  it("init creates a machine key and an identity that verifies", () => {
    expect(run("init", "--name", "Kev")).toBe(0);

    const credentials = store.load()!;
    const identity = verifyIdentityLog(credentials.identity);
    expect(identity.name).toBe("Kev");
    expect(identity.machines).toEqual([credentials.machine.publicKey]);
    expect(out.join("\n")).toContain(`Identity: ${identity.id}`);
  });

  it.skipIf(process.platform === "win32")(
    "keeps key files private to the user",
    () => {
      run("init", "--name", "Kev");

      expect(statSync(join(store.home, "machine-key.json")).mode & 0o777).toBe(
        0o600,
      );
      expect(statSync(store.home).mode & 0o777).toBe(0o700);
    },
  );

  it("init refuses to overwrite an existing identity", () => {
    run("init", "--name", "Kev");
    const before = store.load();

    expect(run("init", "--name", "Someone else")).toBe(1);
    expect(store.load()).toEqual(before);
    expect(err.join("\n")).toContain("already a Blether identity");
  });

  it("init requires a name", () => {
    expect(run("init")).toBe(1);
    expect(store.exists()).toBe(false);
  });

  it("whoami shows the identity", () => {
    run("init", "--name", "Kev");
    out = [];

    expect(run("whoami")).toBe(0);
    expect(out[0]).toBe("Name:     Kev");
  });

  it("whoami explains when there is no identity yet", () => {
    expect(run("whoami")).toBe(1);
    expect(err.join("\n")).toContain("blether init");
  });

  it("reports unknown options instead of crashing", () => {
    expect(run("init", "--nmae", "Kev")).toBe(1);
    expect(err.join("\n")).toContain("--nmae");
  });

  it("rejects stored credentials whose key isn't in the identity", () => {
    run("init", "--name", "Kev");
    const other = new FileKeyStore(join(home, "other"));
    expect(
      runCli(["init", "--name", "Other"], other, { out() {}, err() {} }),
    ).toBe(0);
    store.save({
      machine: other.load()!.machine,
      identity: store.load()!.identity,
    });

    expect(() => store.load()).toThrow(/doesn't include this machine's key/);
  });
});
