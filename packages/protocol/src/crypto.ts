import sodium from "libsodium-wrappers";
import { z } from "zod";

// libsodium initialises asynchronously; everything below is synchronous once it has.
await sodium.ready;

const BASE64 = sodium.base64_variants.URLSAFE_NO_PADDING;

export function encode(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, BASE64);
}

export function decode(text: string): Uint8Array {
  return sodium.from_base64(text, BASE64);
}

/** An Ed25519 public key, base64url-encoded without padding. */
export const PublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type PublicKey = z.infer<typeof PublicKey>;

/** A detached Ed25519 signature, base64url-encoded without padding. */
export const Signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export type Signature = z.infer<typeof Signature>;

/** A device's signing key pair. The secret key never leaves the device. */
export interface DeviceKey {
  publicKey: PublicKey;
  secretKey: string;
}

export function generateDeviceKey(): DeviceKey {
  const { publicKey, privateKey } = sodium.crypto_sign_keypair();
  return { publicKey: encode(publicKey), secretKey: encode(privateKey) };
}

/**
 * Derives a signing key pair deterministically from `secret`, so anyone who
 * knows the secret gets the same key. `context` keeps keys for different
 * purposes apart.
 */
export function keyFromSecret(context: string, secret: string): DeviceKey {
  const seed = sodium.crypto_generichash(32, `${context}\n${secret}`, null);
  const { publicKey, privateKey } = sodium.crypto_sign_seed_keypair(seed);
  return { publicKey: encode(publicKey), secretKey: encode(privateKey) };
}

export function sign(key: DeviceKey, message: string): Signature {
  return encode(sodium.crypto_sign_detached(message, decode(key.secretKey)));
}

/** True if `signature` is `publicKey`'s signature of `message`. Never throws. */
export function verify(
  publicKey: string,
  message: string,
  signature: string,
): boolean {
  try {
    return sodium.crypto_sign_verify_detached(
      decode(signature),
      message,
      decode(publicKey),
    );
  } catch {
    return false;
  }
}

/**
 * Encrypts `message` so that only the holder of device `recipient`'s secret
 * key can read it (a libsodium sealed box, using the X25519 form of the
 * device's Ed25519 key). The sender is anonymous at this layer; sign first.
 */
export function sealFor(recipient: PublicKey, message: string): string {
  return encode(
    sodium.crypto_box_seal(
      message,
      sodium.crypto_sign_ed25519_pk_to_curve25519(decode(recipient)),
    ),
  );
}

/** Opens a sealed box addressed to `device`, or returns undefined if it can't. Never throws. */
export function openSealed(
  device: DeviceKey,
  ciphertext: string,
): string | undefined {
  try {
    const publicKey = sodium.crypto_sign_ed25519_pk_to_curve25519(
      decode(device.publicKey),
    );
    const secretKey = sodium.crypto_sign_ed25519_sk_to_curve25519(
      decode(device.secretKey),
    );
    return sodium.to_string(
      sodium.crypto_box_seal_open(decode(ciphertext), publicKey, secretKey),
    );
  } catch {
    return undefined;
  }
}

/** A 256-bit BLAKE2b hash of `message`, base64url-encoded. */
export function hash(message: string): string {
  return encode(sodium.crypto_generichash(32, message, null));
}

/** A random token of `bytes` bytes, base64url-encoded. */
export function randomToken(bytes = 32): string {
  return encode(sodium.randombytes_buf(bytes));
}

/**
 * JSON with object keys sorted, so the same value always serialises to the
 * same string. Signatures and hashes are computed over this form.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}
