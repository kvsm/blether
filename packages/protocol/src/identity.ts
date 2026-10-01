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
 * creates the identity, and the developer's identity id is its hash. Each
 * later entry names the hash of the one before it and is signed by a device
 * already in the log.
 *
 * Revoking devices arrives with #21.
 */

export const DeveloperName = z.string().trim().min(1).max(64);

/** A short name a developer gives a device, such as "laptop". */
export const DeviceLabel = z.string().trim().min(1).max(32);

export const IdentityEntry = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("identity-created"),
    name: DeveloperName,
    device: PublicKey,
    createdAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("device-added"),
    device: PublicKey,
    label: DeviceLabel.optional(),
    createdAt: z.iso.datetime(),
  }),
]);
export type IdentityEntry = z.infer<typeof IdentityEntry>;

export const SignedIdentityEntry = z.object({
  entry: IdentityEntry,
  /** Hash of the previous signed entry. Absent on the first. */
  prev: z.string().optional(),
  signer: PublicKey,
  signature: Signature,
});
export type SignedIdentityEntry = z.infer<typeof SignedIdentityEntry>;

export const IdentityLog = z.array(SignedIdentityEntry).min(1);
export type IdentityLog = z.infer<typeof IdentityLog>;

export interface DeviceInfo {
  key: PublicKey;
  label?: string | undefined;
  addedAt: string;
}

/** What a verified identity log says about a developer. */
export interface Identity {
  /** Stable id: the hash of the log's first entry. */
  id: string;
  name: string;
  /** Public keys of the developer's devices, oldest first. */
  devices: PublicKey[];
  deviceInfo: DeviceInfo[];
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

/** What an entry's signature covers. The first entry has no `prev`, so ids of existing identities stay stable. */
function signedContent(entry: IdentityEntry, prev: string | undefined) {
  return prev === undefined
    ? canonicalJson(entry)
    : canonicalJson({ entry, prev });
}

function identityEntryHash(signed: SignedIdentityEntry): string {
  return hash(canonicalJson(signed));
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
      signature: sign(device, signedContent(entry, undefined)),
    },
  ];
}

/**
 * Returns `log` with `newDevice` added, signed by `by`, which must already be
 * one of the identity's devices.
 */
export function addDevice(
  log: IdentityLog,
  by: DeviceKey,
  newDevice: PublicKey,
  { label, now = new Date() }: { label?: string; now?: Date } = {},
): IdentityLog {
  const identity = verifyIdentityLog(log);
  if (!identity.devices.includes(by.publicKey)) {
    throw new IdentityError(
      "Only one of the identity's devices can add a device.",
    );
  }
  if (identity.devices.includes(newDevice)) {
    throw new IdentityError("That device is already part of this identity.");
  }
  const entry: IdentityEntry = {
    type: "device-added",
    device: PublicKey.parse(newDevice),
    ...(label === undefined ? {} : { label: DeviceLabel.parse(label) }),
    createdAt: now.toISOString(),
  };
  const prev = identityEntryHash(log[log.length - 1]!);
  return [
    ...log,
    {
      entry,
      prev,
      signer: by.publicKey,
      signature: sign(by, signedContent(entry, prev)),
    },
  ];
}

/** Checks every signature in `log` and returns the identity it describes. Throws IdentityError if it doesn't verify. */
export function verifyIdentityLog(log: unknown): Identity {
  const parsed = IdentityLog.safeParse(log);
  if (!parsed.success) throw new IdentityError("Identity log is malformed.");
  const [first, ...rest] = parsed.data;

  if (first!.entry.type !== "identity-created" || first!.prev !== undefined) {
    throw new IdentityError("Identity log must start with identity-created.");
  }
  if (first!.signer !== first!.entry.device) {
    throw new IdentityError(
      "identity-created must be signed by its own device.",
    );
  }
  if (
    !verify(
      first!.signer,
      signedContent(first!.entry, undefined),
      first!.signature,
    )
  ) {
    throw new IdentityError("identity-created has an invalid signature.");
  }

  const identity: Identity = {
    id: hash(canonicalJson(first)),
    name: first!.entry.name,
    devices: [first!.entry.device],
    deviceInfo: [{ key: first!.entry.device, addedAt: first!.entry.createdAt }],
  };

  let previous = first!;
  for (const [index, signed] of rest.entries()) {
    const where = `Entry ${index + 1} (${signed.entry.type})`;
    if (signed.prev !== identityEntryHash(previous)) {
      throw new IdentityError(`${where} doesn't follow the entry before it.`);
    }
    if (!identity.devices.includes(signed.signer)) {
      throw new IdentityError(
        `${where} isn't signed by one of the identity's devices.`,
      );
    }
    if (
      !verify(
        signed.signer,
        signedContent(signed.entry, signed.prev),
        signed.signature,
      )
    ) {
      throw new IdentityError(`${where} has an invalid signature.`);
    }
    const { entry } = signed;
    switch (entry.type) {
      case "identity-created":
        throw new IdentityError(
          `${where}: an identity can only be created once.`,
        );
      case "device-added":
        if (identity.devices.includes(entry.device)) {
          throw new IdentityError(
            `${where}: device is already part of this identity.`,
          );
        }
        identity.devices.push(entry.device);
        identity.deviceInfo.push({
          key: entry.device,
          label: entry.label,
          addedAt: entry.createdAt,
        });
        break;
    }
    previous = signed;
  }

  return identity;
}
