import { z } from "zod";
import {
  PublicKey,
  Signature,
  canonicalJson,
  hash,
  sign,
  verify,
  type DeviceKey,
} from "./crypto.js";

/**
 * A developer's identity log (ADR 0006): an append-only list of signed
 * entries describing which devices belong to the developer. The first entry
 * creates the identity; the developer's identity id is its hash.
 *
 * Adding and revoking devices arrives with #6's third part; for now an
 * identity has exactly one device.
 */

export const DeveloperName = z.string().trim().min(1).max(64);

export const IdentityEntry = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("identity-created"),
    name: DeveloperName,
    device: PublicKey,
    createdAt: z.iso.datetime(),
  }),
]);
export type IdentityEntry = z.infer<typeof IdentityEntry>;

export const SignedIdentityEntry = z.object({
  entry: IdentityEntry,
  signer: PublicKey,
  signature: Signature,
});
export type SignedIdentityEntry = z.infer<typeof SignedIdentityEntry>;

export const IdentityLog = z.array(SignedIdentityEntry).min(1);
export type IdentityLog = z.infer<typeof IdentityLog>;

/** What a verified identity log says about a developer. */
export interface Identity {
  /** Stable id: the hash of the log's first entry. */
  id: string;
  name: string;
  /** Public keys of the developer's devices. */
  devices: PublicKey[];
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

/** Creates a new identity whose first device is `device`. */
export function createIdentity(
  device: DeviceKey,
  name: string,
  now = new Date(),
): IdentityLog {
  const entry: IdentityEntry = {
    type: "identity-created",
    name: DeveloperName.parse(name),
    device: device.publicKey,
    createdAt: now.toISOString(),
  };
  return [
    {
      entry,
      signer: device.publicKey,
      signature: sign(device, canonicalJson(entry)),
    },
  ];
}

/** Checks every signature in `log` and returns the identity it describes. Throws IdentityError if it doesn't verify. */
export function verifyIdentityLog(log: unknown): Identity {
  const parsed = IdentityLog.safeParse(log);
  if (!parsed.success) throw new IdentityError("Identity log is malformed.");
  const [first, ...rest] = parsed.data;

  if (first!.entry.type !== "identity-created") {
    throw new IdentityError("Identity log must start with identity-created.");
  }
  if (first!.signer !== first!.entry.device) {
    throw new IdentityError(
      "identity-created must be signed by its own device.",
    );
  }
  if (!verifySigned(first!)) {
    throw new IdentityError("identity-created has an invalid signature.");
  }
  if (rest.length > 0) {
    throw new IdentityError(
      "This version only supports single-device identities.",
    );
  }

  return {
    id: hash(canonicalJson(first)),
    name: first!.entry.name,
    devices: [first!.entry.device],
  };
}

function verifySigned(signed: SignedIdentityEntry): boolean {
  return verify(signed.signer, canonicalJson(signed.entry), signed.signature);
}
