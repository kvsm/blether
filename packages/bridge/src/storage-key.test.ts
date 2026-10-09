import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentity, generateDeviceKey } from "@blether/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileKeyStore,
  SignIns,
  UndecryptableDeviceKeyError,
} from "./keystore.js";
import {
  type Keychain,
  LostStorageKeyError,
  SecretBox,
  isSealed,
  platformKeychain,
} from "./storage-key.js";

/** A keychain in memory. */
class TestKeychain implements Keychain {
  readonly name = "the test keychain";
  key: Buffer | undefined;
  reads = 0;
  failure: string | undefined;

  read() {
    this.reads++;
    if (this.failure) throw new Error(this.failure);
    return this.key;
  }

  write(key: Buffer) {
    if (this.failure) throw new Error(this.failure);
    this.key = key;
  }

  delete() {
    this.key = undefined;
  }
}

describe("SecretBox", () => {
  it("encrypts a secret under a new storage key, and decrypts it", () => {
    const keychain = new TestKeychain();
    const sealed = new SecretBox(keychain).seal("a secret");
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain("a secret");
    expect(keychain.key).toHaveLength(32);
    expect(new SecretBox(keychain).open(sealed)).toBe("a secret");
  });

  it("reads the storage key once, and keeps using it", () => {
    const keychain = new TestKeychain();
    const box = new SecretBox(keychain);
    const first = box.seal("one");
    const key = keychain.key;
    box.seal("two");
    expect(keychain.key).toBe(key);
    expect(keychain.reads).toBe(1);
    expect(box.open(first)).toBe("one");
  });

  it("stores a secret as it is when the keychain can't be used", () => {
    const keychain = new TestKeychain();
    keychain.failure = "no Secret Service";
    const box = new SecretBox(keychain);
    expect(box.seal("a secret")).toBe("a secret");
    expect(box.unavailable).toBe("no Secret Service");
  });

  it("stores a secret as it is when sealing is off, or there's no keychain", () => {
    const keychain = new TestKeychain();
    const off = new SecretBox(keychain, false);
    expect(off.seal("a secret")).toBe("a secret");
    expect(off.unavailable).toBe("BLETHER_KEYCHAIN is off");
    expect(keychain.reads).toBe(0);
    expect(new SecretBox(undefined).seal("a secret")).toBe("a secret");
  });

  it("decrypts with sealing off, so a sealed secret stays readable", () => {
    const keychain = new TestKeychain();
    const sealed = new SecretBox(keychain).seal("a secret");
    expect(new SecretBox(keychain, false).open(sealed)).toBe("a secret");
  });

  it("passes a secret stored as it is through", () => {
    expect(new SecretBox(new TestKeychain()).open("plain")).toBe("plain");
  });

  it("says the storage key is lost when it's gone or was replaced", () => {
    const keychain = new TestKeychain();
    const sealed = new SecretBox(keychain).seal("a secret");
    keychain.key = randomBytes(32);
    expect(() => new SecretBox(keychain).open(sealed)).toThrow(
      LostStorageKeyError,
    );
    keychain.delete();
    expect(() => new SecretBox(keychain).open(sealed)).toThrow(
      LostStorageKeyError,
    );
  });

  it("says why when the keychain can't be read", () => {
    const keychain = new TestKeychain();
    const sealed = new SecretBox(keychain).seal("a secret");
    keychain.failure = "the keychain is locked";
    expect(() => new SecretBox(keychain).open(sealed)).toThrow(
      "Couldn't read its storage key from the test keychain: the keychain is locked",
    );
  });
});

