import { describe, expect, it } from "vitest";
import { signChallenge, verifyChallenge } from "./auth.js";
import {
  canonicalJson,
  generateDeviceKey,
  hash,
  sign,
  verify,
} from "./crypto.js";
import {
  IdentityError,
  createIdentity,
  verifyIdentityLog,
  type IdentityLog,
} from "./identity.js";

describe("crypto", () => {
  it("verifies a signature only for the signed message and key", () => {
    const key = generateDeviceKey();
    const other = generateDeviceKey();
    const signature = sign(key, "hello");

    expect(verify(key.publicKey, "hello", signature)).toBe(true);
    expect(verify(key.publicKey, "hellO", signature)).toBe(false);
    expect(verify(other.publicKey, "hello", signature)).toBe(false);
  });

  it("returns false rather than throwing for garbage input", () => {
    expect(verify("not a key", "hello", "not a signature")).toBe(false);
  });

  it("serialises objects canonically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });

  it("hashes deterministically", () => {
    expect(hash("abc")).toBe(hash("abc"));
    expect(hash("abc")).not.toBe(hash("abd"));
  });
});

describe("identity", () => {
  it("creates an identity that verifies", () => {
    const device = generateDeviceKey();
    const log = createIdentity(device, "Kev");

    const identity = verifyIdentityLog(log);

    expect(identity.name).toBe("Kev");
    expect(identity.devices).toEqual([device.publicKey]);
    expect(identity.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("gives the same id every time it is verified, and different ids to different identities", () => {
    const log = createIdentity(generateDeviceKey(), "Kev");
    const other = createIdentity(generateDeviceKey(), "Kev");

    expect(verifyIdentityLog(log).id).toBe(verifyIdentityLog(log).id);
    expect(verifyIdentityLog(other).id).not.toBe(verifyIdentityLog(log).id);
  });

  it("survives a JSON round trip", () => {
    const log = createIdentity(generateDeviceKey(), "Kev");
    const roundTripped: unknown = JSON.parse(JSON.stringify(log));

    expect(verifyIdentityLog(roundTripped).id).toBe(verifyIdentityLog(log).id);
  });

  const tamper = (mutate: (log: IdentityLog) => void) => {
    const log = structuredClone(createIdentity(generateDeviceKey(), "Kev"));
    mutate(log);
    return () => verifyIdentityLog(log);
  };

  it("rejects a log whose entry was changed after signing", () => {
    expect(
      tamper((log) => {
        (log[0]!.entry as { name: string }).name = "Mallory";
      }),
    ).toThrow(IdentityError);
  });

  it("rejects a first entry signed by a different device", () => {
    const intruder = generateDeviceKey();
    expect(
      tamper((log) => {
        log[0]!.signer = intruder.publicKey;
        log[0]!.signature = sign(intruder, canonicalJson(log[0]!.entry));
      }),
    ).toThrow(/signed by its own device/);
  });

  it("rejects a log that claims someone else's device", () => {
    const victim = generateDeviceKey();
    expect(
      tamper((log) => {
        log[0]!.entry.device = victim.publicKey;
      }),
    ).toThrow(IdentityError);
  });

  it("rejects malformed logs", () => {
    expect(() => verifyIdentityLog([])).toThrow(/malformed/);
    expect(() => verifyIdentityLog("nope")).toThrow(/malformed/);
  });
});

describe("challenge signatures", () => {
  it("bind the signature to the challenge, the team and the agent", () => {
    const device = generateDeviceKey();
    const scope = { team: "team-1", agent: "api" };
    const signature = signChallenge(device, "challenge-1", scope);
    const check = (challenge: string, s: typeof scope) =>
      verifyChallenge(device.publicKey, challenge, s, signature);

    expect(check("challenge-1", scope)).toBe(true);
    expect(check("challenge-2", scope)).toBe(false);
    expect(check("challenge-1", { ...scope, agent: "web" })).toBe(false);
    expect(check("challenge-1", { ...scope, team: "team-2" })).toBe(false);
  });
});
