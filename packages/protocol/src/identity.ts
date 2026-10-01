import { z } from "zod";
import {
  PublicKey,
  Signature,
  canonicalJson,
  hash,
  sign,
  verify,
  type MachineKey,
} from "./crypto.js";

/**
 * A developer's identity log (ADR 0006): an append-only list of signed
 * entries describing which machines belong to the developer. The first entry
 * creates the identity; the developer's identity id is its hash.
 *
 * Adding and revoking machines arrives with #6's third part; for now an
 * identity has exactly one machine.
 */

export const DeveloperName = z.string().trim().min(1).max(64);

export const IdentityEntry = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("identity-created"),
    name: DeveloperName,
    machine: PublicKey,
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
  /** Public keys of the developer's machines. */
  machines: PublicKey[];
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

/** Creates a new identity whose first machine is `machine`. */
export function createIdentity(
  machine: MachineKey,
  name: string,
  now = new Date(),
): IdentityLog {
  const entry: IdentityEntry = {
    type: "identity-created",
    name: DeveloperName.parse(name),
    machine: machine.publicKey,
    createdAt: now.toISOString(),
  };
  return [
    {
      entry,
      signer: machine.publicKey,
      signature: sign(machine, canonicalJson(entry)),
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
  if (first!.signer !== first!.entry.machine) {
    throw new IdentityError(
      "identity-created must be signed by its own machine.",
    );
  }
  if (!verifySigned(first!)) {
    throw new IdentityError("identity-created has an invalid signature.");
  }
  if (rest.length > 0) {
    throw new IdentityError(
      "This version only supports single-machine identities.",
    );
  }

  return {
    id: hash(canonicalJson(first)),
    name: first!.entry.name,
    machines: [first!.entry.machine],
  };
}

function verifySigned(signed: SignedIdentityEntry): boolean {
  return verify(signed.signer, canonicalJson(signed.entry), signed.signature);
}
