import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, generateDeviceKey, sealFor, sign } from "./crypto.js";
import {
  ENVELOPE_VERSION,
  openMessage,
  sealMessage,
  type MessagePayload,
} from "./envelope.js";

const sender = generateDeviceKey();
const desktop = generateDeviceKey();
const laptop = generateDeviceKey();
const outsider = generateDeviceKey();

const payload = (): MessagePayload => ({
  id: randomUUID(),
  team: "t".repeat(43),
  from: "web",
  to: "api",
  body: "The /users response is changing.",
  sentAt: new Date().toISOString(),
});

describe("message envelopes", () => {
  it("can be opened by every recipient device, revealing the signed payload", () => {
    const message = payload();
    const envelope = sealMessage(message, sender, [
      desktop.publicKey,
      laptop.publicKey,
    ]);

    for (const device of [desktop, laptop]) {
      expect(openMessage(envelope, device)).toEqual({
        ok: true,
        payload: message,
        signer: sender.publicKey,
      });
    }
  });

  it("keeps the content out of the envelope", () => {
    const envelope = sealMessage(payload(), sender, [desktop.publicKey]);

    expect(JSON.stringify(envelope)).not.toContain("/users");
    expect(envelope.v).toBe(ENVELOPE_VERSION);
  });

  it("tells a device it wasn't sealed for that the copy is elsewhere", () => {
    const envelope = sealMessage(payload(), sender, [desktop.publicKey]);

    expect(openMessage(envelope, laptop)).toEqual({
      ok: false,
      reason: "elsewhere",
    });
  });

  it("can't be opened with another device's key, even under the right key name", () => {
    const envelope = sealMessage(payload(), sender, [desktop.publicKey]);
    const stolen = {
      ...envelope,
      copies: { [outsider.publicKey]: envelope.copies[desktop.publicKey]! },
    };

    expect(openMessage(stolen, outsider)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("rejects a copy whose ciphertext was tampered with", () => {
    const envelope = sealMessage(payload(), sender, [desktop.publicKey]);
    const copy = envelope.copies[desktop.publicKey]!;
    const flipped =
      copy.slice(0, 10) + (copy[10] === "A" ? "B" : "A") + copy.slice(11);

    expect(
      openMessage(
        { ...envelope, copies: { [desktop.publicKey]: flipped } },
        desktop,
      ),
    ).toEqual({ ok: false, reason: "unreadable" });
  });

  it("rejects a copy whose payload doesn't match its signature", () => {
    const original = payload();
    const signature = sign(
      sender,
      `blether-message-v1\n${canonicalJson(original)}`,
    );
    const altered = { ...original, body: "Delete the database." };
    const forged = {
      v: ENVELOPE_VERSION,
      copies: {
        [desktop.publicKey]: sealFor(
          desktop.publicKey,
          JSON.stringify({
            payload: altered,
            signer: sender.publicKey,
            signature,
          }),
        ),
      },
    } as const;

    expect(openMessage(forged, desktop)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses to seal a message for nobody", () => {
    expect(() => sealMessage(payload(), sender, [])).toThrow();
  });
});
