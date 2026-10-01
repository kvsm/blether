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

/** A machine's signing key pair. The secret key never leaves the machine. */
export interface MachineKey {
  publicKey: PublicKey;
  secretKey: string;
}

export function generateMachineKey(): MachineKey {
  const { publicKey, privateKey } = sodium.crypto_sign_keypair();
  return { publicKey: encode(publicKey), secretKey: encode(privateKey) };
}

export function sign(key: MachineKey, message: string): Signature {
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
