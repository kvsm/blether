import { describe, expect, it } from "vitest";
import { signChallenge, verifyChallenge } from "./auth.js";
import {
  canonicalJson,
  generateMachineKey,
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
    const key = generateMachineKey();
    const other = generateMachineKey();
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
    const machine = generateMachineKey();
    const log = createIdentity(machine, "Kev");

    const identity = verifyIdentityLog(log);

    expect(identity.name).toBe("Kev");
    expect(identity.machines).toEqual([machine.publicKey]);
    expect(identity.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("gives the same id every time it is verified, and different ids to different identities", () => {
    const log = createIdentity(generateMachineKey(), "Kev");
    const other = createIdentity(generateMachineKey(), "Kev");

    expect(verifyIdentityLog(log).id).toBe(verifyIdentityLog(log).id);
    expect(verifyIdentityLog(other).id).not.toBe(verifyIdentityLog(log).id);
  });

  it("survives a JSON round trip", () => {
    const log = createIdentity(generateMachineKey(), "Kev");
    const roundTripped: unknown = JSON.parse(JSON.stringify(log));

    expect(verifyIdentityLog(roundTripped).id).toBe(verifyIdentityLog(log).id);
  });

  const tamper = (mutate: (log: IdentityLog) => void) => {
    const log = structuredClone(createIdentity(generateMachineKey(), "Kev"));
    mutate(log);
    return () => verifyIdentityLog(log);
  };

  it("rejects a log whose entry was changed after signing", () => {
    expect(
      tamper((log) => {
        log[0]!.entry.name = "Mallory";
      }),
    ).toThrow(IdentityError);
  });

  it("rejects a first entry signed by a different machine", () => {
    const intruder = generateMachineKey();
    expect(
      tamper((log) => {
        log[0]!.signer = intruder.publicKey;
        log[0]!.signature = sign(intruder, canonicalJson(log[0]!.entry));
      }),
    ).toThrow(/signed by its own machine/);
  });

  it("rejects a log that claims someone else's machine", () => {
    const victim = generateMachineKey();
    expect(
      tamper((log) => {
        log[0]!.entry.machine = victim.publicKey;
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
    const machine = generateMachineKey();
    const scope = { team: "team-1", agent: "api" };
    const signature = signChallenge(machine, "challenge-1", scope);
    const check = (challenge: string, s: typeof scope) =>
      verifyChallenge(machine.publicKey, challenge, s, signature);

    expect(check("challenge-1", scope)).toBe(true);
    expect(check("challenge-2", scope)).toBe(false);
    expect(check("challenge-1", { ...scope, agent: "web" })).toBe(false);
    expect(check("challenge-1", { ...scope, team: "team-2" })).toBe(false);
  });
});