describe("FileKeyStore with a keychain", () => {
  let home: string;
  let keychain: TestKeychain;
  const store = (sealing = true) =>
    new FileKeyStore(home, new SecretBox(keychain, sealing));
  const deviceFile = () => readFileSync(join(home, "device-key.json"), "utf8");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "blether-keychain-"));
    keychain = new TestKeychain();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("stores the device's secret key encrypted, and loads it", () => {
    const device = generateDeviceKey();
    store().save({ device, identity: createIdentity(device, "Ada") });
    expect(deviceFile()).not.toContain(device.secretKey);
    expect(deviceFile()).toContain(device.publicKey);
    expect(store().load()?.device).toEqual(device);
    expect(store().keyProtection()).toBe(
      "encrypted, with its storage key in the test keychain",
    );
  });

  it("encrypts a pending device key too", () => {
    const device = generateDeviceKey();
    store().savePendingDevice(device);
    expect(
      readFileSync(join(home, "pending-device-key.json"), "utf8"),
    ).not.toContain(device.secretKey);
    expect(store().loadPendingDevice()).toEqual(device);
  });

  it("encrypts a key stored as it is, once there's a keychain", () => {
    const device = generateDeviceKey();
    store(false).save({ device, identity: createIdentity(device, "Ada") });
    expect(deviceFile()).toContain(device.secretKey);
    expect(store(false).encryptStoredKeys()).toBeUndefined();
    expect(store().encryptStoredKeys()).toBe("the test keychain");
    expect(deviceFile()).not.toContain(device.secretKey);
    expect(store().encryptStoredKeys()).toBeUndefined();
    expect(store().load()?.device).toEqual(device);
  });

  it("leaves a key as it is when the keychain can't be used", () => {
    const device = generateDeviceKey();
    store(false).save({ device, identity: createIdentity(device, "Ada") });
    keychain.failure = "no Secret Service";
    const failing = store();
    expect(failing.encryptStoredKeys()).toBeUndefined();
    expect(deviceFile()).toContain(device.secretKey);
    expect(failing.keyProtection()).toBe(
      "in a file only you can read (no keychain: no Secret Service)",
    );
  });

  it("says how to recover when the storage key is lost", () => {
    const device = generateDeviceKey();
    store().save({ device, identity: createIdentity(device, "Ada") });
    keychain.delete();
    const error = (() => {
      try {
        store().load();
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(UndecryptableDeviceKeyError);
    expect((error as Error).message).toMatch(
      /no longer in the test keychain.*blether device request.*blether init/,
    );
  });
});

describe("SignIns with a keychain", () => {
  let home: string;
  let keychain: TestKeychain;
  const signIns = (sealing = true) =>
    new SignIns(home, new SecretBox(keychain, sealing));
  const file = () => readFileSync(join(home, "sign-ins.json"), "utf8");
  const relay = "wss://relay.example";
  const oidc = {
    kind: "oidc" as const,
    credential: "the-access-token",
    refreshToken: "the-refresh-token",
    access: { issuer: "https://idp.example", clientId: "app", scopes: [] },
    signedInAt: "2026-10-09T12:00:00.000Z",
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "blether-keychain-"));
    keychain = new TestKeychain();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("stores the credential and refresh token encrypted, and reads them", () => {
    signIns().save(relay, oidc);
    expect(file()).not.toContain("the-access-token");
    expect(file()).not.toContain("the-refresh-token");
    expect(file()).toContain("https://idp.example");
    expect(signIns().get(relay)).toEqual(oidc);
    expect(signIns().credential(relay)).toBe("the-access-token");
  });

  it("lists and removes sign-ins without the keychain", () => {
    signIns().save(relay, oidc);
    keychain.failure = "the keychain is locked";
    expect(signIns().list()).toEqual([
      { url: relay, kind: "oidc", signedInAt: oidc.signedInAt },
    ]);
    expect(signIns().remove(relay)).toBe(true);
  });

  it("encrypts sign-ins stored as they are, once there's a keychain", () => {
    signIns(false).save(relay, oidc);
    signIns(false).save("wss://other.example", {
      kind: "token",
      credential: "operator-token",
      signedInAt: oidc.signedInAt,
    });
    expect(file()).toContain("the-refresh-token");
    expect(signIns(false).encryptStored()).toBeUndefined();
    expect(signIns().encryptStored()).toBe("the test keychain");
    expect(file()).not.toContain("the-refresh-token");
    expect(file()).not.toContain("operator-token");
    expect(signIns().encryptStored()).toBeUndefined();
    expect(signIns().get(relay)).toEqual(oidc);
    expect(signIns().credential("wss://other.example")).toBe("operator-token");
  });

  it("counts a sign-in whose storage key is lost as none", () => {
    signIns().save(relay, oidc);
    keychain.key = randomBytes(32);
    expect(signIns().get(relay)).toBeUndefined();
  });
});

// Uses this machine's real keychain, so only where asked: CI sets it on macOS and Windows.
describe.runIf(process.env.BLETHER_KEYCHAIN_TEST)(
  "the platform keychain",
  () => {
    let home: string;
    let keychain: Keychain;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "blether-keychain-"));
      const found = platformKeychain(home);
      if (!found) throw new Error(`No keychain on ${process.platform}`);
      keychain = found;
    });
    afterEach(() => {
      keychain.delete();
      rmSync(home, { recursive: true, force: true });
    });

    it("stores, reads, replaces and deletes a storage key", () => {
      expect(keychain.read()).toBeUndefined();
      const key = randomBytes(32);
      keychain.write(key);
      expect(keychain.read()).toEqual(key);
      const replacement = randomBytes(32);
      keychain.write(replacement);
      expect(keychain.read()).toEqual(replacement);
      keychain.delete();
      expect(keychain.read()).toBeUndefined();
    }, 30_000);

    it.runIf(process.platform === "win32")(
      "has no storage key when DPAPI can't decrypt it",
      () => {
        keychain.write(randomBytes(32));
        writeFileSync(
          join(home, "storage-key.dpapi"),
          randomBytes(200).toString("base64"),
        );
        expect(keychain.read()).toBeUndefined();
      },
      30_000,
    );
  },
);
