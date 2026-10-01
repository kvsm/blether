import { z } from "zod";
import { PublicKey, decode, encode, hash } from "./crypto.js";
import { IdentityLog } from "./identity.js";
import { TeamName } from "./team.js";

/**
 * Pairing a new device with an existing one (ADR 0005) by copying two
 * strings between them; the relay isn't involved.
 *
 * 1. The new device prints a **request** carrying its public key.
 * 2. An existing device checks the request's fingerprint with the developer,
 *    signs the key into the identity log and prints a **grant**: the updated
 *    identity log and the developer's teams. Nothing in it is secret.
 * 3. The new device checks the grant includes its key and saves it.
 */

const REQUEST_PREFIX = "blether-device:";
const GRANT_PREFIX = "blether-grant:";

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}

export function formatDeviceRequest(device: PublicKey): string {
  return `${REQUEST_PREFIX}${device}`;
}

export function parseDeviceRequest(text: string): PublicKey {
  const trimmed = text.trim();
  const key = PublicKey.safeParse(trimmed.slice(REQUEST_PREFIX.length));
  if (!trimmed.startsWith(REQUEST_PREFIX) || !key.success) {
    throw new PairingError(
      "That isn't a device request. Run `blether device request` on the new device and copy what it prints.",
    );
  }
  return key.data;
}

/** A short, human-comparable fingerprint of a device key, e.g. "aB3d Ef9h Jk2L mN4p". */
export function deviceFingerprint(device: PublicKey): string {
  return hash(`blether-device-fingerprint\n${device}`)
    .slice(0, 16)
    .match(/.{4}/g)!
    .join(" ");
}

export const DeviceGrant = z.object({
  identity: IdentityLog,
  teams: z.array(
    z.object({ name: TeamName, id: z.string(), relayUrl: z.url() }),
  ),
});
export type DeviceGrant = z.infer<typeof DeviceGrant>;

export function formatDeviceGrant(grant: DeviceGrant): string {
  return `${GRANT_PREFIX}${encode(new TextEncoder().encode(JSON.stringify(grant)))}`;
}

export function parseDeviceGrant(text: string): DeviceGrant {
  const trimmed = text.trim();
  if (!trimmed.startsWith(GRANT_PREFIX)) {
    throw new PairingError(
      "That isn't a device grant. Copy what `blether device add` printed on your other device.",
    );
  }
  try {
    const json: unknown = JSON.parse(
      new TextDecoder().decode(decode(trimmed.slice(GRANT_PREFIX.length))),
    );
    return DeviceGrant.parse(json);
  } catch {
    throw new PairingError(
      "That device grant is damaged. Copy it again, all on one line.",
    );
  }
}
