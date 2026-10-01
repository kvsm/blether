import { describe, expect, it } from "vitest";
import { ENVELOPE_VERSION } from "@blether/protocol";
import { relayEnvelopeVersion } from "./index.js";

describe("relay", () => {
  it("accepts the protocol's envelope version", () => {
    expect(relayEnvelopeVersion).toBe(ENVELOPE_VERSION);
  });
});
