import { z } from "zod";
import {
  PublicKey,
  Signature,
  canonicalJson,
  openSealed,
  sealFor,
  sign,
  verify,
  type DeviceKey,
} from "./crypto.js";
import { AgentName } from "./names.js";

/**
 * End-to-end encrypted messages (ADR 0005).
 *
 * The sending device signs the message's payload, then seals a separate copy
 * of the signed payload for each of the recipient developer's devices. The
 * relay only ever handles the envelope: one opaque copy per device key.
 *
 * Opening a copy proves nothing about who sent it; the recipient must check
 * the signer against the team log (see the bridge).
 */

/** Version of the message envelope. Bumped when the format changes. */
export const ENVELOPE_VERSION = 1;

const SIGNING_CONTEXT = "blether-message-v1";

/** A message's content and addressing, as signed by the sender. */
export const MessagePayload = z.object({
  id: z.uuid(),
  team: z.string(),
  from: AgentName,
  to: AgentName,
  body: z.string().min(1),
  /** When the sender sent it, by the sender's clock. */
  sentAt: z.iso.datetime(),
});
export type MessagePayload = z.infer<typeof MessagePayload>;

const SignedPayload = z.object({
  payload: MessagePayload,
  /** The sending device's public key. */
  signer: PublicKey,
  signature: Signature,
});

/** What the relay stores and delivers: one sealed copy per recipient device. */
export const Envelope = z.object({
  v: z.literal(ENVELOPE_VERSION),
  copies: z.record(PublicKey, z.string().min(1)).refine((copies) => {
    const count = Object.keys(copies).length;
    return count >= 1 && count <= 32;
  }, "An envelope holds between 1 and 32 copies."),
});
export type Envelope = z.infer<typeof Envelope>;

function signingContent(payload: MessagePayload): string {
  return `${SIGNING_CONTEXT}\n${canonicalJson(payload)}`;
}

/** Signs `payload` with `sender` and seals a copy for each of `recipients`. */
export function sealMessage(
  payload: MessagePayload,
  sender: DeviceKey,
  recipients: readonly PublicKey[],
): Envelope {
  if (recipients.length === 0) {
    throw new Error("A message needs at least one recipient device.");
  }
  const signed = JSON.stringify({
    payload: MessagePayload.parse(payload),
    signer: sender.publicKey,
    signature: sign(sender, signingContent(payload)),
  });
  return {
    v: ENVELOPE_VERSION,
    copies: Object.fromEntries(
      [...new Set(recipients)].map((device) => [
        device,
        sealFor(device, signed),
      ]),
    ),
  };
}

export type OpenedMessage =
  | { ok: true; payload: MessagePayload; signer: PublicKey }
  | {
      ok: false;
      /**
       * `elsewhere`: no copy for this device (it was sealed for the
       * developer's other devices). `unreadable`: the copy didn't decrypt or
       * parse. `bad-signature`: it decrypted but the signature doesn't verify.
       */
      reason: "elsewhere" | "unreadable" | "bad-signature";
    };

/** Opens this device's copy of `envelope` and checks its signature. */
export function openMessage(
  envelope: Envelope,
  device: DeviceKey,
): OpenedMessage {
  const copy = envelope.copies[device.publicKey];
  if (!copy) return { ok: false, reason: "elsewhere" };
  const plaintext = openSealed(device, copy);
  if (plaintext === undefined) return { ok: false, reason: "unreadable" };

  let signed: z.infer<typeof SignedPayload>;
  try {
    signed = SignedPayload.parse(JSON.parse(plaintext));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (
    !verify(signed.signer, signingContent(signed.payload), signed.signature)
  ) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true, payload: signed.payload, signer: signed.signer };
}
