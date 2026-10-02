import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "./crypto.js";
import {
  IdentityError,
  addDevice,
  createIdentity,
  revokeDevice,
  verifyIdentityLog,
} from "./identity.js";

const desktop = generateDeviceKey();
const laptop = generateDeviceKey();
const phone = generateDeviceKey();
const withLaptop = addDevice(
  createIdentity(desktop, "Kev"),
  desktop,
  laptop.publicKey,
);

describe("revoking devices", () => {
  it("removes a revoked device from the identity, keeping its id", () => {
    const log = revokeDevice(withLaptop, desktop, laptop.publicKey);

    const identity = verifyIdentityLog(log);
    expect(identity.devices).toEqual([desktop.publicKey]);
    expect(identity.revoked).toEqual([
      { key: laptop.publicKey, revokedAt: expect.any(String) },
    ]);
    expect(identity.id).toBe(verifyIdentityLog(withLaptop).id);
  });

  it("lets the first device be revoked by a later one", () => {
    const log = revokeDevice(withLaptop, laptop, desktop.publicKey);

    expect(verifyIdentityLog(log).devices).toEqual([laptop.publicKey]);
  });

  it("stops a revoked device signing anything further", () => {
    const revoked = revokeDevice(withLaptop, desktop, laptop.publicKey);
    // Build what the stolen laptop would sign, on top of the revoked log.
    const sneaky = addDevice(withLaptop, laptop, phone.publicKey);
    const forged = [...revoked, { ...sneaky[2]!, prev: undefined }];

    expect(() => verifyIdentityLog(forged)).toThrow(IdentityError);
  });

  it("won't revoke an identity's last device", () => {
    const alone = createIdentity(desktop, "Kev");

    expect(() => revokeDevice(alone, desktop, desktop.publicKey)).toThrow(
      /not from itself/,
    );
  });

  it("won't let a revoked device be added back", () => {
    const revoked = revokeDevice(withLaptop, desktop, laptop.publicKey);

    const readded = addDevice(revoked, desktop, phone.publicKey);
    expect(verifyIdentityLog(readded).devices).toHaveLength(2);
    expect(() => addDevice(revoked, desktop, laptop.publicKey)).toThrow(
      /can't be added back/,
    );
  });

  it("only lets the identity's own devices revoke", () => {
    expect(() => revokeDevice(withLaptop, phone, laptop.publicKey)).toThrow(
      /Only one of the identity's devices/,
    );
  });
});
