import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "./crypto.js";
import {
  IdentityError,
  addDevice,
  createIdentity,
  verifyIdentityLog,
} from "./identity.js";
import { compareLogs } from "./logs.js";
import {
  PairingError,
  deviceFingerprint,
  formatDeviceGrant,
  formatDeviceRequest,
  parseDeviceGrant,
  parseDeviceRequest,
} from "./pairing.js";

const desktop = generateDeviceKey();
const laptop = generateDeviceKey();
const phone = generateDeviceKey();
const created = createIdentity(desktop, "Kev");

describe("adding devices to an identity", () => {
  it("adds a device signed in by an existing one, keeping the identity id", () => {
    const log = addDevice(created, desktop, laptop.publicKey, {
      label: "laptop",
    });

    const identity = verifyIdentityLog(log);
    expect(identity.devices).toEqual([desktop.publicKey, laptop.publicKey]);
    expect(identity.deviceInfo[1]?.label).toBe("laptop");
    expect(identity.id).toBe(verifyIdentityLog(created).id);
  });

  it("lets any of the identity's devices add the next one", () => {
    const withLaptop = addDevice(created, desktop, laptop.publicKey);
    const withPhone = addDevice(withLaptop, laptop, phone.publicKey);

    expect(verifyIdentityLog(withPhone).devices).toHaveLength(3);
  });

  it("refuses a device added by a key that isn't one of the identity's", () => {
    expect(() => addDevice(created, laptop, phone.publicKey)).toThrow(
      IdentityError,
    );

    // A forged entry signed by an outsider fails verification too.
    const genuine = addDevice(created, desktop, laptop.publicKey);
    const forged = addDevice(
      createIdentity(phone, "Kev"),
      phone,
      laptop.publicKey,
    );
    const spliced = [genuine[0]!, forged[1]!];
    expect(() => verifyIdentityLog(spliced)).toThrow(IdentityError);
  });

  it("refuses an entry that doesn't follow the one before it", () => {
    const withLaptop = addDevice(created, desktop, laptop.publicKey);
    const withPhone = addDevice(withLaptop, desktop, phone.publicKey);
    const skipped = [withPhone[0]!, withPhone[2]!];

    expect(() => verifyIdentityLog(skipped)).toThrow(/doesn't follow/);
  });

  it("refuses adding a device twice", () => {
    const withLaptop = addDevice(created, desktop, laptop.publicKey);

    expect(() => addDevice(withLaptop, desktop, laptop.publicKey)).toThrow(
      /already part of this identity/,
    );
  });

  it("refuses an added entry that was changed after signing", () => {
    const log = structuredClone(
      addDevice(created, desktop, laptop.publicKey, { label: "laptop" }),
    );
    (log[1]!.entry as { label?: string }).label = "evil";

    expect(() => verifyIdentityLog(log)).toThrow(/invalid signature/);
  });
});

describe("comparing versions of a log", () => {
  const withLaptop = addDevice(created, desktop, laptop.publicKey);
  const withPhone = addDevice(created, desktop, phone.publicKey);

  it("tells same, extends, behind and diverged apart", () => {
    expect(compareLogs(created, created)).toBe("same");
    expect(compareLogs(withLaptop, created)).toBe("extends");
    expect(compareLogs(created, withLaptop)).toBe("behind");
    expect(compareLogs(withPhone, withLaptop)).toBe("diverged");
  });

  it("isn't fooled by key order", () => {
    const [first] = created;
    const entry = first!.entry as Record<string, unknown>;
    const reordered = {
      signature: first!.signature,
      signer: first!.signer,
      entry: Object.fromEntries(Object.entries(entry).reverse()),
    };

    expect(compareLogs([reordered], created)).toBe("same");
  });
});

describe("pairing strings", () => {
  it("round-trips a device request", () => {
    expect(parseDeviceRequest(formatDeviceRequest(laptop.publicKey))).toBe(
      laptop.publicKey,
    );
  });

  it("rejects text that isn't a device request", () => {
    expect(() => parseDeviceRequest("blether-device:nope")).toThrow(
      PairingError,
    );
  });

  it("gives each device a stable, short fingerprint", () => {
    const fingerprint = deviceFingerprint(laptop.publicKey);

    expect(fingerprint).toMatch(/^\S{4} \S{4} \S{4} \S{4}$/);
    expect(deviceFingerprint(laptop.publicKey)).toBe(fingerprint);
    expect(deviceFingerprint(phone.publicKey)).not.toBe(fingerprint);
  });

  it("round-trips a grant", () => {
    const grant = {
      identity: addDevice(created, desktop, laptop.publicKey),
      teams: [
        {
          name: "backend",
          id: "a".repeat(43),
          relayUrl: "ws://127.0.0.1:7357",
        },
      ],
    };

    expect(parseDeviceGrant(formatDeviceGrant(grant))).toEqual(grant);
  });

  it("rejects a damaged grant", () => {
    const text = formatDeviceGrant({ identity: created, teams: [] });

    expect(() => parseDeviceGrant(text.slice(0, -10))).toThrow(PairingError);
    expect(() => parseDeviceGrant("hello")).toThrow(PairingError);
  });
});
